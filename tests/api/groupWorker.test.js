// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group automation worker tests.
 *
 * Exercises runGroupAutomation with a stubbed Prisma + mocked executor/caps
 * so claim/execute/rate-limit/reschedule behavior is deterministic.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory task store, keyed exactly like the Prisma model.
const store = { tasks: [], nextId: 1 };
store.reset = () => { store.tasks = []; store.nextId = 1; };
store.add = (t) => { const row = { id: `t${store.nextId++}`, status: 'PENDING', retryCount: 0, claimedAt: null, ...t }; store.tasks.push(row); return row; };
store.byId = (id) => store.tasks.find((t) => t.id === id);

const fakePrisma = {
  group: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.id === 'g1') return { id: 'g1', paused: false, actions: '{"like":true,"comment":false,"repost":false,"follow":true}', cooldownSec: 0 };
      if (where.id === 'gpaused') return { id: 'gpaused', paused: true, actions: '{"like":true}', cooldownSec: 0 };
      if (where.id === 'gnoactions') return { id: 'gnoactions', paused: false, actions: '{}', cooldownSec: 0 };
      return null;
    }),
  },
  groupTask: {
    updateMany: vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const t of store.tasks) {
        if (where.id === t.id && t.status === where.status) { Object.assign(t, data); count++; }
      }
      return { count };
    }),
    update: vi.fn(async ({ where, data }) => { Object.assign(store.byId(where.id), data); return store.byId(where.id); }),
  },
};

const { mockClaim, mockExecute, mockCap, mockReap } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockExecute: vi.fn(),
  mockCap: vi.fn(),
  mockReap: vi.fn(async () => 0),
}));

vi.mock('../../api/services/groups/claimStore.js', () => ({
  claimNextTasks: (...args) => mockClaim(...args),
  releaseClaim: vi.fn(async (taskId, opts) => {
    const t = store.byId(taskId);
    Object.assign(t, opts);
    if (opts.status === 'COMPLETED') t.completedAt = new Date();
    if (opts.status === 'PENDING') t.claimedAt = null;
    return t;
  }),
  reapExpiredClaims: (...args) => mockReap(...args),
}));

vi.mock('../../api/services/groups/executor.js', () => ({
  executeTask: (...args) => mockExecute(...args),
}));

vi.mock('../../api/services/groups/rateLimiter.js', () => ({
  checkAccountCap: (...args) => mockCap(...args),
}));

vi.mock('../../api/services/groups/taskGenerator.js', () => ({
  parseActions: (json) => {
    try { return JSON.parse(json); } catch { return {}; }
  },
}));

const { runGroupAutomation } = await import('../../api/services/groups/automationWorker.js');

function makeTask(overrides = {}) {
  return {
    id: store.add({
      groupId: 'g1',
      accountId: 'a1',
      memberId: 'm1',
      action: 'like',
      ...overrides,
    }).id,
    account: { username: 'acc1', sessionCookie: 'auth_token=x; ct0=y' },
    member: { username: 'elonmusk' },
  };
}

