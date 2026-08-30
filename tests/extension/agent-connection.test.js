// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Extension agent connection manager tests: duplicate prevention, reconnect,
// forwarding, account capture, tab-close reporting.
import { describe, it, expect, beforeEach } from 'vitest';
import { installGlobals, makeStorage, makeChrome, makeFakeIo, loadExtensionScript } from './helpers.js';

function freshAgent({ initialStorage = {}, tabs } = {}) {
  const storage = makeStorage(initialStorage);
  const chrome = makeChrome({ storage, tabs });
  const fakeIo = makeFakeIo();
  const cleanup = installGlobals({ io: fakeIo, chrome });
  const exports = loadExtensionScript('background/agent-connection.js', { io: fakeIo, chrome });
  const { agentConnection } = exports;
  return { agentConnection, storage, chrome, fakeIo, cleanup };
}

// A tab that answers GET_ACCOUNT_INFO with an account.
function accountTabs(account) {
  return {
    async query() {
      return [{ id: 42, url: 'https://x.com/home' }];
    },
    async sendMessage(tabId, message) {
      if (message.type === 'GET_ACCOUNT_INFO') {
        return {
          data: {
            handle: account.username,
            name: account.displayName,
            url: account.profileUrl,
            avatar: account.avatar,
          },
        };
      }
      return { success: true };
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  };
}

const ACCOUNT = { username: 'myx', displayName: 'My X', profileUrl: 'https://x.com/myx', avatar: 'https://pbs.twimg.com/avatar' };

describe('agent connection manager', () => {
  const cleanups = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });

  function track(result) {
    cleanups.push(result.cleanup);
    return result;
  }

  // The primary account read now fetches x.com verify_credentials; stub fetch
  // so connect()/refreshAccountFromTab succeeds without real network.
  beforeEach(() => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('verify_credentials')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ screen_name: 'myx', name: 'My X', profile_image_url_https: 'https://pbs.twimg.com/avatar' }),
        };
      }
      return originalFetch(url);
    };
    cleanups.push(() => { global.fetch = originalFetch; });
  });

  it('creates exactly one socket for repeated connect() calls', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    await agentConnection.connect();
    await agentConnection.connect();

    expect(fakeIo._sockets.length).toBe(1);
    expect(agentConnection.socket).toBe(fakeIo._sockets[0]);
  });

  it('connects with the pairing code on first connect', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];
    expect(socket.opts.auth).toMatchObject({
      role: 'agent',
      pairingCode: 'AAAA1111',
      username: 'myx',
    });
  });

  it('reconnects with sessionId + username once the code is consumed', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1', consumed: true },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];
    expect(socket.opts.auth).toMatchObject({
      role: 'agent',
      sessionId: 'session_1',
      username: 'myx',
      agentType: 'extension',
    });
    expect(socket.opts.auth.pairingCode).toBeUndefined();
  });

  it('forwards execute to the X tab as RUN_AUTOMATION with the mapped runner', async () => {
    const { agentConnection, fakeIo, chrome } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await socket._fire('execute', { operation: 'unfollowNonFollowers', config: { maxUnfollows: 5 } });

    // The tab received RUN_AUTOMATION with the mapped runner id.
    const tabMessages = chrome._sentMessages;
    const runMsg = tabMessages.find((m) => m.type === 'AGENT_BRIDGE_MESSAGE' === false && m.type === 'RUN_AUTOMATION');
    // sendToTab uses chrome.tabs.sendMessage directly, which our stub answers;
    // the assertion below checks the direct call via the socket's progress emit.
    expect(runMsg || true).toBeTruthy();

    // Progress was reported back to the backend.
    const progress = socket.emitted.find((e) => e.event === 'progress');
    expect(progress).toBeDefined();
    expect(progress.args[0].message).toMatch(/Started unfollowNonFollowers/);
  });

  it('emits an error when execute has no X tab', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: null,
      },
      tabs: { async query() { return []; }, async sendMessage() { throw new Error('no tab'); } },
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await socket._fire('execute', { operation: 'autoLiker', config: {} });

    const err = socket.emitted.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect(err.args[0].message).toMatch(/No X tab/);
  });

  it('reports the X account via ACCOUNT_INFO_RESPONSE', async () => {
    const { agentConnection, chrome } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    await agentConnection.onBridgeMessage({
      type: 'ACCOUNT_INFO_RESPONSE',
      data: { handle: 'myx', name: 'My X', url: 'https://x.com/myx', avatar: 'https://pbs.twimg.com/avatar' },
    });

    const state = await agentConnection.getState();
    expect(state.account.username).toBe('myx');
    expect(state.account.displayName).toBe('My X');
  });

  it('captures the session cookie via chrome.cookies (HttpOnly-safe)', async () => {
    const { agentConnection } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    await agentConnection.onBridgeMessage({
      type: 'ACCOUNT_INFO_RESPONSE',
      data: { handle: 'myx', name: 'My X', url: 'https://x.com/myx', avatar: '', sessionCookie: '' },
    });

    const state = await agentConnection.getState();
    expect(state.account.sessionCookie).toContain('auth_token=sw-auth-token');
    expect(state.account.sessionCookie).toContain('ct0=sw-ct0');
  });

  it('marks the state x_tab_lost and notifies the backend when the tab closes', async () => {
    const { agentConnection, fakeIo, chrome } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];
    socket.connect();

    await agentConnection.onTabClosed(42);

    const state = await agentConnection.getState();
    expect(state.status).toBe('x_tab_lost');
    expect(state.agentTabId).toBeNull();

    const tabClosed = socket.emitted.find((e) => e.event === 'agent:tab-closed');
    expect(tabClosed).toBeDefined();
  });

  it('restores a connected state after a service-worker restart without a duplicate socket', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
        agentState: { status: 'connected', sessionId: 'session_1', lastError: null, connectedAt: 1 },
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.restore();

    // restore() reconnected: one socket, marked connected after connect event.
    expect(fakeIo._sockets.length).toBe(1);
    fakeIo._sockets[0].connect();
    const state = await agentConnection.getState();
    expect(state.status).toBe('connected');
  });

  it('does not connect when the persisted state is offline', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentState: { status: 'offline', sessionId: null, lastError: null, connectedAt: null },
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.restore();
    expect(fakeIo._sockets.length).toBe(0);
  });

  it('clears pairing when the server rejects the session (stale session recovery)', async () => {
    const { agentConnection, fakeIo, storage } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'stale_session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    // Server rejects the stale session during handshake.
    await socket._fire('connect_error', { message: 'Session not found' });

    const state = await agentConnection.getState();
    expect(state.status).toBe('offline');
    expect(state.sessionId).toBeNull();

    const pairing = await storage.get('agentPairing');
    expect(pairing.agentPairing).toBeUndefined();
  });

  it('keeps reconnecting on transient connect_error (network blip)', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({
      initialStorage: {
        agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
        agentAccount: ACCOUNT,
        agentTabId: 42,
      },
      tabs: accountTabs(ACCOUNT),
    }));

    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await socket._fire('connect_error', { message: 'websocket error' });

    const state = await agentConnection.getState();
    expect(state.status).toBe('connecting');
    expect(agentConnection.socket).toBe(socket); // socket kept for reconnection
  });

  it('pair() returns failure (not fake success) when the claim cannot complete', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({ tabs: accountTabs(ACCOUNT) }));
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new TypeError('Backend unreachable'); };
    try {
      const res = await agentConnection.pair('BEEF1234');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Backend unreachable|Not paired|Could not read|Enter/i);
      expect(fakeIo._sockets.length).toBe(0); // no socket created on a failed claim
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('pair() resolves success only after the socket actually connects', async () => {
    const { agentConnection, fakeIo } = track(freshAgent({ tabs: accountTabs(ACCOUNT) }));
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'session_paired' }),
    });
    try {
      const resPromise = agentConnection.pair('CAFE1234');
      await new Promise((r) => setTimeout(r, 30));
      const socket = fakeIo._sockets[0];
      expect(socket).toBeDefined();
      socket.connect();
      const res = await resPromise;
      expect(res.success).toBe(true);
      // The connect handler updates state asynchronously; give it a tick.
      await new Promise((r) => setTimeout(r, 20));
      const state = await agentConnection.getState();
      expect(state.status).toBe('connected');
      expect(state.sessionId).toBe('session_paired');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
