// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM member sync.
 *
 * Runs an extraction for a conversation through a chosen app Account,
 * upserts the results into XGroupMember (keyed by conversationId +
 * xUserId), diffs ADDED / REMOVED / UNCHANGED, then links the current
 * members into the chosen Group's GroupMember table so the existing task
 * generator can create tasks for them.
 *
 * Discovery/sync only — never executes actions itself.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { PrismaClient } from '@prisma/client';
import { extractGroupMembers } from './extractor.js';
import { acquireSyncLock, releaseSyncLock } from './lock.js';
import { generateTasksForGroup } from '../groups/taskGenerator.js';

const prisma = new PrismaClient();

export class SyncAlreadyRunningError extends Error {
  constructor(message = 'A sync is already running for this conversation') {
    super(message);
    this.name = 'SyncAlreadyRunningError';
    this.code = 'SYNC_ALREADY_RUNNING';
  }
}

export const SYNC_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  CANCELLED: 'CANCELLED',
};

/**
 * Run a member sync for one conversation through one account.
 *
 * @param {object} options
 * @param {string} options.accountId - app Account id (has the X session cookie)
 * @param {string} options.conversationId - g<digits> conversation id
 * @param {string} options.groupId - Group to link members into (task generation)
 * @param {function} [options.isCancelled] - () => boolean
 * @param {object} [options.prisma] - injectable for tests
 * @returns {Promise<object>} sync result per spec §13
 */
export async function runXGroupMemberSync(options = {}) {
  const {
    accountId,
    conversationId,
    groupId,
    isCancelled = () => false,
    extractor = extractGroupMembers,
    generateTasks = generateTasksForGroup,
  } = options;
  const db = options.prisma || prisma;
  const startedAt = Date.now();

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Account ${accountId} not found`);
  if (!account.isActive || account.isBlocked) {
    throw new Error(`Account ${account.username} is not active`);
  }
  if (!account.sessionCookie) {
    throw new Error(`Account ${account.username} has no session cookie`);
  }

  const group = await db.group.findUnique({ where: { id: groupId } });
  if (!group) throw new Error(`Group ${groupId} not found`);

  // Respect the account's daily DM cap before hitting X (AC8 / spec §18).
  // A sync is charged as one `dm` action. If over the cap, mark the task
  // RATE_LIMITED with the next available window — never an endless retry.
  const { remaining } = await import('../../../src/mcp/action-caps.js');
  const capInfo = remaining(account.username);
  const dmCap = capInfo?.classes?.dm;
  if (dmCap && dmCap.remaining <= 0) {
    const nextRunAt = dmCap.resetAt ? new Date(dmCap.resetAt) : new Date(Date.now() + 60 * 60 * 1000);
    console.log(`[xGroupSync] ${account.username} DM cap exhausted — reschedule at ${nextRunAt.toISOString()}`);
    return {
      status: SYNC_STATUS.RATE_LIMITED,
      nextRunAt,
      accountUsed: accountId,
      conversationId,
    };
  }

  // Serialize syncs per conversation via a Redis lock (no double work).
  const lockToken = await acquireSyncLock(conversationId);
  if (!lockToken) throw new SyncAlreadyRunningError();

  try {
    if (isCancelled()) return { status: SYNC_STATUS.CANCELLED, cancelled: true };

    const { TwitterHttpClient } = await import('../../../src/scrapers/twitter/http/client.js');
    const client = new TwitterHttpClient({ cookies: account.sessionCookie });

    const extracted = await extractor({
      client,
      conversationId,
      onProgress: ({ processed, page }) => {
        // Progress is surfaced through the operation row by the worker.
        if (isCancelled()) return;
        console.log(`[xGroupSync] ${conversationId}: ${processed} members, page ${page}`);
      },
    });

    if (isCancelled()) return { status: SYNC_STATUS.CANCELLED, cancelled: true };

    const members = extracted.members;

    // Upsert each extracted member into XGroupMember.
    let newMembers = 0;
    let updatedMembers = 0;
    for (const m of members) {
      const existing = await db.xGroupMember.findUnique({
        where: { conversationId_xUserId: { conversationId, xUserId: m.xUserId } },
      });
      if (existing) {
        await db.xGroupMember.update({
          where: { id: existing.id },
          data: {
            username: m.username,
            displayName: m.displayName || existing.displayName,
            profileUrl: m.profileUrl || existing.profileUrl,
            avatarUrl: m.avatarUrl || existing.avatarUrl,
            isAdmin: m.isAdmin,
            isCurrentMember: true,
            lastSeenAt: new Date(),
          },
        });
        updatedMembers += 1;
      } else {
        await db.xGroupMember.create({
          data: {
            conversationId,
            xUserId: m.xUserId,
            username: m.username,
            displayName: m.displayName || null,
            profileUrl: m.profileUrl || null,
            avatarUrl: m.avatarUrl || null,
            isAdmin: m.isAdmin,
            isCurrentMember: true,
          },
        });
        newMembers += 1;
      }
    }

    // Diff: mark previously-current members that are no longer present.
    const currentIds = new Set(members.map((m) => m.xUserId));
    const priorMembers = await db.xGroupMember.findMany({
      where: { conversationId, isCurrentMember: true },
      select: { id: true, xUserId: true },
    });
    let removedMembers = 0;
    for (const prior of priorMembers) {
      if (!currentIds.has(prior.xUserId)) {
        await db.xGroupMember.update({
          where: { id: prior.id },
          data: { isCurrentMember: false },
        });
        removedMembers += 1;
      }
    }

    // Link current members into the chosen Group's GroupMember table, then
    // let the existing task generator create tasks for eligible accounts.
    if (groupId && members.length > 0) {
      const usernames = members.filter((m) => m.username).map((m) => m.username);
      if (usernames.length > 0) {
        await db.groupMember.createMany({
          data: usernames.map((username) => {
            const m = members.find((x) => x.username === username);
            return {
              groupId,
              username,
              displayName: m?.displayName || null,
              profileUrl: m?.profileUrl || null,
              avatar: m?.avatarUrl || null,
            };
          }),
          skipDuplicates: true,
        });
        await generateTasks(groupId, { reason: 'dm-member-sync' });
      }
    }

    const totalMembers = members.length;
    console.log(
      `[xGroupSync] ${conversationId} done: ${totalMembers} total, ` +
      `${newMembers} new, ${updatedMembers} updated, ${removedMembers} removed ` +
      `(${Date.now() - startedAt}ms)`,
    );

    return {
      conversationId,
      totalMembers,
      newMembers,
      updatedMembers,
      removedMembers,
      accountUsed: accountId,
      status: SYNC_STATUS.COMPLETED,
    };
  } finally {
    await releaseSyncLock(conversationId, lockToken);
  }
}
