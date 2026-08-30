// XActions Extension — Agent Connection Manager
// Single Socket.IO client for the extension agent. Runs in the service worker,
// which is the privileged networking boundary: the x.com page never sees the
// socket or its credentials, only commands relayed through the content bridge.
//
// Classic-script module (loaded via importScripts from service-worker.js):
// registers itself on self.XActionsAgentConnection. The socket.io-client UMD
// bundle is loaded first, so `io` is a global here.
// by nichxbt

(function () {
  // Map of backend operation names (what the dashboard/server send in
  // `execute`) to injected.js automation runner ids.
  const OPERATION_MAP = {
    unfollowNonFollowers: 'smartUnfollow',
    unfollowEveryone: 'smartUnfollow',
    detectUnfollowers: 'unfollowerDetector',
  };

  const STORAGE_KEYS = {
    config: 'agentConfig',
    state: 'agentState',
    account: 'agentAccount',
    tab: 'agentTabId',
    pairing: 'agentPairing',
  };

  const DEFAULT_CONFIG = {
    backendUrl: 'https://xactions.azeez-tech.com',
  };

  const DEFAULT_STATE = {
    status: 'offline', // offline | connecting | connected | x_tab_lost
    sessionId: null,
    lastError: null,
    connectedAt: null,
  };

  /**
   * Read the x.com session cookies from the service worker via chrome.cookies.
   * Works even when x.com marks auth_token/ct0 HttpOnly (the page's
   * document.cookie cannot see HttpOnly cookies). Returns '' when unavailable.
   */
  async function readXCookies(tabUrl) {
    try {
      if (typeof chrome.cookies?.get !== 'function') {
        // The "cookies" permission is missing — the extension was reloaded
        // rather than re-added after a manifest change. Surface this clearly.
        throw new Error('missing cookies permission');
      }
      const url = tabUrl || 'https://x.com/';
      const authToken = await chrome.cookies.get({ url, name: 'auth_token' });
      const ct0 = await chrome.cookies.get({ url, name: 'ct0' });
      if (!authToken?.value) return '';
      return `auth_token=${authToken.value}` + (ct0?.value ? `; ct0=${ct0.value}` : '');
    } catch (err) {
      if (err?.message === 'missing cookies permission') throw err;
    }
    return '';
  }

  /**
   * Read config + pairing + state from chrome.storage.local in one shot.
   */
  async function loadPersisted() {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.config,
      STORAGE_KEYS.state,
      STORAGE_KEYS.account,
      STORAGE_KEYS.tab,
      STORAGE_KEYS.pairing,
    ]);
    return {
      config: { ...DEFAULT_CONFIG, ...(data[STORAGE_KEYS.config] || {}) },
      state: { ...DEFAULT_STATE, ...(data[STORAGE_KEYS.state] || {}) },
      account: data[STORAGE_KEYS.account] || null,
      agentTabId: data[STORAGE_KEYS.tab] || null,
      pairing: data[STORAGE_KEYS.pairing] || null,
    };
  }

  class AgentConnection {
    constructor() {
      this.socket = null;
      this.state = { ...DEFAULT_STATE };
      this.config = { ...DEFAULT_CONFIG };
      this.account = null;
      this.agentTabId = null;
      this.pairing = null;
      this.statusListeners = new Set();
      this.claimInFlight = false;
      this.initialized = false;
    }

    /** One-time async bootstrap; safe to call repeatedly. */
    async ensureInitialized() {
      if (this.initialized) return;
      const persisted = await loadPersisted();
      this.config = persisted.config;
      this.state = persisted.state;
      this.account = persisted.account;
      this.agentTabId = persisted.agentTabId;
      this.pairing = persisted.pairing;
      this.initialized = true;
    }
    onStatus(listener) {
      this.statusListeners.add(listener);
      return () => this.statusListeners.delete(listener);
    }

    async getState() {
      await this.ensureInitialized();
      return {
        ...this.state,
        account: this.account,
        agentTabId: this.agentTabId,
        backendUrl: this.config.backendUrl,
      };
    }

    /** Notify the popup (and anything else) of a state change. */
    async emitStatus(extra = {}) {
      const snapshot = { ...this.state, account: this.account, agentTabId: this.agentTabId, ...extra };
      await chrome.storage.local.set({ [STORAGE_KEYS.state]: { ...this.state } });
      for (const listener of this.statusListeners) listener(snapshot);
      try {
        await chrome.runtime.sendMessage({ type: 'AGENT_STATUS', state: snapshot }).catch(() => {});
      } catch { /* no receiver (popup closed) — fine */ }
    }

    async setState(patch) {
      this.state = { ...this.state, ...patch, updatedAt: Date.now() };
      await this.emitStatus();
    }

    /** Update the backend URL (from popup settings) and reconnect if needed. */
    async setBackendUrl(url) {
      await this.ensureInitialized();
      const next = String(url || '').trim().replace(/\/+$/, '');
      if (!next || next === this.config.backendUrl) return { success: false, error: 'No change' };
      const wasConnected = !!this.socket;
      if (wasConnected) await this.disconnect();
      this.config.backendUrl = next;
      await chrome.storage.local.set({ [STORAGE_KEYS.config]: this.config });
      if (wasConnected) await this.connect();
      return { success: true };
    }

    /**
     * Ensure the agent socket is connected. Call this after pairing or on
     * service-worker restart. Never creates a second socket while one is up.
     */
    async connect() {
      await this.ensureInitialized();

      if (this.socket && this.socket.connected) {
        return { success: true, already: true };
      }
      if (this.socket) {
        // Socket exists but is mid-reconnect: leave it alone.
        return { success: true, already: true };
      }
      if (this.claimInFlight) {
        // Another connect() is mid-claim; await its outcome instead of
        // returning success prematurely (pair() depends on a real socket).
        try {
          return await this.claimInFlight;
        } catch (err) {
          return { success: false, error: err?.message || 'Connection failed' };
        }
      }

      const runClaim = (async () => {
        const pairing = await this.ensurePairing();
        if (!pairing) {
          const reason = this.state.lastError || 'Not paired. Enter a pairing code in the popup.';
          await this.setState({ status: 'offline', lastError: reason });
          return { success: false, error: reason };
        }

        await this.setState({ status: 'connecting', lastError: null });

        // First connection uses the pairing code (claimed via HTTP, then
        // consumed by this socket). Reconnects use sessionId + username.
        const auth = pairing.pairingCode && !pairing.consumed
          ? {
              role: 'agent',
              pairingCode: pairing.pairingCode,
              username: pairing.username,
              displayName: pairing.displayName,
              profileUrl: pairing.profileUrl,
              avatar: pairing.avatar,
              sessionCookie: pairing.sessionCookie || '',
            }
          : {
              role: 'agent',
              sessionId: pairing.sessionId,
              username: pairing.username,
              agentType: 'extension',
              sessionCookie: pairing.sessionCookie || '',
            };

        const socket = io(this.config.backendUrl, {
          auth,
          // WebSocket-only: Cloudflare terminates socket.io's polling->upgrade
          // path; a direct WebSocket connection works through it.
          transports: ['websocket'],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          randomizationFactor: 0.5,
          timeout: 10000,
        });

        this.socket = socket;

        socket.on('connect', () => {
          // The pairing code is single-use; once this socket consumed it, the
          // extension reconnects with sessionId + username instead.
          if (pairing.pairingCode && !pairing.consumed) {
            pairing.consumed = true;
            chrome.storage.local.set({ [STORAGE_KEYS.pairing]: pairing });
          }
          this.state.connectedAt = Date.now();
          this.setState({ status: 'connected', lastError: null, sessionId: pairing.sessionId });
          // Re-bind the X tab so the backend knows which account this agent is.
          this.bindTab();
        });

        socket.on('disconnect', (reason) => {
          // A server-initiated disconnect means the session was closed on the
          // backend (dashboard refreshed, session cleaned up, agent replaced).
          // The saved sessionId is dead — clear it so the popup shows the
          // pairing panel again instead of holding a stale session forever.
          if (reason === 'io server disconnect') {
            this.pairing = null;
            chrome.storage.local.remove([STORAGE_KEYS.pairing]);
            this.setState({ status: 'offline', sessionId: null, lastError: 'Session closed. Enter a new pairing code.' });
            return;
          }
          // Transient network loss — keep the session so socket.io can resume.
          this.setState({
            status: this.agentTabId ? 'x_tab_lost' : 'offline',
            lastError: null,
          });
        });

        socket.on('connect_error', (err) => {
          const msg = err?.message || 'Connection failed';
          // A rejected handshake (bad/expired pairing code, unknown session,
          // wrong account) is permanent for this pairing — stop retrying and
          // let the user re-pair instead of hammering the server.
          const rejected = /pairing|session|account|invalid|expired|required|not found/i.test(msg);
          if (rejected) {
            this.pairing = null;
            chrome.storage.local.remove([STORAGE_KEYS.pairing]);
            this.setState({ status: 'offline', sessionId: null, lastError: msg });
            try {
              socket.removeAllListeners();
              socket.disconnect();
            } catch { /* already gone */ }
            this.socket = null;
          } else {
            // Transient network failure — keep the reconnection manager going.
            this.setState({ status: 'connecting', lastError: msg });
          }
        });

        // Server asked this agent to step aside (a newer registration replaced it).
        socket.on('agent:replaced', () => {
          this.setState({ status: 'offline', lastError: 'Replaced by a newer agent connection' });
          socket.disconnect();
        });

        // The dashboard session this agent was bound to ended (dashboard
        // refreshed or closed). Clear the pairing so the popup prompts for a
        // new code for the fresh dashboard session.
        socket.on('session:ended', () => {
          this.pairing = null;
          chrome.storage.local.remove([STORAGE_KEYS.pairing]);
          this.setState({ status: 'offline', sessionId: null, lastError: 'Dashboard session ended. Enter a new pairing code.' });
          try {
            socket.disconnect();
          } catch { /* already gone */ }
        });

        // Server rejected this connection (bad pairing code, stale session,
        // wrong account, session no longer active). Clear the pairing so the
        // user can re-pair, and stop reconnecting to a dead session.
        socket.on('error', (err) => {
          const msg = err?.message || 'Connection rejected';
          this.pairing = null;
          chrome.storage.local.remove([STORAGE_KEYS.pairing]);
          this.setState({ status: 'offline', sessionId: null, lastError: msg });
          try {
            socket.removeAllListeners();
            socket.disconnect();
          } catch { /* already gone */ }
          this.socket = null;
        });

        socket.on('execute', (data) => {
          return this.handleExecute(socket, data).catch((err) => {
            socket.emit('error', { message: err?.message || 'Automation failed' });
          });
        });

        socket.on('stop', () => {
          this.sendToTab({ type: 'STOP_ALL' });
        });

        socket.on('pause', () => {
          this.sendToTab({ type: 'PAUSE_ALL' });
        });

        socket.on('resume', () => {
          this.sendToTab({ type: 'RESUME_ALL' });
        });

        return { success: true };
      })();

      this.claimInFlight = runClaim;
      try {
        return await runClaim;
      } finally {
        this.claimInFlight = null;
      }
    }

    /**
     * Make sure we have a claimed session (pairing code + sessionId + account).
     * If a pairing code is stored but unclaimed, claim it via the backend HTTP
     * endpoint and keep the resulting sessionId.
     */
    async ensurePairing() {
      if (this.pairing && this.pairing.sessionId && this.pairing.pairingCode) {
        // Refresh the account each connect in case the tab switched.
        await this.refreshAccountFromTab();
        if (this.account) {
          this.pairing = { ...this.pairing, ...this.account };
          await chrome.storage.local.set({ [STORAGE_KEYS.pairing]: this.pairing });
        }
        return this.pairing;
      }

      if (!this.pairing || !this.pairing.pairingCode) {
        return null;
      }

      // First claim: POST /api/pairing/claim with the code + account.
      await this.refreshAccountFromTab();
      if (!this.account?.username) return null;

      let res;
      try {
        res = await fetch(`${this.config.backendUrl}/api/pairing/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairingCode: this.pairing.pairingCode,
            username: this.account.username,
            displayName: this.account.displayName,
            profileUrl: this.account.profileUrl,
            avatar: this.account.avatar,
            sessionCookie: this.account.sessionCookie || '',
          }),
        });
      } catch (err) {
        await this.setState({ lastError: `Backend unreachable: ${err.message}` });
        return null;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        await this.setState({ lastError: body.error || `Claim failed (HTTP ${res.status})` });
        return null;
      }

      const data = await res.json();
      this.pairing = {
        ...this.pairing,
        sessionId: data.sessionId,
        ...this.account,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.pairing]: this.pairing });
      return this.pairing;
    }

    /** Store a pairing code entered in the popup and try to connect. */
    async pair(code) {
      await this.ensureInitialized();
      const pairingCode = String(code || '').trim().toUpperCase();
      if (!pairingCode) return { success: false, error: 'Enter a pairing code' };

      this.pairing = { pairingCode };
      await chrome.storage.local.set({ [STORAGE_KEYS.pairing]: this.pairing });

      // Wait for a real outcome — either the socket connects (with its
      // sessionId) or the attempt fails. Returning early with success just
      // makes the popup hide the panel while nothing is connected.
      const outcome = await this.connect();
      if (!outcome.success) return outcome;

      const socket = this.socket;
      if (!socket) return { success: false, error: 'Connection not established' };

      if (socket.connected && this.state.status === 'connected') {
        return { success: true };
      }

      // Socket exists but hasn't finished handshaking yet — wait briefly for
      // the connect event (or a rejection) so the popup reflects reality.
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          this.setState({ status: 'offline', lastError: 'Timed out connecting to the backend' });
          resolve({ success: false, error: 'Timed out connecting to the backend' });
        }, 12000);
        const onConnect = () => { cleanup(); resolve({ success: true }); };
        const onError = (err) => {
          cleanup();
          this.setState({ status: 'offline', lastError: err?.message || 'Connection rejected' });
          resolve({ success: false, error: err?.message || 'Connection rejected' });
        };
        const cleanup = () => {
          clearTimeout(timeout);
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
          socket.off('error', onError);
        };
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
        socket.once('error', onError);
      });
    }

    /**
     * Read the current X account. Primary: have the injected page script call
     * x.com's verify_credentials (same-origin fetch — cookies attach
     * automatically and the page CSP allows it). Fallback: DOM scrape via the
     * bridge, then the persisted account.
     */
    async refreshAccountFromTab() {
      await this.ensureInitialized();
      const tab = await this.pickXTab();
      if (!tab) {
        await this.setState({ status: 'x_tab_lost', lastError: 'Open x.com and sign in.' });
        return null;
      }

      this.agentTabId = tab.id;
      await chrome.storage.local.set({ [STORAGE_KEYS.tab]: tab.id });

      const sessionCookie = await readXCookies(tab.url);

      // 1) Authoritative identity: verify_credentials from the page (same-origin).
      try {
        await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            files: ['content/injected.js'],
          }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch { /* already injected or scripting unavailable */ }

      const viaCredentials = await this.readAccountViaCredentials(tab.id);
      if (viaCredentials?.username) {
        this.account = { ...viaCredentials, sessionCookie };
        await chrome.storage.local.set({ [STORAGE_KEYS.account]: this.account });
        return this.account;
      }

      // 2) Fall back to the DOM scrape through the bridge.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'GET_ACCOUNT_INFO' }),
            new Promise((resolve) => setTimeout(() => resolve({ data: null, timeout: true }), 2500)),
          ]);
          if (response?.data?.handle) {
            const pageCookie = response.data.sessionCookie || '';
            this.account = {
              username: response.data.handle || '',
              displayName: response.data.name || '',
              profileUrl: response.data.url || '',
              avatar: response.data.avatar || '',
              sessionCookie: sessionCookie || pageCookie,
            };
            await chrome.storage.local.set({ [STORAGE_KEYS.account]: this.account });
            return this.account;
          }
        } catch { /* content script not ready yet */ }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      // 3) The tab is there but never answered. Fall back to a persisted
      //    account so a warm reconnect still works, but never invent one.
      if (this.account?.username) {
        return this.account;
      }
      await this.setState({ lastError: 'Could not read the X account from the tab. Make sure you are signed in on x.com.' });
      return null;
    }

    /**
     * Ask the injected page script to fetch verify_credentials (same-origin,
     * cookies auto-attached) and return the resolved account via the bridge.
     */
    async readAccountViaCredentials(tabId) {
      try {
        const result = await new Promise((resolve) => {
          const onResult = (message) => {
            if (message.type !== 'X_ACCOUNT_RESULT') return;
            chrome.runtime.onMessage.removeListener(onResult);
            clearTimeout(timer);
            resolve(message);
          };
          chrome.runtime.onMessage.addListener(onResult);
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(onResult);
            resolve(null);
          }, 5000);
          chrome.tabs.sendMessage(tabId, { type: 'FETCH_X_ACCOUNT' }).catch(() => {});
        });
        if (result?.ok && result?.data?.username) {
          return result.data;
        }
      } catch { /* timeout or no listener */ }
      return null;
    }

    /** Bind this agent to the current X tab: capture account + notify backend. */
    async bindTab() {
      await this.ensureInitialized();
      const binding = (async () => {
        const account = await this.refreshAccountFromTab();
        if (!account?.username) {
          this.setState({ status: 'x_tab_lost', lastError: 'Open x.com and sign in.' });
          return;
        }
        // Tell the backend which tab/account this agent is operating on.
        this.socket?.emit('agent:bind', { account });
      })();
      // Track the in-flight binding so onTabClosed can wait for it instead of
      // racing it (a stale refresh must not resurrect a cleared tab id).
      this._binding = binding;
      try {
        await binding;
      } finally {
        if (this._binding === binding) this._binding = null;
      }
    }

    async pickXTab() {
      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      // Prefer the previously registered tab, else the first x.com tab.
      if (this.agentTabId) {
        const prev = tabs.find((t) => t.id === this.agentTabId);
        if (prev) return prev;
      }
      return tabs[0] || null;
    }

    async sendToTab(message) {
      const tab = await this.pickXTab();
      if (!tab) {
        await this.setState({ status: 'x_tab_lost', lastError: 'No x.com tab available' });
        return { error: 'No x.com tab available' };
      }
      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (err) {
        return { error: err.message };
      }
    }

    /**
     * Backend `execute` -> bridge RUN_AUTOMATION. The operation name maps to an
     * injected.js runner id; unknown names fall through to the raw name so
     * future runners work without a map entry.
     */
    async handleExecute(socket, data) {
      const { operation, config } = data || {};
      if (!operation) {
        socket.emit('error', { message: 'execute without an operation' });
        return;
      }

      const automationId = OPERATION_MAP[operation] || operation;
      const response = await this.sendToTab({
        type: 'RUN_AUTOMATION',
        automationId,
        settings: config || {},
      });

      if (response?.error) {
        socket.emit('error', { message: `No X tab to run ${operation}: ${response.error}` });
        return;
      }

      // Progress/action/complete/error come back from the tab via the bridge
      // (ACTION_PERFORMED / AUTOMATION_COMPLETE / AUTOMATION_ERROR) and are
      // forwarded to the backend in onBridgeMessage.
      socket.emit('progress', { status: 'starting', message: `Started ${operation}` });
    }

    /** Called by the service worker for every bridge message. */
    async onBridgeMessage(message) {
      switch (message.type) {
        case 'ACTION_PERFORMED': {
          const data = message.action
            ? (typeof message.action === 'string'
                ? { type: 'log', message: message.action, automationId: message.automationId }
                : { ...message.action, automationId: message.automationId })
            : { type: 'log', automationId: message.automationId };
          this.socket?.emit('action', data);
          break;
        }
        case 'AUTOMATION_COMPLETE': {
          this.socket?.emit('complete', {
            operation: message.automationId,
            summary: message.summary || 'done',
            stopped: !!message.stopped,
          });
          break;
        }
        case 'AUTOMATION_ERROR': {
          this.socket?.emit('error', { message: message.error || 'Automation failed', automationId: message.automationId });
          break;
        }
        case 'ACCOUNT_INFO_RESPONSE': {
          // Only adopt the page-scraped account when it carries a real handle.
          // A stale/empty scrape (the DOM read failing) must never clobber a
          // good account already resolved via verify_credentials.
          if (message.data?.handle) {
            const pageCookie = message.data.sessionCookie || '';
            // Prefer the service-worker cookie read (works even when HttpOnly).
            const swCookie = await readXCookies();
            this.account = {
              username: message.data.handle || '',
              displayName: message.data.name || '',
              profileUrl: message.data.url || '',
              avatar: message.data.avatar || '',
              sessionCookie: swCookie || pageCookie,
            };
            await chrome.storage.local.set({ [STORAGE_KEYS.account]: this.account });
          }
          break;
        }
        default:
          break;
      }
    }

    /** Explicit disconnect (popup Disconnect button / settings change). */
    async disconnect() {
      await this.ensureInitialized();
      if (this.socket) {
        try {
          this.socket.removeAllListeners();
          this.socket.disconnect();
        } catch { /* already closed */ }
        this.socket = null;
      }
      this.pairing = null;
      this.agentTabId = null;
      await chrome.storage.local.remove([
        STORAGE_KEYS.pairing,
        STORAGE_KEYS.tab,
        STORAGE_KEYS.state,
      ]);
      await this.setState({ status: 'offline', sessionId: null, lastError: null });
      return { success: true };
    }

    /**
     * Called when the registered X tab closes. Reports to the backend so the
     * dashboard can show the agent as disconnected even though the service
     * worker socket stays up.
     */
    async onTabClosed(tabId) {
      await this.ensureInitialized();
      if (tabId !== this.agentTabId) return;
      // Wait for any in-flight bind so it cannot re-register the closed tab.
      if (this._binding) {
        try { await this._binding; } catch { /* ignore */ }
      }
      if (tabId !== this.agentTabId) return; // bind already moved us elsewhere
      this.agentTabId = null;
      await chrome.storage.local.set({ [STORAGE_KEYS.tab]: null });
      this.socket?.emit('agent:tab-closed');
      await this.setState({ status: 'x_tab_lost', lastError: 'X tab closed. Reopen x.com to reconnect.' });
    }

    /**
     * Service-worker restart: restore persisted state. If we were connected to
     * a live X tab, reconnect the socket and re-bind. If the tab is gone, mark
     * x_tab_lost. Never creates a duplicate socket.
     */
    async restore() {
      await this.ensureInitialized();
      if (this.state.status === 'connected' || this.state.status === 'connecting') {
        await this.connect();
      }
      return this.getState();
    }
  }

  // Single shared instance for the whole service worker.
  const agentConnection = new AgentConnection();

  self.XActionsAgentConnection = {
    agentConnection,
    AgentConnection,
    OPERATION_MAP,
    DEFAULT_CONFIG,
    STORAGE_KEYS,
  };
})();
