// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM API route + sync service tests.
 *
 * Follows the groups.test.js pattern: stub @prisma/client with an in-memory
 * fake, boot the real app, exercise routes with supertest.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.SESSION_SECRET = 'test-session';
process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/x?schema=public';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.API_URL = 'http://localhost:3001';
delete process.env.X402_PAY_TO_ADDRESS;

import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const db = {
  users: [],
  accounts: [],
  groups: [],
  groupMembers: [],
  xGroupMembers: [],
  operations: [],
  _seq: 1,
};
db._next = () => `id${db._seq++}`;
db._reset = () => {
  db.users = [];
  db.accounts = [];
  db.groups = [];
  db.groupMembers = [];
  db.xGroupMembers = [];
  db.operations = [];
  db._seq = 1;
};

function findOne(model, where) {
  const list = db[model];
  return list.find((r) => Object.entries(where).every(([k, v]) => {
    if (k === 'conversationId_xUserId') return r.conversationId === v.conversationId && r.xUserId === v.xUserId;
    return r[k] === v;
  }));
}

function whereMatch(r, where) {
  if (!where) return true;
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause) => whereMatch(r, clause));
  }
  if (Array.isArray(where.AND)) {
    return where.AND.every((clause) => whereMatch(r, clause));
  }
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR' || k === 'AND') return true;
    if (Array.isArray(v)) return v.includes(r[k]);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (v.in) return v.in.includes(r[k]);
      if (v.contains) return String(r[k] || '').toLowerCase().includes(String(v.contains).toLowerCase());
      return true;
    }
    return r[k] === v;
  });
}

const fakePrisma = {
  user: {
    findUnique: vi.fn(async ({ where }) => findOne('users', where)),
  },
  account: {
    findUnique: vi.fn(async ({ where }) => findOne('accounts', where)),
    findMany: vi.fn(async ({ where = {} }) => db.accounts.filter((r) => whereMatch(r, where))),
  },
  group: {
    findUnique: vi.fn(async ({ where }) => findOne('groups', where)),
  },
  xGroupMember: {
    findUnique: vi.fn(async ({ where }) => findOne('xGroupMembers', where)),
    create: vi.fn(async ({ data }) => {
      const r = { id: db._next(), createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), lastSeenAt: new Date(), isCurrentMember: true, isAdmin: false, ...data };
      db.xGroupMembers.push(r);
      return r;
    }),
    update: vi.fn(async ({ where, data }) => {
      const r = findOne('xGroupMembers', where);
      if (!r) throw new Error('not found');
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    }),
    findMany: vi.fn(async ({ where = {}, orderBy, take, skip }) => {
      let rows = db.xGroupMembers.filter((r) => whereMatch(r, where));
      if (orderBy?.username === 'asc') rows = [...rows].sort((a, b) => (a.username || '').localeCompare(b.username || ''));
      if (take) rows = rows.slice(skip || 0, (skip || 0) + take);
      return rows;
    }),
    count: vi.fn(async ({ where = {} }) => db.xGroupMembers.filter((r) => whereMatch(r, where)).length),
  },
  groupMember: {
    createMany: vi.fn(async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const d of data) {
        const exists = db.groupMembers.some((r) => r.groupId === d.groupId && r.username === d.username);
        if (exists && skipDuplicates) continue;
        db.groupMembers.push({ id: db._next(), createdAt: new Date(), active: true, ...d });
        count++;
      }
      return { count };
    }),
  },
  operation: {
    create: vi.fn(async ({ data }) => { const r = { id: db._next(), ...data }; db.operations.push(r); return r; }),
    findFirst: vi.fn(async ({ where }) => {
      // Support { config: { contains: v } } string-substring filters.
      const list = db.operations.filter((r) => {
        if (where.type && r.type !== where.type) return false;
        if (where.userId && r.userId !== where.userId) return false;
        if (where.config) {
          if (where.config.contains) {
            if (!String(r.config || '').includes(where.config.contains)) return false;
          }
        }
        return true;
      });
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
    }),
  },
};

vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor() { return fakePrisma; } } }));

