// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// Realtime session tests: dashboard pairing flow, extension-agent claim,
// execute/stop, and progress/action/complete/error forwarding.
//
// Boots the real app through createApp() (no port binding) with a stubbed
// Prisma client so the socket auth middleware resolves the test user without
// a database. No network beyond loopback socket.io.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { io as ioc } from 'socket.io-client';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'realtime-test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'realtime-test-session-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:password@127.0.0.1:1/xactions?schema=public';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.API_URL = 'http://localhost:3001';
delete process.env.X402_PAY_TO_ADDRESS;

const TEST_USER = { id: 'user_test_1', username: 'tester', email: 'tester@x.test', isAdmin: false, twitterUsername: null };

vi.mock('@prisma/client', () => {
  const operationCreate = vi.fn(async (args) => ({ id: 'op_test', ...(args?.data || {}) }));
  return {
    PrismaClient: class {
      user = {
        findUnique: vi.fn(async ({ where }) => (where?.id === TEST_USER.id ? TEST_USER : null)),
      };
      operation = {
        create: operationCreate,
      };
    },
  };
});

// Import AFTER the mock is registered.
const { createApp } = await import('../../../api/server.js');

let app;
let httpServer;
let io;

function connectDashboard(token) {
  return ioc('http://localhost:' + httpServer.address().port, {
    transports: ['websocket'],
    auth: { token, role: 'dashboard' },
    forceNew: true,
    reconnection: false,
  });
}

