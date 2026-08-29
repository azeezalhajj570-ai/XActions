// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Pairing route tests: the extension claims a dashboard session via HTTP.
// The pairing code itself is the credential — no JWT is involved.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { io as ioc } from 'socket.io-client';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pairing-test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'pairing-test-session-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:password@127.0.0.1:1/xactions?schema=public';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.API_URL = 'http://localhost:3001';
delete process.env.X402_PAY_TO_ADDRESS;

const TEST_USER = { id: 'user_pair_1', username: 'pairer', email: 'pair@x.test', isAdmin: false, twitterUsername: null };

vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class {
      user = {
        findUnique: vi.fn(async ({ where }) => (where?.id === TEST_USER.id ? TEST_USER : null)),
        update: vi.fn(async (args) => ({ ...TEST_USER, ...(args?.data || {}) })),
      };
      operation = { create: vi.fn(async () => ({})) };
    },
  };
});

const { createApp } = await import('../../api/server.js');

let app;
let httpServer;
let io;

function dashboardSocket() {
  return ioc('http://localhost:' + httpServer.address().port, {
    transports: ['websocket'],
    auth: { token: jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET), role: 'dashboard' },
    forceNew: true,
    reconnection: false,
  });
}

function once(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

describe('POST /api/pairing/claim', () => {
  beforeAll(async () => {
    ({ app, httpServer, io } = createApp({ rateLimiting: false }));
    await new Promise((resolve) => httpServer.listen(0, resolve));
  });

  afterAll(async () => {
    if (io) await new Promise((resolve) => io.close(resolve));
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  function claim(body) {
    return request(app)
      .post('/api/pairing/claim')
      .send(body);
  }

  it('GET /api/pairing/info reports enabled and a backend URL', async () => {
    const res = await request(app).get('/api/pairing/info');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.backendUrl).toBe('http://localhost:3001');
  });

  it('requires a pairing code', async () => {
    const res = await claim({ username: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pairingCode/i);
  });

  it('rejects an unknown pairing code', async () => {
    const res = await claim({ pairingCode: 'ZZZZ9999', username: 'someone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid|expired/i);
  });

  it('claims a live session created by the dashboard', async () => {
    const dash = dashboardSocket();
    const created = await once(dash, 'session:created');

    const res = await claim({ pairingCode: created.pairingCode, username: '@myaccount', displayName: 'My Account' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessionId).toBe(created.sessionId);

    dash.close();
  });

  it('refuses a second HTTP claim of the same code', async () => {
    const dash = dashboardSocket();
    const created = await once(dash, 'session:created');

    const first = await claim({ pairingCode: created.pairingCode, username: 'a' });
    expect(first.status).toBe(200);

    const second = await claim({ pairingCode: created.pairingCode, username: 'a' });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already used/i);

    dash.close();
  });

  it('lets the agent socket consume a code after the HTTP claim', async () => {
    const dash = dashboardSocket();
    const created = await once(dash, 'session:created');

    // HTTP claim first (the extension's normal flow).
    const claimRes = await claim({ pairingCode: created.pairingCode, username: 'sockuser' });
    expect(claimRes.status).toBe(200);

    // Then the agent socket connects with the same code.
    const agent = ioc('http://localhost:' + httpServer.address().port, {
      transports: ['websocket'],
      auth: { role: 'agent', pairingCode: created.pairingCode, username: 'sockuser' },
      forceNew: true,
      reconnection: false,
    });
    const connected = await once(dash, 'agent:connected');
    expect(connected.account.username).toBe('sockuser');

    // The code is now consumed: no further HTTP claim, and a second agent
    // socket cannot claim it either.
    const again = await claim({ pairingCode: created.pairingCode, username: 'other' });
    expect(again.status).toBe(400);

    agent.close();
    dash.close();
  });
});