vi.mock('../../api/services/jobQueue.js', () => ({
  addJob: vi.fn(async (type, data) => ({ jobId: `job-${type}-${data.conversationId}`, bullJobId: '1', operation: {} })),
  queueJob: vi.fn(async () => ({ id: 'x' })),
  getJob: vi.fn(async () => null),
  getJobStatus: vi.fn(async () => null),
  getHistory: vi.fn(async () => []),
  cancelJob: vi.fn(async () => {}),
  isJobCancelled: vi.fn(() => false),
  operationsQueue: { add: vi.fn(), process: vi.fn() },
}));

// The sync service imports the extractor + lock + taskGenerator; stub the
// extractor and lock so the route tests stay hermetic.
vi.mock('../../api/services/xGroups/lock.js', () => ({
  acquireSyncLock: vi.fn(async () => 'token'),
  releaseSyncLock: vi.fn(async () => {}),
  closeSyncLock: vi.fn(async () => {}),
}));

const capMocks = vi.hoisted(() => ({
  remaining: vi.fn(() => ({ classes: { dm: { remaining: 500, resetAt: null } } })),
  checkAndRecord: vi.fn(),
}));

vi.mock('../../src/mcp/action-caps.js', () => ({
  remaining: (...args) => capMocks.remaining(...args),
  checkAndRecord: (...args) => capMocks.checkAndRecord(...args),
  ACTION_CLASSES: ['post', 'reply', 'like', 'repost', 'follow', 'unfollow', 'dm', 'block', 'mute', 'delete'],
  DEFAULT_CAPS: { dm: 500 },
}));

const { createApp } = await import('../../api/server.js');
const { runXGroupMemberSync } = await import('../../api/services/xGroups/sync.js');

