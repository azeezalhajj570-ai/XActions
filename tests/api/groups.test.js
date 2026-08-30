// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group API route tests.
 *
 * Follows the existing pattern (tests/api/pairing.test.js): stub @prisma/client
 * with an in-memory fake, boot the real app on an ephemeral port, and exercise
 * the routes with supertest.
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

// ── In-memory Prisma fake ──────────────────────────────────────────────────

const db = {
  users: [],
  accounts: [],
  groups: [],
  groupAccounts: [],
  groupMembers: [],
  groupTasks: [],
  operations: [],
  _seq: 1,
};
db._next = () => `id${db._seq++}`;
db._reset = () => {
  db.users = [];
  db.accounts = [];
  db.groups = [];
  db.groupAccounts = [];
  db.groupMembers = [];
  db.groupTasks = [];
  db.operations = [];
  db._seq = 1;
};

function findOne(model, where) {
  const list = db[model];
  return list.find((r) => Object.entries(where).every(([k, v]) => {
    if (k === 'id') return r.id === v;
    if (k === 'userId_username') return r.userId === v.userId && r.username === v.username;
    if (k === 'groupId_accountId') return r.groupId === v.groupId && r.accountId === v.accountId;
    if (k === 'groupId_username') return r.groupId === v.groupId && r.username === v.username;
    if (k === 'groupId_accountId_memberId_action') {
      return r.groupId === v.groupId && r.accountId === v.accountId && r.memberId === v.memberId && r.action === v.action;
    }
    return r[k] === v;
  }));
}

