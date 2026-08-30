// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM Member Extraction API Routes
 *
 * Parse a group-chat URL, sync its members through a chosen app account,
 * and list the stored members. Discovery/sync only — no action execution.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import { parseXGroupUrl, InvalidGroupUrlError } from '../services/xGroups/urlParser.js';
import { SyncAlreadyRunningError } from '../services/xGroups/sync.js';
import { addJob } from '../services/jobQueue.js';

const prisma = new PrismaClient();
const router = Router();

router.use(authenticate);

const CONVERSATION_RE = /^g\d{6,}$/;

function parseConversationId(raw) {
  const id = String(raw || '').trim();
  return CONVERSATION_RE.test(id) ? id : null;
}

// ── Parse URL ───────────────────────────────────────────────────────────────

// POST /api/x/groups/parse  { url } → { conversationId }
router.post('/parse', async (req, res) => {
  try {
    const { conversationId } = parseXGroupUrl(req.body?.url);
    return res.json({ conversationId });
  } catch (err) {
    if (err instanceof InvalidGroupUrlError) {
      return res.status(400).json({ error: err.code });
    }
    return res.status(400).json({ error: 'INVALID_GROUP_URL', message: err.message });
  }
});

// ── Sync members ────────────────────────────────────────────────────────────

// POST /api/x/groups/:conversationId/members/sync  { accountId, groupId } → { taskId }
router.post('/:conversationId/members/sync', async (req, res) => {
  const conversationId = parseConversationId(req.params.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: 'INVALID_GROUP_URL' });
  }
  const { accountId, groupId } = req.body || {};

  try {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account || (account.userId !== req.user.id && !req.user.isAdmin)) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group || (group.userId !== req.user.id && !req.user.isAdmin)) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const { jobId } = await addJob('xGroupMemberSync', {
      userId: req.user.id,
      accountId,
      conversationId,
      groupId,
      config: JSON.stringify({ conversationId, accountId, groupId }),
    }, { attempts: 1 });

    return res.status(202).json({ taskId: jobId });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return res.status(409).json({ error: 'SYNC_ALREADY_RUNNING' });
    }
    console.error('❌ xGroup sync error:', err);
    return res.status(500).json({ error: 'Failed to start sync', message: err.message });
  }
});

// ── List members ────────────────────────────────────────────────────────────

// GET /api/x/groups/:conversationId/members?search=&sort=&page=&pageSize=
router.get('/:conversationId/members', async (req, res) => {
  const conversationId = parseConversationId(req.params.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: 'INVALID_GROUP_URL' });
  }

  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const sort = String(req.query.sort || 'username');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

    const where = { conversationId };
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [members, total] = await Promise.all([
      prisma.xGroupMember.findMany({
        where,
        orderBy: { [sort]: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.xGroupMember.count({ where }),
    ]);

    return res.json({ members, total, page, pageSize });
  } catch (err) {
    console.error('❌ xGroup members list error:', err);
    return res.status(500).json({ error: 'Failed to list members', message: err.message });
  }
});

// ── Sync status ─────────────────────────────────────────────────────────────

// GET /api/x/groups/:conversationId/sync-status → latest operation progress
router.get('/:conversationId/sync-status', async (req, res) => {
  const conversationId = parseConversationId(req.params.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: 'INVALID_GROUP_URL' });
  }

  try {
    // config is a String column; match the conversation id by substring.
    const operation = await prisma.operation.findFirst({
      where: {
        type: 'xGroupMemberSync',
        userId: req.user.id,
        config: { contains: conversationId },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!operation) {
      return res.json({ status: 'IDLE', processed: 0, total: 0, pages: 0 });
    }

    const progress = operation.progress || {};
    return res.json({
      status: (operation.status || 'queued').toUpperCase(),
      processed: progress.processed || 0,
      total: progress.total || 0,
      pages: progress.pages || 0,
      taskId: operation.id,
      error: operation.error || null,
    });
  } catch (err) {
    console.error('❌ xGroup sync status error:', err);
    return res.status(500).json({ error: 'Failed to fetch sync status', message: err.message });
  }
});

export default router;
