// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Test helpers for the extension service-worker modules.
//
// The extension files are classic MV3 scripts (IIFEs registering on globals),
// so tests evaluate their source with stubbed `chrome` / `io` globals rather
// than importing them as ESM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension');

export function extPath(rel) {
  return path.join(EXT_DIR, rel);
}

/**
 * In-memory chrome.storage.local.
 */
export function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) out[key] = store.get(key);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) store.delete(key);
    },
  };
}

/**
 * Minimal chrome.* stub sufficient for the service worker and the
 * connection manager. Tracks listeners so tests can fire them.
 */
export function makeChrome({ storage, tabs } = {}) {
  const listeners = { onRemoved: [], onInstalled: [], onAlarm: [], onMessage: [] };
  const sentMessages = [];
  const badge = { text: '', color: '' };
  const menus = [];
  const alarms = [];

  const runtime = {
    async sendMessage(message) {
      sentMessages.push(message);
      return {};
    },
    onMessage: {
      addListener(fn) { listeners.onMessage.push(fn); },
    },
    onInstalled: {
      addListener(fn) { listeners.onInstalled.push(fn); },
    },
  };

  return {
    _listeners: listeners,
    _sentMessages: sentMessages,
    _badge: badge,
    _menus: menus,
    _alarms: alarms,
    storage: {
      local: storage || makeStorage(),
    },
    tabs: tabs || {
      async query() { return []; },
      async sendMessage() { return { data: null }; },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime,
    cookies: {
      async get({ name }) {
        if (name === 'auth_token') return { value: 'sw-auth-token' };
        if (name === 'ct0') return { value: 'sw-ct0' };
        return null;
      },
    },
    scripting: {
      executeScript: async () => [{ result: true }],
    },
    action: {
      setBadgeBackgroundColor({ color }) { badge.color = color; },
      setBadgeText({ text }) { badge.text = text; },
    },
    contextMenus: {
      removeAll(cb) { menus.length = 0; cb?.(); },
      create(opts) { menus.push(opts); },
      onClicked: { addListener() {} },
    },
    alarms: {
      create(name, opts) { alarms.push({ name, opts }); },
      onAlarm: { addListener(fn) { listeners.onAlarm.push(fn); } },
    },
    notifications: {
      create() {},
    },
    webRequest: {
      onCompleted: { addListener() {} },
    },
    tabsOnRemoved(listener) {
      listeners.onRemoved.push(listener);
    },
  };
}

/**
 * Install extension globals (io, chrome, importScripts) on globalThis and
 * return a cleanup function that restores the previous state. The globals
 * must stay installed while async code (the connection manager) runs, so
 * cleanup is the caller's job (afterEach).
 */
export function installGlobals({ io, chrome } = {}) {
  const prev = {
    io: globalThis.io,
    chrome: globalThis.chrome,
    self: globalThis.self,
    importScripts: globalThis.importScripts,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    navigator: globalThis.navigator,
  };

  if (io !== undefined) globalThis.io = io;
  if (chrome !== undefined) globalThis.chrome = chrome;
  globalThis.self = globalThis;
  if (globalThis.addEventListener === undefined) globalThis.addEventListener = () => {};
  if (globalThis.removeEventListener === undefined) globalThis.removeEventListener = () => {};
  if (globalThis.navigator === undefined) globalThis.navigator = { userAgent: 'node' };
  globalThis.importScripts = (...paths) => {
    for (const p of paths) {
      // The vendored socket.io-client bundle registers the global `io`, which
      // tests replace with the fake. Skipping it avoids loading 46 KB of UMD
      // browser glue (addEventListener, navigator checks, etc.) in Node.
      if (p.includes('socket.io-client')) continue;
      loadExtensionScript(p.replace(/^\.\//, 'background/'), { io, chrome });
    }
  };

  return () => {
    if (prev.io === undefined) delete globalThis.io; else globalThis.io = prev.io;
    if (prev.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = prev.chrome;
    if (prev.self === undefined) delete globalThis.self; else globalThis.self = prev.self;
    if (prev.importScripts === undefined) delete globalThis.importScripts; else globalThis.importScripts = prev.importScripts;
    if (prev.addEventListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = prev.addEventListener;
    if (prev.removeEventListener === undefined) delete globalThis.removeEventListener; else globalThis.removeEventListener = prev.removeEventListener;
    // navigator exists as a getter-only global in Node; do not try to restore it.
    try { if (prev.navigator === undefined) delete globalThis.navigator; } catch { /* getter-only */ }
  };
}

/**
 * Evaluate an extension classic script with the given globals installed on
 * `globalThis`. Returns the captured `self`-registered exports when the
 * script registers them (e.g. `self.XActionsAgentConnection`).
 */
export function loadExtensionScript(relPath, { io, chrome } = {}) {
  const code = readFileSync(extPath(relPath), 'utf8');
  const cleanup = installGlobals({ io, chrome });

  try {
    // A previous load may have left the module's singleton on globalThis
    // (self.XActionsAgentConnection). Drop it so each load is fresh.
    if (relPath.includes('agent-connection') || relPath.includes('service-worker')) {
      delete globalThis.XActionsAgentConnection;
    }
    (0, eval)(code);
  } finally {
    cleanup();
  }

  return globalThis.XActionsAgentConnection || null;
}

/**
 * Fake socket.io-client socket with connect/disconnect/emit/on bookkeeping.
 */
export function makeFakeIo() {
  const sockets = [];
  const fakeIo = (url, opts) => {
    const handlers = {};
    const socket = {
      url,
      opts,
      connected: false,
      emitted: [],
      _handlers: handlers,
      on(event, fn) { (handlers[event] ||= []).push(fn); },
      once(event, fn) { (handlers[event] ||= []).push(fn); },
      off(event, fn) {
        if (handlers[event]) handlers[event] = handlers[event].filter((h) => h !== fn);
      },
      removeAllListeners() { Object.keys(handlers).forEach((k) => delete handlers[k]); },
      emit(event, ...args) { socket.emitted.push({ event, args }); },
      connect() {
        socket.connected = true;
        (handlers.connect || []).slice().forEach((fn) => fn());
      },
      disconnect(reason) {
        socket.connected = false;
        (handlers.disconnect || []).slice().forEach((fn) => fn(reason || 'io client disconnect'));
      },
      _fire(event, ...args) {
        const results = (handlers[event] || []).map((fn) => fn(...args));
        return Promise.all(results).then(() => undefined);
      },
    };
    sockets.push(socket);
    return socket;
  };
  fakeIo._sockets = sockets;
  return fakeIo;
}