describe('X Group DM API', () => {
  let app;
  let httpServer;
  let userToken;

  const TEST_USER = { id: 'u1', username: 'alice', email: 'alice@x.com', isAdmin: false };

  beforeAll(async () => {
    db.users.push(TEST_USER);
    userToken = jwt.sign({ userId: TEST_USER.id, username: TEST_USER.username }, process.env.JWT_SECRET);
    ({ app, httpServer } = createApp({ rateLimiting: false }));
    await new Promise((resolve) => httpServer.listen(0, resolve));
  });

  afterAll(async () => {
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  beforeEach(() => {
    db._reset();
    db.users.push(TEST_USER);
    db.accounts.push({ id: 'a1', userId: 'u1', username: 'acc1', sessionCookie: 'auth_token=x; ct0=y', isActive: true, isBlocked: false });
    db.groups.push({ id: 'g1', userId: 'u1', name: 'G1', actions: '{"like":true}', paused: false });
  });

  function auth() {
    return { Authorization: `Bearer ${userToken}` };
  }

  it('parse: valid URL returns conversationId', async () => {
    const res = await request(app)
      .post('/api/x/groups/parse')
      .set(auth())
      .send({ url: 'https://x.com/i/chat/g2090169325890269541' });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('g2090169325890269541');
  });

  it('parse: invalid URL returns INVALID_GROUP_URL', async () => {
    const res = await request(app)
      .post('/api/x/groups/parse')
      .set(auth())
      .send({ url: 'https://x.com/home' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_GROUP_URL');
  });

  it('parse: requires auth', async () => {
    const res = await request(app).post('/api/x/groups/parse').send({ url: 'https://x.com/i/chat/g1' });
    expect(res.status).toBe(401);
  });

  it('sync: enqueues an xGroupMemberSync job', async () => {
    const { addJob } = await import('../../api/services/jobQueue.js');
    addJob.mockClear();
    const res = await request(app)
      .post('/api/x/groups/g2090169325890269541/members/sync')
      .set(auth())
      .send({ accountId: 'a1', groupId: 'g1' });
    expect(res.status).toBe(202);
    expect(res.body.taskId).toMatch(/^job-xGroupMemberSync-/);
    expect(addJob).toHaveBeenCalledWith('xGroupMemberSync', expect.objectContaining({
      accountId: 'a1',
      conversationId: 'g2090169325890269541',
      groupId: 'g1',
    }), expect.anything());
  });

  it('sync: rejects an account owned by someone else', async () => {
    const res = await request(app)
      .post('/api/x/groups/g2090169325890269541/members/sync')
      .set(auth())
      .send({ accountId: 'other-account', groupId: 'g1' });
    expect(res.status).toBe(404);
  });

  it('members: lists stored members with search', async () => {
    db.xGroupMembers.push(
      { id: 'x1', conversationId: 'g2090169325890269541', xUserId: '10', username: 'john', displayName: 'John', isCurrentMember: true },
      { id: 'x2', conversationId: 'g2090169325890269541', xUserId: '20', username: 'jane', displayName: 'Jane', isCurrentMember: true },
    );
    const res = await request(app)
      .get('/api/x/groups/g2090169325890269541/members?search=jan')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.members[0].username).toBe('jane');
  });

  it('sync-status: idle when no operation exists', async () => {
    const res = await request(app)
      .get('/api/x/groups/g2090169325890269541/sync-status')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IDLE');
  });

  it('sync-status: reads the latest operation', async () => {
    db.operations.push({
      id: 'op1',
      userId: 'u1',
      type: 'xGroupMemberSync',
      status: 'queued',
      config: JSON.stringify({ conversationId: 'g2090169325890269541' }),
      progress: { processed: 12, total: 50, pages: 2 },
      createdAt: new Date(),
    });
    const res = await request(app)
      .get('/api/x/groups/g2090169325890269541/sync-status')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.processed).toBe(12);
  });
});

describe('runXGroupMemberSync (service)', () => {
  beforeEach(() => {
    db._reset();
    db.accounts.push({ id: 'a1', userId: 'u1', username: 'acc1', sessionCookie: 'auth_token=x; ct0=y', isActive: true, isBlocked: false });
    db.groups.push({ id: 'g1', userId: 'u1', name: 'G1', actions: '{"like":true}', paused: false });
    capMocks.remaining.mockReturnValue({ classes: { dm: { remaining: 500, resetAt: null } } });
  });

  it('upserts new members, updates existing, flags removed (AC6 + AC7 + AC13)', async () => {
    // Pre-existing member that will drop out of the conversation.
    db.xGroupMembers.push({
      id: 'old1', conversationId: 'g1', xUserId: '99', username: 'gone', displayName: 'Gone',
      isCurrentMember: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const result = await runXGroupMemberSync({
      accountId: 'a1',
      conversationId: 'g1',
      groupId: 'g1',
      prisma: fakePrisma,
      extractor: async () => ({
        members: [
          { xUserId: '1', username: 'newguy', displayName: 'New Guy' },
          { xUserId: '99', username: 'gone', displayName: 'Gone Now' },
        ],
        pages: 1,
        source: 'conversation',
      }),
      generateTasks: async () => {},
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.totalMembers).toBe(2);
    expect(result.newMembers).toBe(1);
    expect(result.updatedMembers).toBe(1);
    expect(result.removedMembers).toBe(0);

    const byId = (uid) => db.xGroupMembers.find((m) => m.xUserId === uid);
    expect(byId('1').username).toBe('newguy');
    expect(byId('99').isCurrentMember).toBe(true);
    expect(byId('99').displayName).toBe('Gone Now');
    expect(db.groupMembers.some((m) => m.username === 'newguy' && m.groupId === 'g1')).toBe(true);
  });

  it('marks a missing prior member as removed', async () => {
    db.xGroupMembers.push({
      id: 'old1', conversationId: 'g1', xUserId: '99', username: 'gone', displayName: 'Gone',
      isCurrentMember: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const result = await runXGroupMemberSync({
      accountId: 'a1',
      conversationId: 'g1',
      groupId: 'g1',
      prisma: fakePrisma,
      extractor: async () => ({
        members: [{ xUserId: '1', username: 'newguy', displayName: 'New Guy' }],
        pages: 1,
        source: 'conversation',
      }),
      generateTasks: async () => {},
    });
    expect(result.removedMembers).toBe(1);
    expect(db.xGroupMembers.find((m) => m.xUserId === '99').isCurrentMember).toBe(false);
  });

  it('returns RATE_LIMITED when the DM cap is exhausted (AC8)', async () => {
    capMocks.remaining.mockReturnValue({
      classes: { dm: { remaining: 0, resetAt: new Date(Date.now() + 3600_000).toISOString() } },
    });
    const result = await runXGroupMemberSync({
      accountId: 'a1',
      conversationId: 'g1',
      groupId: 'g1',
      prisma: fakePrisma,
    });
    expect(result.status).toBe('RATE_LIMITED');
    expect(result.nextRunAt).toBeInstanceOf(Date);
  });
});
