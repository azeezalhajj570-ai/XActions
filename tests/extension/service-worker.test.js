// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Service worker tests: agent message dispatch plus regression that the
// existing automation commands still fan out to X tabs.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installGlobals, makeStorage, makeChrome, makeFakeIo, loadExtensionScript } from './helpers.js';

const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

// connect() now reads the X account via verify_credentials; stub fetch so the
// connection manager resolves the account without real network.
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

/**
 * Load the full service worker (vendored socket.io client + connection
 * manager + worker) against a chrome stub that captures the onMessage
 * handler, and return everything the tests need.
 */
function loadServiceWorker({ initialStorage = {}, tabs } = {}) {
  const storage = makeStorage(initialStorage);
  const chrome = makeChrome({ storage, tabs });
  const fakeIo = makeFakeIo();

  cleanups.push(installGlobals({ io: fakeIo, chrome }));

  // Give the tabs stub access to chrome so it can emit bridge->SW messages.
  if (tabs) tabs._chrome = chrome;

  // Load ONLY the service worker: its importScripts() loads the connection
  // manager (and would load the vendored client, which tests replace with the
  // fake io). The worker shares the single instance via self.XActionsAgentConnection.
  loadExtensionScript('background/service-worker.js', { io: fakeIo, chrome });
  const agentConnection = globalThis.XActionsAgentConnection?.agentConnection;

  const handleMessage = (message, sender) => {
    const handler = chrome._listeners.onMessage[0];
    // The real listener uses the sendResponse callback contract; wrap it.
    return new Promise((resolve) => {
      const result = handler(message, sender || {}, resolve);
      if (result === undefined) {
        // Listener did not keep the channel open; resolve with whatever it
        // returned synchronously.
        resolve(result);
      }
    });
  };

  return { chrome, storage, fakeIo, agentConnection, handleMessage };
}

