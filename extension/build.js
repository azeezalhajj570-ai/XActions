// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Build script for the XActions browser extension.
//
// The extension's service worker needs the Socket.IO client, but the worker
// cannot load https://cdn.socket.io (no runtime CDN, and x.com's CSP must not
// matter). This script vendors the UMD bundle from node_modules into the
// extension so `importScripts('./vendor/socket.io-client.js')` works offline,
// and copies it into dashboard/vendor for the dashboard pages.
//
// Run with: npm run build:extension

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js');

if (!existsSync(src)) {
  console.error('❌ socket.io-client is not installed. Run `npm install` first.');
  process.exit(1);
}

const targets = [
  join(root, 'extension', 'background', 'vendor', 'socket.io-client.js'),
  join(root, 'dashboard', 'vendor', 'socket.io.min.js'),
];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(src, target);
  console.log(`✅ Vendored socket.io-client -> ${target.replace(root + '/', '')}`);
}

console.log('⚡ Extension build complete. Load extension/ unpacked in Chrome/Edge.');