function connectAgent(auth) {
  return ioc('http://localhost:' + httpServer.address().port, {
    transports: ['websocket'],
    auth,
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

describe('realtime sessions (extension agent)', () => {
  beforeAll(async () => {
    ({ app, httpServer, io } = createApp({ rateLimiting: false }));
    await new Promise((resolve) => httpServer.listen(0, resolve));
  });

  beforeEach(async () => {
    // Session reuse is per-user; isolate tests by clearing the in-memory maps.
    const { activeSessions, pendingSessions } = await import('../../../api/realtime/socketHandler.js');
    activeSessions.clear();
    pendingSessions.clear();
  });

  afterAll(async () => {
    if (io) await new Promise((resolve) => io.close(resolve));
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  it('creates a session with a pairing code for a dashboard', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');
    expect(created.sessionId).toMatch(/^session_/);
    expect(created.pairingCode).toMatch(/^[A-F0-9]{8}$/);
    // The legacy console-paste agentScript is gone.
    expect(created.agentScript).toBeUndefined();
    dash.close();
  });

  it('rejects an agent with a bad pairing code', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: 'BADC0DE1',
      username: 'someone',
    });
    const err = await once(agent, 'error');
    expect(err.message).toMatch(/pairing/i);

    agent.close();
    dash.close();
  });

  it('connects an extension agent with a valid pairing code', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'myxaccount',
      displayName: 'My X Account',
    });

    // Register the ack listener BEFORE the connection completes so the
    // server's immediate `connected` emit is not missed.
    const ackP = once(agent, 'connected');

    const connected = await once(dash, 'agent:connected');
    expect(connected.sessionId).toBe(created.sessionId);
    expect(connected.account.username).toBe('myxaccount');

    const ack = await ackP;
    expect(ack.sessionId).toBe(created.sessionId);

    agent.close();
    dash.close();
  });

  it('reports agent disconnect to the dashboard', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'myxaccount',
    });
    await once(dash, 'agent:connected');

    agent.close();
    await once(dash, 'agent:disconnected');

    dash.close();
  });

  it('forwards execute to the agent and acks the dashboard', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'myxaccount',
    });
    await once(dash, 'agent:connected');

    const executeP = once(agent, 'execute');
    dash.emit('start:operation', { operation: 'unfollowNonFollowers', config: { maxUnfollows: 5 } });

    const execute = await executeP;
    expect(execute.operation).toBe('unfollowNonFollowers');
    expect(execute.config.maxUnfollows).toBe(5);

    const started = await once(dash, 'operation:started');
    expect(started.operation).toBe('unfollowNonFollowers');

    agent.close();
    dash.close();
  });

  it('forwards stop to the agent', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'myxaccount',
    });
    await once(dash, 'agent:connected');

    const stopP = once(agent, 'stop');
    dash.emit('stop:operation');
    await stopP;

    agent.close();
    dash.close();
  });

  it('forwards progress, action, complete and error from agent to dashboard', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'myxaccount',
    });
    await once(dash, 'agent:connected');

    const progressP = once(dash, 'progress');
    agent.emit('progress', { status: 'running', current: 1, max: 5, percent: 20, message: 'Working' });
    expect((await progressP).message).toBe('Working');

    const actionP = once(dash, 'action');
    agent.emit('action', { type: 'unfollow', handle: 'someone', count: 1 });
    expect((await actionP).handle).toBe('someone');

    const completeP = once(dash, 'complete');
    agent.emit('complete', { operation: 'unfollowNonFollowers', unfollowed: 1, stopped: false });
    expect((await completeP).operation).toBe('unfollowNonFollowers');

    const errorP = once(dash, 'error');
    agent.emit('error', { message: 'Something broke' });
    expect((await errorP).message).toBe('Something broke');

    agent.close();
    dash.close();
  });

  it('rejects start:operation with agentDisconnected when no agent is bound', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    await once(dash, 'session:created');

    const errorP = once(dash, 'error');
    dash.emit('start:operation', { operation: 'unfollowNonFollowers', config: {} });
    const err = await errorP;
    expect(err.agentDisconnected).toBe(true);
    expect(err.message).toMatch(/extension/i);

    dash.close();
  });

  it('replaces a stale agent when a new one claims the same session', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    // First agent claims with the pairing code (consuming it).
    const agent1 = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'first',
    });
    await once(dash, 'agent:connected');

    // Listen for the replacement BEFORE the second agent connects.
    const replacedP = once(agent1, 'agent:replaced');

    // Second agent: reconnects with sessionId + the same username (the
    // realistic case — the same extension restarting).
    const agent2 = connectAgent({
      role: 'agent',
      sessionId: created.sessionId,
      username: 'first',
      agentType: 'extension',
    });

    // The first agent is told to step aside.
    await replacedP;

    // The dashboard now routes commands to the second agent.
    const executeP = once(agent2, 'execute');
    dash.emit('start:operation', { operation: 'detectUnfollowers', config: {} });
    expect((await executeP).operation).toBe('detectUnfollowers');

    agent1.close();
    agent2.close();
    dash.close();
  });

  it('still accepts the legacy sessionId-only agent flow', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent = connectAgent({
      role: 'agent',
      sessionId: created.sessionId,
    });
    const connected = await once(dash, 'agent:connected');
    expect(connected.sessionId).toBe(created.sessionId);

    agent.close();
    dash.close();
  });

  it('reuses the user session when the dashboard reconnects (refresh-safe pairing)', async () => {
    const dash1 = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created1 = await once(dash1, 'session:created');

    // Agent pairs to the first dashboard session.
    const agent = connectAgent({
      role: 'agent',
      pairingCode: created1.pairingCode,
      username: 'refreshuser',
    });
    await once(dash1, 'agent:connected');

    // Dashboard refreshes: a new socket for the same user connects.
    const dash2 = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created2 = await once(dash2, 'session:created');

    // Same sessionId is reused — no new session, so no re-pair needed.
    expect(created2.sessionId).toBe(created1.sessionId);

    // The agent is still bound to the reused session.
    const executeP = once(agent, 'execute');
    dash2.emit('start:operation', { operation: 'detectUnfollowers', config: {} });
    expect((await executeP).operation).toBe('detectUnfollowers');

    agent.close();
    dash2.close();
    dash1.close();
  });

  it('reconnects an extension agent with sessionId + username after claiming', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    // First connect: pairing code.
    const agent1 = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'reconnectuser',
    });
    await once(dash, 'agent:connected');
    agent1.close();
    await once(dash, 'agent:disconnected');

    // Reconnect: sessionId + username + agentType, no pairing code.
    const agent2 = connectAgent({
      role: 'agent',
      sessionId: created.sessionId,
      username: 'reconnectuser',
      agentType: 'extension',
    });
    const connected = await once(dash, 'agent:connected');
    expect(connected.sessionId).toBe(created.sessionId);
    expect(connected.account.username).toBe('reconnectuser');

    agent2.close();
    dash.close();
  });

  it('refuses an extension reconnect with the wrong X account', async () => {
    const dash = connectDashboard(jwt.sign({ userId: TEST_USER.id }, process.env.JWT_SECRET));
    const created = await once(dash, 'session:created');

    const agent1 = connectAgent({
      role: 'agent',
      pairingCode: created.pairingCode,
      username: 'rightuser',
    });
    await once(dash, 'agent:connected');
    agent1.close();
    await once(dash, 'agent:disconnected');

    const impostor = connectAgent({
      role: 'agent',
      sessionId: created.sessionId,
      username: 'wronguser',
      agentType: 'extension',
    });
    const err = await once(impostor, 'error');
    expect(err.message).toMatch(/account/i);

    impostor.close();
    dash.close();
  });
});