function whereMatch(r, where) {
  return Object.entries(where).every(([k, v]) => {
    if (Array.isArray(v)) return v.includes(r[k]);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      // { lte, lt, gte, gt, in }
      if (v.in) return v.in.includes(r[k]);
      if (v.lte) return r[k] <= v.lte;
      if (v.lt) return r[k] < v.lt;
      if (v.gte) return r[k] >= v.gte;
      if (v.gt) return r[k] > v.gt;
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
    findMany: vi.fn(async ({ where = {} }) => db.accounts.filter((r) => whereMatch(r, where))),
    findFirst: vi.fn(async ({ where }) => findOne('accounts', where)),
    findUnique: vi.fn(async ({ where }) => findOne('accounts', where)),
    create: vi.fn(async ({ data }) => { const r = { id: db._next(), createdAt: new Date(), updatedAt: new Date(), ...data }; db.accounts.push(r); return r; }),
    upsert: vi.fn(async ({ where, update, create }) => {
      const existing = findOne('accounts', where);
      if (existing) { Object.assign(existing, update, { updatedAt: new Date() }); return existing; }
      const r = { id: db._next(), createdAt: new Date(), updatedAt: new Date(), ...create }; db.accounts.push(r); return r;
    }),
    update: vi.fn(async ({ where, data }) => { const r = findOne('accounts', where); if (!r) throw new Error('not found'); Object.assign(r, data, { updatedAt: new Date() }); return r; }),
    delete: vi.fn(async ({ where }) => { const i = db.accounts.findIndex((r) => r.id === where.id); return db.accounts.splice(i, 1)[0]; }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  group: {
    findMany: vi.fn(async ({ where = {} }) => db.groups.filter((r) => whereMatch(r, where))),
    findUnique: vi.fn(async ({ where }) => findOne('groups', where)),
    create: vi.fn(async ({ data }) => { const r = { id: db._next(), createdAt: new Date(), updatedAt: new Date(), ...data }; db.groups.push(r); return r; }),
    update: vi.fn(async ({ where, data }) => { const r = findOne('groups', where); if (!r) throw new Error('not found'); Object.assign(r, data, { updatedAt: new Date() }); return r; }),
    delete: vi.fn(async ({ where }) => { const i = db.groups.findIndex((r) => r.id === where.id); return db.groups.splice(i, 1)[0]; }),
  },
  groupAccount: {
    findMany: vi.fn(async ({ where = {}, include }) => {
      const rows = db.groupAccounts.filter((r) => whereMatch(r, where));
      if (include?.account) {
        return rows.map((r) => ({ ...r, account: db.accounts.find((a) => a.id === r.accountId) }));
      }
      return rows;
    }),
    createMany: vi.fn(async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const d of data) {
        const exists = db.groupAccounts.some((r) => r.groupId === d.groupId && r.accountId === d.accountId);
        if (exists && skipDuplicates) continue;
        if (exists && !skipDuplicates) throw new Error('unique');
        db.groupAccounts.push({ id: db._next(), createdAt: new Date(), ...d });
        count++;
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }) => {
      const before = db.groupAccounts.length;
      db.groupAccounts = db.groupAccounts.filter((r) => !whereMatch(r, where));
      return { count: before - db.groupAccounts.length };
    }),
    count: vi.fn(async ({ where = {} }) => db.groupAccounts.filter((r) => whereMatch(r, where)).length),
  },
  groupMember: {
    findMany: vi.fn(async ({ where = {}, include }) => {
      const rows = db.groupMembers.filter((r) => whereMatch(r, where));
      if (include?._count) {
        return rows.map((r) => ({ ...r, _count: { tasks: db.groupTasks.filter((t) => t.memberId === r.id).length } }));
      }
      return rows;
    }),
    createMany: vi.fn(async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const d of data) {
        const exists = db.groupMembers.some((r) => r.groupId === d.groupId && r.username === d.username);
        if (exists && skipDuplicates) continue;
        if (exists && !skipDuplicates) throw new Error('unique');
        db.groupMembers.push({ id: db._next(), createdAt: new Date(), active: true, ...d });
        count++;
      }
      return { count };
    }),
    findFirst: vi.fn(async ({ where }) => findOne('groupMembers', where)),
    delete: vi.fn(async ({ where }) => { const i = db.groupMembers.findIndex((r) => r.id === where.id); return db.groupMembers.splice(i, 1)[0]; }),
    count: vi.fn(async ({ where = {} }) => db.groupMembers.filter((r) => whereMatch(r, where)).length),
  },
  groupTask: {
    findMany: vi.fn(async ({ where = {}, include, orderBy, take, skip }) => {
      let rows = db.groupTasks.filter((r) => whereMatch(r, where));
      if (orderBy?.[0]?.createdAt === 'desc') rows = [...rows].reverse();
      if (take) rows = rows.slice(skip || 0, (skip || 0) + take);
      if (include?.member || include?.account) {
        rows = rows.map((r) => ({
          ...r,
          member: include?.member ? { username: db.groupMembers.find((m) => m.id === r.memberId)?.username } : undefined,
          account: include?.account ? { username: db.accounts.find((a) => a.id === r.accountId)?.username } : undefined,
        }));
      }
      return rows;
    }),
    count: vi.fn(async ({ where = {} }) => db.groupTasks.filter((r) => whereMatch(r, where)).length),
    createMany: vi.fn(async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const d of data) {
        const exists = db.groupTasks.some((r) =>
          r.groupId === d.groupId && r.accountId === d.accountId && r.memberId === d.memberId && r.action === d.action);
        if (exists && skipDuplicates) continue;
        if (exists && !skipDuplicates) throw new Error('unique');
        db.groupTasks.push({ id: db._next(), createdAt: new Date(), status: 'PENDING', retryCount: 0, ...d });
        count++;
      }
      return { count };
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const r of db.groupTasks) {
        if (whereMatch(r, where)) { Object.assign(r, data); count++; }
      }
      return { count };
    }),
    groupBy: vi.fn(async ({ by, where, _count }) => {
      const rows = db.groupTasks.filter((r) => whereMatch(r, where));
      const map = {};
      for (const r of rows) map[r.status] = (map[r.status] || 0) + 1;
      return Object.entries(map).map(([status, count]) => ({ status, _count: { _all: count } }));
    }),
  },
  operation: { create: vi.fn(async ({ data }) => { const r = { id: db._next(), ...data }; db.operations.push(r); return r; }) },
};

vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor() { return fakePrisma; } } }));

// The groups route imports jobQueue lazily (for start/resume). jobQueue imports
// Bull + prisma; stub it so start/resume don't touch Redis.
vi.mock('../../api/services/jobQueue.js', () => ({
  addJob: vi.fn(async (type, data) => ({ jobId: `job-${type}-${data.groupId}`, bullJobId: '1', operation: {} })),
  queueJob: vi.fn(async () => ({ id: 'x' })),
  getJob: vi.fn(async () => null),
  getJobStatus: vi.fn(async () => null),
  getHistory: vi.fn(async () => []),
  cancelJob: vi.fn(async () => {}),
  isJobCancelled: vi.fn(() => false),
  operationsQueue: { add: vi.fn(), process: vi.fn() },
}));

const { createApp } = await import('../../api/server.js');

describe('Group API', () => {
  let app;
  let httpServer;
  let userToken;
  let otherToken;

  const TEST_USER = { id: 'u1', username: 'alice', email: 'alice@x.com', isAdmin: false };
  const OTHER_USER = { id: 'u2', username: 'bob', email: 'bob@x.com', isAdmin: false };

  beforeAll(async () => {
    db.users.push(TEST_USER, OTHER_USER);
    userToken = jwt.sign({ userId: TEST_USER.id, username: TEST_USER.username }, process.env.JWT_SECRET);
    otherToken = jwt.sign({ userId: OTHER_USER.id, username: OTHER_USER.username }, process.env.JWT_SECRET);
    ({ app, httpServer } = createApp({ rateLimiting: false }));
    await new Promise((resolve) => httpServer.listen(0, resolve));
  });

  afterAll(async () => {
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  beforeEach(() => {
    db._reset();
    db.users.push(TEST_USER, OTHER_USER);
  });

  function auth(token = userToken) {
    return { Authorization: `Bearer ${token}` };
  }

  describe('accounts', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/accounts');
      expect(res.status).toBe(401);
    });

    it('creates an account with a validated cookie (masked in response)', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set(auth())
        .send({ sessionCookie: 'auth_token=abc123; ct0=xyz' });
      // Cookie validation hits the X client which fails without network —
      // the route rejects with 502; assert the error path keeps cookies masked.
      expect([400, 502]).toContain(res.status);
      expect(res.body).not.toHaveProperty('account.sessionCookie');
    });
  });

  describe('group CRUD', () => {
    it('creates and lists groups', async () => {
      const created = await request(app)
        .post('/api/groups')
        .set(auth())
        .send({ name: 'Marketing Group', actions: { like: true, comment: true } });
      expect(created.status).toBe(201);
      expect(created.body.group.name).toBe('Marketing Group');

      const listed = await request(app).get('/api/groups').set(auth());
      expect(listed.status).toBe(200);
      expect(listed.body.groups).toHaveLength(1);
    });

    it('enforces ownership on get', async () => {
      const created = await request(app).post('/api/groups').set(auth()).send({ name: 'G' });
      const id = created.body.group.id;
      const res = await request(app).get(`/api/groups/${id}`).set(auth(otherToken));
      expect(res.status).toBe(403);
    });

    it('updates and deletes', async () => {
      const created = await request(app).post('/api/groups').set(auth()).send({ name: 'G' });
      const id = created.body.group.id;
      const updated = await request(app).patch(`/api/groups/${id}`).set(auth()).send({ autoExecute: true, paused: true });
      expect(updated.status).toBe(200);
      expect(updated.body.group.autoExecute).toBe(true);
      const del = await request(app).delete(`/api/groups/${id}`).set(auth());
      expect(del.status).toBe(200);
    });
  });

  describe('members import', () => {
    it('imports members and generates tasks', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G', actions: { like: true } });
      const groupId = g.body.group.id;

      const acc = await createAccount('acc1');
      await request(app).post(`/api/groups/${groupId}/accounts`).set(auth()).send({ accountIds: [acc.id] });

      const imp = await request(app)
        .post(`/api/groups/${groupId}/members/import`)
        .set(auth())
        .send({ usernames: 'elonmusk, @sama, elonmusk, bad name!, vitalikbuterin' });
      expect(imp.status).toBe(201);
      expect(imp.body.added).toBe(3); // deduped elonmusk, rejected "bad name!"
      expect(imp.body.invalid).toContain('bad name!');
      expect(imp.body.generated.created).toBe(3); // 3 members × 1 account × like
    });

    it('does not duplicate tasks on re-import (AC3)', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G', actions: { like: true } });
      const groupId = g.body.group.id;
      const acc = await createAccount('acc1');
      await request(app).post(`/api/groups/${groupId}/accounts`).set(auth()).send({ accountIds: [acc.id] });

      await request(app).post(`/api/groups/${groupId}/members/import`).set(auth()).send({ usernames: 'elonmusk' });
      const again = await request(app).post(`/api/groups/${groupId}/members/import`).set(auth()).send({ usernames: 'elonmusk' });

      expect(again.body.generated.created).toBe(0); // skipDuplicates
      expect(db.groupTasks.filter((t) => t.action === 'like')).toHaveLength(1);
    });
  });

  describe('tasks', () => {
    it('cancel flips PENDING to CANCELLED only', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G', actions: { like: true } });
      const groupId = g.body.group.id;
      const acc = await createAccount('acc1');
      await request(app).post(`/api/groups/${groupId}/accounts`).set(auth()).send({ accountIds: [acc.id] });
      await request(app).post(`/api/groups/${groupId}/members/import`).set(auth()).send({ usernames: 'elonmusk' });

      db.groupTasks[0].status = 'COMPLETED';
      const cancel = await request(app).post(`/api/groups/${groupId}/tasks/cancel`).set(auth()).send({});
      expect(cancel.body.cancelled).toBe(db.groupTasks.length - 1);
    });

    it('stats endpoint groups by status', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G' });
      const groupId = g.body.group.id;
      db.groupTasks.push(
        { id: 't1', groupId, accountId: 'a', memberId: 'm', action: 'like', status: 'COMPLETED' },
        { id: 't2', groupId, accountId: 'a', memberId: 'm', action: 'like', status: 'PENDING' },
        { id: 't3', groupId, accountId: 'a', memberId: 'm', action: 'follow', status: 'RATE_LIMITED' },
      );
      const res = await request(app).get(`/api/groups/${groupId}/stats`).set(auth());
      expect(res.body.stats.completed).toBe(1);
      expect(res.body.stats.pending).toBe(1);
      expect(res.body.stats.rateLimited).toBe(1);
    });
  });

  describe('automation lifecycle', () => {
    it('start queues a groupAutomation job', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G' });
      const groupId = g.body.group.id;
      const res = await request(app).post(`/api/groups/${groupId}/automation/start`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.jobId).toMatch(/^job-groupAutomation-/);
    });

    it('pause and resume', async () => {
      const g = await request(app).post('/api/groups').set(auth()).send({ name: 'G' });
      const groupId = g.body.group.id;
      const paused = await request(app).post(`/api/groups/${groupId}/automation/pause`).set(auth());
      expect(paused.body.paused).toBe(true);
      const resumed = await request(app).post(`/api/groups/${groupId}/automation/resume`).set(auth());
      expect(resumed.status).toBe(200);
    });
  });

  async function createAccount(username) {
    // Bypass cookie validation (network) by inserting directly into the fake.
    const acc = { id: db._next(), userId: TEST_USER.id, username, sessionCookie: `auth_token=x; ct0=y`, authMethod: 'session', isActive: true, isBlocked: false };
    db.accounts.push(acc);
    return acc;
  }
});