function makeTabsStub() {
  const sentToTabs = [];
  return {
    sentToTabs,
    async query() { return [{ id: 42, url: 'https://x.com/home' }]; },
    async sendMessage(tabId, message) {
      sentToTabs.push({ tabId, message });
      if (message.type === 'GET_ACCOUNT_INFO') {
        return { data: { handle: 'myx', name: 'My X', url: 'https://x.com/myx', avatar: '' } };
      }
      if (message.type === 'FETCH_X_ACCOUNT') {
        const listeners = this._chrome?._listeners?.onMessage || [];
        for (const fn of listeners.slice()) {
          fn({ type: 'X_ACCOUNT_RESULT', ok: true, data: { username: 'myx', displayName: 'My X', profileUrl: 'https://x.com/myx', avatar: '' } }, {}, () => {});
        }
      }
      return { success: true };
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  };
}

const CONNECTED_STORAGE = {
  agentPairing: { pairingCode: 'AAAA1111', sessionId: 'session_1' },
  agentAccount: { username: 'myx', displayName: 'My X' },
  agentTabId: 42,
  agentState: { status: 'connected', sessionId: 'session_1', lastError: null, connectedAt: 1 },
};

describe('service worker', () => {
  it('AGENT_STATUS returns the connection snapshot', async () => {
    const { handleMessage } = loadServiceWorker({
      initialStorage: CONNECTED_STORAGE,
      tabs: makeTabsStub(),
    });

    const res = await handleMessage({ type: 'AGENT_STATUS' });
    expect(res.status).toBe('connected');
    expect(res.sessionId).toBe('session_1');
    expect(res.account.username).toBe('myx');
  });

  it('AGENT_PAIR stores the code, claims the session, and returns success', async () => {
    const { handleMessage, storage, fakeIo } = loadServiceWorker({ tabs: makeTabsStub() });

    // Stub the HTTP pairing claim so the extension gets a sessionId.
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'session_paired' }),
    });

    try {
      const resPromise = handleMessage({ type: 'AGENT_PAIR', pairingCode: 'BEEF1234' });
      // The claim + socket handshake is async; wait a tick so the socket exists,
      // then fire its connect event so pair() resolves success.
      await new Promise((r) => setTimeout(r, 50));
      const socket = fakeIo._sockets[0];
      expect(socket).toBeDefined();
      socket.connect();

      const res = await resPromise;
      expect(res.success).toBe(true);
      const saved = await storage.get('agentPairing');
      expect(saved.agentPairing.pairingCode).toBe('BEEF1234');
      expect(saved.agentPairing.sessionId).toBe('session_paired');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('AGENT_BRIDGE_MESSAGE forwards ACTION_PERFORMED to the backend socket', async () => {
    const tabs = makeTabsStub();
    const { handleMessage, fakeIo, agentConnection } = loadServiceWorker({ initialStorage: CONNECTED_STORAGE, tabs });

    // Drive the connection manager into a live socket.
    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await handleMessage({
      type: 'AGENT_BRIDGE_MESSAGE',
      message: { type: 'ACTION_PERFORMED', automationId: 'autoLiker', action: 'Liked tweet 123' },
    });

    const action = socket.emitted.find((e) => e.event === 'action');
    expect(action).toBeDefined();
    expect(action.args[0]).toMatchObject({ type: 'log', automationId: 'autoLiker' });
  });

  it('AGENT_BRIDGE_MESSAGE forwards AUTOMATION_COMPLETE to the backend socket', async () => {
    const tabs = makeTabsStub();
    const { handleMessage, fakeIo, agentConnection } = loadServiceWorker({ initialStorage: CONNECTED_STORAGE, tabs });
    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await handleMessage({
      type: 'AGENT_BRIDGE_MESSAGE',
      message: { type: 'AUTOMATION_COMPLETE', automationId: 'smartUnfollow', summary: '5 unfollowed' },
    });

    const complete = socket.emitted.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    expect(complete.args[0]).toMatchObject({ operation: 'smartUnfollow', summary: '5 unfollowed' });
  });

  it('AGENT_BRIDGE_MESSAGE forwards AUTOMATION_ERROR to the backend socket', async () => {
    const tabs = makeTabsStub();
    const { handleMessage, fakeIo, agentConnection } = loadServiceWorker({ initialStorage: CONNECTED_STORAGE, tabs });
    await agentConnection.connect();
    const socket = fakeIo._sockets[0];

    await handleMessage({
      type: 'AGENT_BRIDGE_MESSAGE',
      message: { type: 'AUTOMATION_ERROR', automationId: 'autoLiker', error: 'Rate limited' },
    });

    const err = socket.emitted.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect(err.args[0].message).toBe('Rate limited');
  });

  it('START_AUTOMATION still fans out to all X tabs', async () => {
    const tabs = makeTabsStub();
    const { handleMessage } = loadServiceWorker({ tabs });

    const res = await handleMessage({ type: 'START_AUTOMATION', automationId: 'autoLiker', settings: { maxActions: 5 } });
    expect(res.success).toBe(true);

    const runMsg = tabs.sentToTabs.find((t) => t.message.type === 'RUN_AUTOMATION');
    expect(runMsg.message.automationId).toBe('autoLiker');
    expect(runMsg.message.settings.maxActions).toBe(5);
  });

  it('STOP_ALL still fans out to all X tabs', async () => {
    const tabs = makeTabsStub();
    const { handleMessage } = loadServiceWorker({ tabs });

    const res = await handleMessage({ type: 'STOP_ALL' });
    expect(res.success).toBe(true);
    expect(tabs.sentToTabs.some((t) => t.message.type === 'STOP_ALL')).toBe(true);
  });

  it('GLOBAL_PAUSE still fans out to all X tabs', async () => {
    const tabs = makeTabsStub();
    const { handleMessage } = loadServiceWorker({ tabs });

    const res = await handleMessage({ type: 'GLOBAL_PAUSE' });
    expect(res.success).toBe(true);
    expect(tabs.sentToTabs.some((t) => t.message.type === 'PAUSE_ALL')).toBe(true);
  });

  it('AGENT_DISCONNECT clears the pairing and state', async () => {
    const { handleMessage, storage } = loadServiceWorker({ initialStorage: CONNECTED_STORAGE, tabs: makeTabsStub() });

    const res = await handleMessage({ type: 'AGENT_DISCONNECT' });
    expect(res.success).toBe(true);

    const pairing = await storage.get('agentPairing');
    expect(pairing.agentPairing).toBeUndefined();
  });

  it('INJECT_PAGE_SCRIPT runs injected.js in the MAIN world via chrome.scripting', async () => {
    const { chrome, handleMessage } = loadServiceWorker({ tabs: makeTabsStub() });
    const executeSpy = vi.fn(async () => [{ result: true }]);
    chrome.scripting.executeScript = executeSpy;

    const res = await handleMessage({ type: 'INJECT_PAGE_SCRIPT' }, { tab: { id: 42 } });
    expect(res.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith({
      target: { tabId: 42 },
      world: 'MAIN',
      files: ['content/injected.js'],
    });
  });
});
