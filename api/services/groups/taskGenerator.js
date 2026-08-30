// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group Task Generator
 *
 * Idempotently creates GroupTask rows for eligible account × member × action
 * combinations. Uniqueness is enforced by the composite index
 * (groupId, accountId, memberId, action) plus createMany(skipDuplicates).
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const ACTION_PRIORITIES = {
  like: 5,
  follow: 5,
  comment: 8,
  repost: 8,
};

const ENABLED_ACTIONS = ['like', 'comment', 'repost', 'follow'];

/**
 * Parse a group's actions JSON config into { action: boolean }.
 * @param {string} actionsJson
 * @returns {Record<string, boolean>}
 */
export function parseActions(actionsJson) {
  try {
    const parsed = JSON.parse(actionsJson || '{}');
    const out = {};
    for (const action of ENABLED_ACTIONS) {
      out[action] = parsed[action] === true;
    }
    return out;
  } catch {
    return { like: true, comment: false, repost: false, follow: false };
  }
}

/**
 * Generate PENDING tasks for a group.
 *
 * Called on member import, account link, and manual "generate". Skips groups
 * that are paused. Does not duplicate existing tasks (composite unique +
 * skipDuplicates).
 *
 * @param {string} groupId
 * @param {{ reason?: string }} [options]
 * @returns {Promise<{ created: number, skipped: number, details: object }>}
 */
export async function generateTasksForGroup(groupId, options = {}) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw new Error('Group not found');

  if (group.paused) {
    return { created: 0, skipped: 0, paused: true, details: {} };
  }

  const actions = parseActions(group.actions);
  const enabledActions = ENABLED_ACTIONS.filter((a) => actions[a]);

  // Linked, active, authenticated accounts.
  const groupAccounts = await prisma.groupAccount.findMany({
    where: { groupId },
    include: {
      account: {
        select: {
          id: true,
          username: true,
          sessionCookie: true,
          isActive: true,
          isBlocked: true,
        },
      },
    },
  });

  const accounts = groupAccounts
    .map((ga) => ga.account)
    .filter((a) => a.isActive && !a.isBlocked && a.sessionCookie);

  if (accounts.length === 0 || enabledActions.length === 0) {
    return { created: 0, skipped: 0, details: { accounts: accounts.length, actions: enabledActions } };
  }

  const members = await prisma.groupMember.findMany({
    where: { groupId, active: true },
    select: { id: true },
  });

  if (members.length === 0) {
    return { created: 0, skipped: 0, details: { accounts: accounts.length, actions: enabledActions, members: 0 } };
  }

  let created = 0;
  let skipped = 0;
  const rows = [];

  for (const account of accounts) {
    for (const member of members) {
      for (const action of enabledActions) {
        rows.push({
          groupId,
          accountId: account.id,
          memberId: member.id,
          action,
          priority: ACTION_PRIORITIES[action] ?? 5,
          status: 'PENDING',
        });
      }
    }
    // Batch per account so a huge group doesn't blow a single createMany.
    if (rows.length >= 500) {
      const result = await prisma.groupTask.createMany({ data: rows, skipDuplicates: true });
      created += result.count;
      skipped += rows.length - result.count;
      rows.length = 0;
    }
  }

  if (rows.length > 0) {
    const result = await prisma.groupTask.createMany({ data: rows, skipDuplicates: true });
    created += result.count;
    skipped += rows.length - result.count;
  }

  return {
    created,
    skipped,
    details: { accounts: accounts.length, members: members.length, actions: enabledActions },
    ...(options.reason ? { reason: options.reason } : {}),
  };
}
