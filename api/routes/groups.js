// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * XActions Groups API Routes
 *
 * Groups bundle imported X members with linked app accounts so tasks
 * (like/comment/repost/follow) are generated and executed automatically.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import { generateTasksForGroup } from '../services/groups/taskGenerator.js';

const prisma = new PrismaClient();
const router = Router();

router.use(authenticate);

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TASK_STATUSES = new Set(['PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'COOLDOWN', 'RATE_LIMITED']);

function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

/** Load a group only if the requester owns it (or is admin). */
async function loadOwnedGroup(groupId, user) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return null;
  if (group.userId !== user.id && !user.isAdmin) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return group;
}

// ── Group CRUD ─────────────────────────────────────────────────────────────

// GET /api/groups
router.get('/', async (req, res) => {
  try {
    const groups = await prisma.group.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { members: true, accounts: true, tasks: true } },
      },
    });
    res.json({ groups });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups  { name, description?, actions?, autoExecute?, cooldownSec? }
router.post('/', async (req, res) => {
  try {
    const { name, description, actions, autoExecute, cooldownSec } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const group = await prisma.group.create({
      data: {
        userId: req.user.id,
        name: name.trim(),
        description: description || null,
        actions: actions ? JSON.stringify(actions) : undefined,
        autoExecute: Boolean(autoExecute),
        cooldownSec: Number.isInteger(cooldownSec) ? Math.max(0, cooldownSec) : 0,
      },
    });
    res.status(201).json({ group });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/:id
router.get('/:id', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const stats = await getGroupStats(group.id);
    res.json({ group: { ...group, actions: parseActionsJson(group.actions) }, stats });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PATCH /api/groups/:id
router.patch('/:id', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const data = {};
    if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
    if (typeof req.body?.description === 'string') data.description = req.body.description;
    if (req.body?.actions && typeof req.body.actions === 'object') data.actions = JSON.stringify(req.body.actions);
    if (typeof req.body?.autoExecute === 'boolean') data.autoExecute = req.body.autoExecute;
    if (typeof req.body?.paused === 'boolean') data.paused = req.body.paused;
    if (Number.isInteger(req.body?.cooldownSec)) data.cooldownSec = Math.max(0, req.body.cooldownSec);

    const updated = await prisma.group.update({ where: { id: group.id }, data });
    res.json({ group: { ...updated, actions: parseActionsJson(updated.actions) } });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// DELETE /api/groups/:id
router.delete('/:id', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await prisma.group.delete({ where: { id: group.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Linked accounts ────────────────────────────────────────────────────────

// GET /api/groups/:id/accounts
router.get('/:id/accounts', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const links = await prisma.groupAccount.findMany({
      where: { groupId: group.id },
      include: {
        account: {
          select: { id: true, username: true, isActive: true, isBlocked: true, lastUsedAt: true, createdAt: true },
        },
      },
    });
    res.json({ accounts: links.map((l) => l.account) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/accounts  { accountIds: [] }
router.post('/:id/accounts', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const accountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : [];
    if (accountIds.length === 0) return res.status(400).json({ error: 'accountIds is required' });

    // Validate ownership + active + authenticated.
    const accounts = await prisma.account.findMany({
      where: { id: { in: accountIds }, userId: req.user.id },
    });
    const found = new Set(accounts.map((a) => a.id));
    const missing = accountIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: 'One or more accounts not found', missing });
    }
    const ineligible = accounts.filter((a) => !a.isActive || a.isBlocked || !a.sessionCookie);
    if (ineligible.length > 0) {
      return res.status(400).json({ error: 'One or more accounts are inactive/blocked/unauthenticated', ineligible: ineligible.map((a) => a.username) });
    }

    const links = await prisma.groupAccount.createMany({
      data: accountIds.map((accountId) => ({ groupId: group.id, accountId })),
      skipDuplicates: true,
    });

    // Generate missing tasks for the newly linked accounts.
    const generated = await generateTasksForGroup(group.id, { reason: 'account-link' });

    res.status(201).json({ linked: links.count, generated });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// DELETE /api/groups/:id/accounts/:accountId
router.delete('/:id/accounts/:accountId', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    await prisma.groupAccount.deleteMany({
      where: { groupId: group.id, accountId: req.params.accountId },
    });
    // Cancel PENDING tasks for that account (completed stays).
    await prisma.groupTask.updateMany({
      where: { groupId: group.id, accountId: req.params.accountId, status: 'PENDING' },
      data: { status: 'CANCELLED', failedAt: new Date(), error: 'Account removed from group' },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Members ────────────────────────────────────────────────────────────────

// GET /api/groups/:id/members
router.get('/:id/members', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const members = await prisma.groupMember.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
    });
    res.json({ members });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/members/import  { usernames: string | string[] }
router.post('/:id/members/import', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const raw = req.body?.usernames;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,;]+/);

    const seen = new Set();
    const members = [];
    const invalid = [];
    for (const entry of list) {
      const trimmed = String(entry).trim();
      if (!trimmed) continue;
      const name = cleanUsername(trimmed);
      if (!name || /\s/.test(trimmed)) { invalid.push(trimmed); continue; }
      if (seen.has(name)) continue;
      seen.add(name);
      members.push({ groupId: group.id, username: name });
    }
    if (members.length === 0 && invalid.length > 0) {
      return res.status(400).json({ error: 'No valid usernames provided', invalid: invalid.slice(0, 20) });
    }

    const result = await prisma.groupMember.createMany({ data: members, skipDuplicates: true });
    const generated = await generateTasksForGroup(group.id, { reason: 'member-import' });

    res.status(201).json({ added: result.count, invalid: invalid.slice(0, 20), generated });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// DELETE /api/groups/:id/members/:memberId
router.delete('/:id/members/:memberId', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const member = await prisma.groupMember.findFirst({
      where: { id: req.params.memberId, groupId: group.id },
    });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    // Cancel PENDING tasks targeting this member; keep completed history.
    await prisma.groupTask.updateMany({
      where: { groupId: group.id, memberId: member.id, status: 'PENDING' },
      data: { status: 'CANCELLED', failedAt: new Date(), error: 'Member removed from group' },
    });
    await prisma.groupMember.delete({ where: { id: member.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Tasks ──────────────────────────────────────────────────────────────────

// GET /api/groups/:id/tasks  ?status=&action=&accountId=&limit=&offset=
router.get('/:id/tasks', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const where = { groupId: group.id };
    if (req.query.status) {
      if (!TASK_STATUSES.has(req.query.status)) return res.status(400).json({ error: 'Invalid status' });
      where.status = req.query.status;
    }
    if (req.query.action) where.action = req.query.action;
    if (req.query.accountId) where.accountId = req.query.accountId;

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [tasks, total] = await Promise.all([
      prisma.groupTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          member: { select: { username: true } },
          account: { select: { username: true } },
        },
      }),
      prisma.groupTask.count({ where }),
    ]);
    res.json({ tasks, total });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/tasks/generate
router.post('/:id/tasks/generate', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const generated = await generateTasksForGroup(group.id, { reason: 'manual' });
    res.json({ generated });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/tasks/cancel  { action?, accountId?, memberId? }
router.post('/:id/tasks/cancel', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const where = { groupId: group.id, status: 'PENDING' };
    if (req.body?.action) where.action = req.body.action;
    if (req.body?.accountId) where.accountId = req.body.accountId;
    if (req.body?.memberId) where.memberId = req.body.memberId;

    const result = await prisma.groupTask.updateMany({
      where,
      data: { status: 'CANCELLED', failedAt: new Date(), error: 'Cancelled by user' },
    });
    res.json({ cancelled: result.count });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /api/groups/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const stats = await getGroupStats(group.id);
    res.json({ stats });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Automation lifecycle ───────────────────────────────────────────────────

// POST /api/groups/:id/automation/start
router.post('/:id/automation/start', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { addJob } = await import('../services/jobQueue.js');
    await prisma.group.update({ where: { id: group.id }, data: { paused: false, autoExecute: true } });
    const result = await addJob('groupAutomation', { userId: req.user.id, groupId: group.id }, { priority: 5 });
    res.json({ success: true, jobId: result.jobId });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/automation/pause
router.post('/:id/automation/pause', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await prisma.group.update({ where: { id: group.id }, data: { paused: true } });
    res.json({ success: true, paused: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/groups/:id/automation/resume
router.post('/:id/automation/resume', async (req, res) => {
  try {
    const group = await loadOwnedGroup(req.params.id, req.user);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await prisma.group.update({ where: { id: group.id }, data: { paused: false } });
    const { addJob } = await import('../services/jobQueue.js');
    const result = await addJob('groupAutomation', { userId: req.user.id, groupId: group.id }, { priority: 5 });
    res.json({ success: true, jobId: result.jobId });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function parseActionsJson(actionsJson) {
  try { return JSON.parse(actionsJson || '{}'); } catch { return {}; }
}

async function getGroupStats(groupId) {
  const rows = await prisma.groupTask.groupBy({
    by: ['status'],
    where: { groupId },
    _count: { _all: true },
  });
  const stats = {
    pending: 0, claimed: 0, running: 0, completed: 0, failed: 0, cancelled: 0, cooldown: 0, rateLimited: 0,
  };
  const KEY_MAP = { 'rate_limited': 'rateLimited' };
  for (const row of rows) {
    const key = KEY_MAP[row.status.toLowerCase()] || row.status.toLowerCase();
    if (key in stats) stats[key] = row._count._all;
  }
  const [members, accounts] = await Promise.all([
    prisma.groupMember.count({ where: { groupId } }),
    prisma.groupAccount.count({ where: { groupId } }),
  ]);
  return { ...stats, members, accounts };
}

export default router;
