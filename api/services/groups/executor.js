// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group Task Executor
 *
 * Executes a single group task (like/comment/repost/follow) over HTTP using
 * the account's saved session cookie. Classifies outcomes so the worker can
 * decide: COMPLETED, retry-with-backoff (transient), reschedule (rate limit),
 * or FAILED (permanent — never retried).
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { TwitterHttpClient } from '../../../src/scrapers/twitter/http/client.js';
import {
  likeTweet,
  retweet,
  followByUsername,
} from '../../../src/scrapers/twitter/http/engagement.js';
import { replyToTweet } from '../../../src/scrapers/twitter/http/actions.js';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  TwitterApiError,
} from '../../../src/scrapers/twitter/http/errors.js';

/**
 * @typedef {Object} TaskOutcome
 * @property {boolean} ok
 * @property {'completed'|'retryable'|'rateLimit'|'permanent'} verdict
 * @property {string} [error]
 * @property {number} [retryAfterMs]  ms to wait before retrying/reschedule
 * @property {string} [result]
 */

/**
 * Execute one group task.
 *
 * @param {object} task - GroupTask row with `action`, `targetId`, and related
 *                        `member` (username) / `account` (sessionCookie).
 * @param {{ commentText?: string }} [options]
 * @returns {Promise<TaskOutcome>}
 */
export async function executeTask(task, options = {}) {
  const cookie = task.account?.sessionCookie;
  if (!cookie) {
    return { ok: false, verdict: 'permanent', error: 'Account has no session cookie' };
  }

  const memberUsername = task.member?.username;
  if (!memberUsername) {
    return { ok: false, verdict: 'permanent', error: 'Task has no member' };
  }

  let client;
  try {
    client = new TwitterHttpClient({ cookies: cookie, maxRetries: 1 });
  } catch (error) {
    return { ok: false, verdict: 'permanent', error: `Invalid cookie: ${error.message}` };
  }

  try {
    let result;
    switch (task.action) {
      case 'like':
        if (!task.targetId) {
          return { ok: false, verdict: 'permanent', error: 'Like task has no target tweet' };
        }
        result = await likeTweet(client, task.targetId);
        break;

      case 'repost':
        if (!task.targetId) {
          return { ok: false, verdict: 'permanent', error: 'Repost task has no target tweet' };
        }
        result = await retweet(client, task.targetId);
        break;

      case 'follow':
        result = await followByUsername(client, memberUsername);
        break;

      case 'comment': {
        if (!task.targetId) {
          return { ok: false, verdict: 'permanent', error: 'Comment task has no target tweet' };
        }
        const text = options.commentText || `Great post, @${memberUsername}!`;
        result = await replyToTweet(client, task.targetId, text);
        break;
      }

      default:
        return { ok: false, verdict: 'permanent', error: `Unknown action: ${task.action}` };
    }

    return {
      ok: result?.success !== false,
      verdict: 'completed',
      result: JSON.stringify(result),
    };
  } catch (error) {
    return classifyError(error);
  }
}

/** Map an X client error to a worker verdict. */
export function classifyError(error) {
  if (error instanceof RateLimitError) {
    return {
      ok: false,
      verdict: 'rateLimit',
      error: error.message,
      retryAfterMs: error.resetAt ? Math.max(error.resetAt - Date.now(), 1000) : 15 * 60 * 1000,
    };
  }

  if (error instanceof AuthError) {
    return { ok: false, verdict: 'permanent', error: `Authentication failed: ${error.message}` };
  }

  if (error instanceof NotFoundError) {
    return { ok: false, verdict: 'permanent', error: error.message };
  }

  if (error instanceof TwitterApiError) {
    const msg = (error.message || '').toLowerCase();
    // Permission/forbidden/blocked — permanent, no retry.
    if (msg.includes('forbidden') || msg.includes('permission') || msg.includes('blocked') ||
        msg.includes('not authorized') || msg.includes('suspended') || msg.includes('banned')) {
      return { ok: false, verdict: 'permanent', error: error.message };
    }
    // "Too many requests" without a proper RateLimitError — treat as rate limit.
    if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('flood')) {
      return { ok: false, verdict: 'rateLimit', error: error.message, retryAfterMs: 15 * 60 * 1000 };
    }
  }

  // Anything else (network, 5xx, unexpected shape) — transient, retryable.
  return { ok: false, verdict: 'retryable', error: error.message, retryAfterMs: 30_000 };
}
