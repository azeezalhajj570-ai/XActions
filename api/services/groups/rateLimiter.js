// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group Task Rate Limiter
 *
 * Wraps the persistent per-account action-caps ledger (src/mcp/action-caps.js)
 * so group automation obeys the same daily budgets as every other write path.
 * When an account is over its cap the worker marks the task RATE_LIMITED and
 * reschedules it for the cap reset time — never an endless retry loop.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import {
  checkAndRecord,
  remaining,
} from '../../../src/mcp/action-caps.js';

/** Map a group task action to its ledger class. */
export function actionClassFor(taskAction) {
  switch (taskAction) {
    case 'like': return 'like';
    case 'repost': return 'repost';
    case 'follow': return 'follow';
    case 'comment': return 'reply';
    default: return 'like';
  }
}

/**
 * Check whether the account may perform the action and record it if so.
 *
 * @param {string} accountUsername - ledger key (X username)
 * @param {string} taskAction
 * @param {{ count?: number }} [options]
 * @returns {{ allowed: boolean, resetAt: number|null }}
 */
export function checkAccountCap(accountUsername, taskAction, options = {}) {
  const actionClass = actionClassFor(taskAction);
  try {
    checkAndRecord(accountUsername, actionClass, { count: options.count ?? 1 });
    return { allowed: true, resetAt: null };
  } catch (error) {
    // ActionCapExceededError carries resetAt as a Date.
    const resetAt = error?.resetAt;
    return { allowed: false, resetAt: resetAt instanceof Date ? resetAt.getTime() : null };
  }
}

/**
 * Peek at the remaining budget without recording.
 * @param {string} accountUsername
 * @param {string} taskAction
 * @returns {number|null}
 */
export function remainingFor(accountUsername, taskAction) {
  try {
    const report = remaining(accountUsername);
    const entry = report?.classes?.[actionClassFor(taskAction)];
    return typeof entry?.remaining === 'number' ? entry.remaining : null;
  } catch {
    return null;
  }
}
