// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group Task Claim Store
 *
 * Transactional claim/lock/lease/release for group tasks, modelled on the
 * account-pool lease pattern. A claim flips PENDING → CLAIMED with a lease
 * timestamp; expired claims are reaped back to PENDING by the worker before
 * each pass. The composite unique index on GroupTask guarantees no two agents
 * can ever claim the same (group, account, member, action) pair twice.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Claim up to `limit` PENDING tasks for a group, oldest first.
 *
 * Uses a transaction with the composite unique index as the guard: the
 * PENDING→CLAIMED update only affects rows still PENDING, so two concurrent
 * workers cannot double-claim.
 *
 * @param {string} groupId
 * @param {{ accountId?: string, limit?: number }} [options]
 * @returns {Promise<Array>} claimed task rows with member/account relations
 */
export async function claimNextTasks(groupId, options = {}) {
  const { accountId, limit = 5 } = options;

  const where = {
    groupId,
    status: 'PENDING',
    nextRetryAt: { lte: new Date() },
    ...(accountId ? { accountId } : {}),
  };

  const candidates = await prisma.groupTask.findMany({
    where,
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    include: {
      member: { select: { id: true, username: true } },
      account: { select: { id: true, username: true, sessionCookie: true } },
    },
  });

  if (candidates.length === 0) return [];

  const claimed = [];
  const now = new Date();

  for (const candidate of candidates) {
    const updated = await prisma.groupTask.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'CLAIMED', claimedAt: now },
    });
    if (updated.count === 1) claimed.push(candidate);
  }

  return claimed;
}

/**
 * Release a claim back to PENDING (for retry) or mark it terminal.
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {string} opts.status - final status: COMPLETED | FAILED | CANCELLED |
 *                               RATE_LIMITED | COOLDOWN | PENDING (retry)
 * @param {string} [opts.error]
 * @param {string} [opts.result]
 * @param {Date}   [opts.nextRetryAt]
 */
export async function releaseClaim(taskId, opts) {
  const { status, error, result, nextRetryAt } = opts;
  const data = {
    status,
    error: error ?? null,
    result: result ?? null,
  };
  if (nextRetryAt) data.nextRetryAt = nextRetryAt;
  if (status === 'COMPLETED') data.completedAt = new Date();
  if (status === 'FAILED' || status === 'CANCELLED') data.failedAt = new Date();
  if (status === 'PENDING') data.claimedAt = null;

  return prisma.groupTask.update({ where: { id: taskId }, data });
}

/**
 * Return CLAIMED tasks whose lease has expired to PENDING.
 * @returns {Promise<number>} number reaped
 */
export async function reapExpiredClaims() {
  const cutoff = new Date(Date.now() - CLAIM_LEASE_MS);
  const result = await prisma.groupTask.updateMany({
    where: { status: 'CLAIMED', claimedAt: { lt: cutoff } },
    data: { status: 'PENDING', claimedAt: null },
  });
  return result.count;
}
