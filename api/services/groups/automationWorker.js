// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group Automation Worker
 *
 * Bull processor for the `groupAutomation` job type. Runs one sequential
 * pass per group: reap stale claims, claim PENDING tasks, check account caps,
 * execute via session-cookie HTTP, and mark COMPLETED / FAILED / RATE_LIMITED /
 * COOLDOWN. Rate-limited and cooldown tasks are rescheduled via nextRetryAt —
 * never an endless retry loop.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { PrismaClient } from '@prisma/client';
import { claimNextTasks, releaseClaim, reapExpiredClaims } from './claimStore.js';
import { executeTask } from './executor.js';
import { checkAccountCap } from './rateLimiter.js';
import { parseActions } from './taskGenerator.js';

const prisma = new PrismaClient();

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 30_000;

/** Emit a group event to the dashboard room. */
function emitGroupEvent(io, groupId, event, payload) {
  try {
    io?.to(`group:${groupId}`).emit(event, { groupId, ...payload });
  } catch {
    // Socket emission must never kill the worker.
  }
}

/**
 * Run one group automation pass.
 *
 * @param {object} params
 * @param {string} params.groupId
 * @param {object} [params.io] - Socket.IO server for live events
 * @param {Function} [params.isCancelled]
 * @param {object} [params.prismaOverride] - test seam
 * @returns {Promise<{ processed: number, completed: number, failed: number,
 *                     rateLimited: number, nextRunAt: Date|null }>}
 */
export async function runGroupAutomation({ groupId, io, isCancelled = () => false, prismaOverride }) {
  const db = prismaOverride || prisma;
  const group = await db.group.findUnique({ where: { id: groupId } });
  if (!group) return { processed: 0, completed: 0, failed: 0, rateLimited: 0, nextRunAt: null };

  if (group.paused) {
    return { processed: 0, completed: 0, failed: 0, rateLimited: 0, nextRunAt: null, paused: true };
  }

  const actions = parseActions(group.actions);
  const enabledActions = Object.entries(actions).filter(([, enabled]) => enabled).map(([a]) => a);
  if (enabledActions.length === 0) {
    return { processed: 0, completed: 0, failed: 0, rateLimited: 0, nextRunAt: null };
  }

  const stats = { processed: 0, completed: 0, failed: 0, rateLimited: 0, nextRunAt: null };

  // Reap stale claims from crashed workers before claiming.
  await reapExpiredClaims();

  let nextReschedule = null;

  while (!isCancelled()) {
    // Re-check pause each pass.
    const freshGroup = await db.group.findUnique({ where: { id: groupId }, select: { paused: true } });
    if (freshGroup?.paused) break;

    const tasks = await claimNextTasks(groupId, { limit: 5 });
    if (tasks.length === 0) break;

    for (const task of tasks) {
      if (isCancelled()) break;

      const actionClass = task.action;
      if (!enabledActions.includes(actionClass)) {
        await releaseClaim(task.id, { status: 'CANCELLED', error: 'Action disabled in group' });
        continue;
      }

      // Per-account cooldown between actions.
      if (group.cooldownSec > 0) {
        await new Promise((r) => setTimeout(r, Math.min(group.cooldownSec * 1000, 60_000)));
        if (isCancelled()) break;
      }

      // Daily cap check — over the cap → RATE_LIMITED + reschedule.
      const cap = checkAccountCap(task.account.username, actionClass);
      if (!cap.allowed) {
        const nextRetryAt = cap.resetAt ? new Date(cap.resetAt) : new Date(Date.now() + 15 * 60 * 1000);
        await releaseClaim(task.id, { status: 'RATE_LIMITED', nextRetryAt, error: 'Daily action cap reached' });
        stats.rateLimited += 1;
        if (!nextReschedule || nextRetryAt < nextReschedule) nextReschedule = nextRetryAt;
        emitGroupEvent(io, groupId, 'group:taskRateLimited', {
          taskId: task.id,
          action: actionClass,
          memberUsername: task.member?.username,
          accountUsername: task.account?.username,
          rescheduleAt: nextRetryAt.toISOString(),
        });
        continue;
      }

      emitGroupEvent(io, groupId, 'group:taskClaimed', {
        taskId: task.id,
        action: actionClass,
        memberUsername: task.member?.username,
        accountUsername: task.account?.username,
      });

      const outcome = await executeTask(task);
      stats.processed += 1;

      if (outcome.ok) {
        await releaseClaim(task.id, { status: 'COMPLETED', result: outcome.result });
        stats.completed += 1;
        emitGroupEvent(io, groupId, 'group:taskCompleted', {
          taskId: task.id,
          action: actionClass,
          memberUsername: task.member?.username,
          accountUsername: task.account?.username,
          result: outcome.result,
        });
      } else if (outcome.verdict === 'rateLimit') {
        const nextRetryAt = new Date(Date.now() + (outcome.retryAfterMs ?? 15 * 60 * 1000));
        await releaseClaim(task.id, { status: 'COOLDOWN', nextRetryAt, error: outcome.error });
        stats.rateLimited += 1;
        if (!nextReschedule || nextRetryAt < nextReschedule) nextReschedule = nextRetryAt;
        emitGroupEvent(io, groupId, 'group:taskRateLimited', {
          taskId: task.id,
          action: actionClass,
          memberUsername: task.member?.username,
          accountUsername: task.account?.username,
          rescheduleAt: nextRetryAt.toISOString(),
        });
      } else if (outcome.verdict === 'permanent') {
        await releaseClaim(task.id, { status: 'FAILED', error: outcome.error });
        stats.failed += 1;
        emitGroupEvent(io, groupId, 'group:taskFailed', {
          taskId: task.id,
          action: actionClass,
          memberUsername: task.member?.username,
          accountUsername: task.account?.username,
          error: outcome.error,
          retryable: false,
        });
      } else {
        // Transient — retry with backoff up to MAX_RETRIES, then FAILED.
        const retries = task.retryCount + 1;
        if (retries >= MAX_RETRIES) {
          await releaseClaim(task.id, { status: 'FAILED', error: outcome.error });
          stats.failed += 1;
          emitGroupEvent(io, groupId, 'group:taskFailed', {
            taskId: task.id,
            action: actionClass,
            memberUsername: task.member?.username,
            accountUsername: task.account?.username,
            error: outcome.error,
            retryable: false,
          });
        } else {
          const backoff = RETRY_BASE_MS * 2 ** (retries - 1);
          const nextRetryAt = new Date(Date.now() + backoff);
          await releaseClaim(task.id, { status: 'PENDING', error: outcome.error, nextRetryAt });
          await db.groupTask.update({ where: { id: task.id }, data: { retryCount: retries } });
          if (!nextReschedule || nextRetryAt < nextReschedule) nextReschedule = nextRetryAt;
        }
      }
    }

    // Don't hammer the DB — a short breathe between claim batches.
    await new Promise((r) => setTimeout(r, 500));
  }

  stats.nextRunAt = nextReschedule;
  return stats;
}
