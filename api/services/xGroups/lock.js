// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Per-conversation sync lock.
 *
 * Prevents two workers from syncing the same X Group DM conversation at the
 * same time. Key: `x_group_member_sync:{conversationId}` with a TTL so a
 * crashed worker does not deadlock future syncs.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import Redis from 'ioredis';

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOCK_PREFIX = 'x_group_member_sync';

let _redis = null;

function redis() {
  if (!_redis) {
    _redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    // Avoid crashing the worker on transient Redis errors; the lock just
    // fails open (sync proceeds) rather than blocking the job.
    _redis.on('error', () => {});
  }
  return _redis;
}

const lockKey = (conversationId) => `${LOCK_PREFIX}:${conversationId}`;

/**
 * Acquire the sync lock for a conversation.
 *
 * @param {string} conversationId
 * @returns {Promise<string|null>} token on success, null when already held
 */
export async function acquireSyncLock(conversationId) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const r = redis();
    if (r.status === 'wait' || r.status === 'end') {
      await r.connect().catch(() => {});
    }
    const ok = await r.set(lockKey(conversationId), token, 'PX', LOCK_TTL_MS, 'NX');
    return ok ? token : null;
  } catch {
    // Fail open: without Redis we cannot coordinate, so allow the sync.
    return token;
  }
}

/**
 * Release the sync lock if we still hold it.
 *
 * @param {string} conversationId
 * @param {string} token
 */
export async function releaseSyncLock(conversationId, token) {
  try {
    const r = redis();
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end`;
    await r.eval(script, 1, lockKey(conversationId), token);
  } catch { /* already gone */ }
}

/** For tests: close the shared client. */
export async function closeSyncLock() {
  if (_redis) {
    try { await _redis.quit(); } catch { /* noop */ }
    _redis = null;
  }
}