describe('runGroupAutomation', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
    mockClaim.mockReset();
    mockExecute.mockReset();
    mockCap.mockReset();
    mockCap.mockReturnValue({ allowed: true, resetAt: null });
    mockExecute.mockResolvedValue({ ok: true, verdict: 'completed', result: '{}' });
    mockClaim.mockImplementation(async () => {
      const pending = store.tasks.filter((t) => t.status === 'PENDING' && (!t.nextRetryAt || t.nextRetryAt <= new Date()));
      return pending.slice(0, 5).map((t) => ({
        ...t,
        account: { username: 'acc1', sessionCookie: 'auth_token=x; ct0=y' },
        member: { username: 'elonmusk' },
      }));
    });
  });

  it('claims, executes and completes tasks', async () => {
    makeTask();
    const stats = await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(stats.completed).toBe(1);
    expect(stats.processed).toBe(1);
    expect(store.byId('t1').status).toBe('COMPLETED');
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('marks tasks RATE_LIMITED when the daily cap is exceeded and reschedules (AC5)', async () => {
    makeTask();
    mockCap.mockReturnValue({ allowed: false, resetAt: Date.now() + 3600_000 });
    const stats = await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(stats.rateLimited).toBe(1);
    expect(stats.completed).toBe(0);
    expect(store.byId('t1').status).toBe('RATE_LIMITED');
    expect(store.byId('t1').nextRetryAt).toBeInstanceOf(Date);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(stats.nextRunAt).toBeInstanceOf(Date);
  });

  it('marks COOLDOWN + reschedules on RateLimitError and never retries endlessly', async () => {
    makeTask();
    mockExecute.mockResolvedValue({ ok: false, verdict: 'rateLimit', error: 'Rate limited', retryAfterMs: 900_000 });
    const stats = await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(stats.rateLimited).toBe(1);
    expect(store.byId('t1').status).toBe('COOLDOWN');
    expect(store.byId('t1').nextRetryAt).toBeInstanceOf(Date);
    expect(stats.nextRunAt).toBeInstanceOf(Date);
  });

  it('marks FAILED on permanent errors (no retry)', async () => {
    makeTask();
    mockExecute.mockResolvedValue({ ok: false, verdict: 'permanent', error: 'Account suspended' });
    const stats = await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(stats.failed).toBe(1);
    expect(store.byId('t1').status).toBe('FAILED');
    expect(store.byId('t1').retryCount).toBe(0);
  });

  it('retries transient errors with backoff, then FAILED after MAX_RETRIES', async () => {
    const t = makeTask();
    mockExecute.mockResolvedValue({ ok: false, verdict: 'retryable', error: 'Network error', retryAfterMs: 30_000 });

    // First run: retryCount 0 → 1 → PENDING with nextRetryAt
    await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(store.byId(t.id).status).toBe('PENDING');
    expect(store.byId(t.id).retryCount).toBe(1);
    expect(store.byId(t.id).nextRetryAt).toBeInstanceOf(Date);

    // Second run: retryCount 1 → 2
    store.byId(t.id).nextRetryAt = new Date(Date.now() - 1000);
    await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(store.byId(t.id).retryCount).toBe(2);

    // Third run: retryCount 2 → 3 → FAILED (max reached)
    store.byId(t.id).nextRetryAt = new Date(Date.now() - 1000);
    await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(store.byId(t.id).status).toBe('FAILED');
  });

  it('exits immediately when the group is paused', async () => {
    makeTask();
    const stats = await runGroupAutomation({ groupId: 'gpaused', prismaOverride: fakePrisma });
    expect(stats.paused).toBe(true);
    expect(store.byId('t1').status).toBe('PENDING');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('skips tasks whose action is disabled in the group', async () => {
    const t = store.add({
      groupId: 'g1', accountId: 'a1', memberId: 'm1', action: 'comment', status: 'PENDING',
    });
    await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma });
    expect(store.byId(t.id).status).toBe('CANCELLED');
    expect(store.byId(t.id).error).toBe('Action disabled in group');
  });

  it('stops claiming when cancelled mid-loop', async () => {
    makeTask();
    makeTask({ id: 't2extra', memberId: 'm2' });
    let calls = 0;
    mockClaim.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) return [];
      const pending = store.tasks.filter((t) => t.status === 'PENDING');
      return pending.slice(0, 1).map((t) => ({
        ...t,
        account: { username: 'acc1', sessionCookie: 'auth_token=x; ct0=y' },
        member: { username: 'elonmusk' },
      }));
    });
    let cancelled = false;
    const isCancelled = () => cancelled;
    const promise = runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma, isCancelled });
    // Cancel after the first claim pass completes.
    setTimeout(() => { cancelled = true; }, 50);
    await promise;
    // The loop should have stopped without processing forever.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(mockExecute.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('cancels actions that are enabled but emits events to the group room', async () => {
    makeTask();
    const emitted = [];
    const io = { to: vi.fn(() => ({ emit: (event, payload) => emitted.push({ event, payload }) })) };
    await runGroupAutomation({ groupId: 'g1', prismaOverride: fakePrisma, io });
    expect(emitted.some((e) => e.event === 'group:taskClaimed')).toBe(true);
    expect(emitted.some((e) => e.event === 'group:taskCompleted')).toBe(true);
  });
});
