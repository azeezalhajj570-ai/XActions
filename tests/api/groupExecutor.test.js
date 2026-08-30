// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Group task executor unit tests.
 *
 * Mirrors the tests/http-scraper/engagement.test.js pattern: mock fetch,
 * drive the executor, and assert the request shapes + outcome classification.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { executeTask, classifyError } = await import('../../api/services/groups/executor.js');
const { RateLimitError, AuthError, NotFoundError, TwitterApiError } = await import('../../src/scrapers/twitter/http/errors.js');

function makeTask(overrides = {}) {
  return {
    id: 't1',
    groupId: 'g1',
    accountId: 'a1',
    memberId: 'm1',
    action: 'like',
    targetId: '1234567890',
    account: { id: 'a1', username: 'acc1', sessionCookie: 'auth_token=abc; ct0=xyz' },
    member: { id: 'm1', username: 'elonmusk' },
    ...overrides,
  };
}

function mockResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] || null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('executeTask', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => mockResponse({ data: { favorite_tweet: 'ok' } }, { status: 200 }));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('like task performs a GraphQL Like mutation', async () => {
    const task = makeTask({ action: 'like' });
    const outcome = await executeTask(task);
    expect(outcome.ok).toBe(true);
    expect(outcome.verdict).toBe('completed');
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0];
    expect(String(url)).toContain('graphql');
  });

  it('follow task resolves the username then follows', async () => {
    // UserByScreenName query → follow mutation
    fetchMock
      .mockResolvedValueOnce(mockResponse({ data: { user: { result: { rest_id: 'u987' } } } }))
      .mockResolvedValueOnce(mockResponse({ data: { favorite_tweet: 'ok' } }, { status: 200 }));
    const task = makeTask({ action: 'follow' });
    const outcome = await executeTask(task);
    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('comment task posts a reply to the target tweet', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ data: { create_tweet: 'ok' } }));
    const task = makeTask({ action: 'comment' });
    const outcome = await executeTask(task, { commentText: 'Nice post!' });
    expect(outcome.ok).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('graphql');
  });

  it('treats already-favorited as idempotent success', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ errors: [{ message: 'You have already favorited this tweet' }] }));
    const outcome = await executeTask(makeTask({ action: 'like' }));
    expect(outcome.ok).toBe(true);
    expect(outcome.verdict).toBe('completed');
  });

  it('classifies RateLimitError as rateLimit with a reschedule window', async () => {
    const resetAt = new Date(Date.now() + 600_000);
    const err = new RateLimitError('Rate limited', { resetAt });
    const outcome = classifyError(err);
    expect(outcome.verdict).toBe('rateLimit');
    expect(outcome.retryAfterMs).toBeGreaterThan(0);
  });

  it('classifies AuthError as permanent (no retry)', async () => {
    const outcome = classifyError(new AuthError('Bad cookie'));
    expect(outcome.verdict).toBe('permanent');
  });

  it('classifies NotFoundError as permanent', async () => {
    const outcome = classifyError(new NotFoundError('User not found'));
    expect(outcome.verdict).toBe('permanent');
  });

  it('classifies TwitterApiError with forbidden as permanent', async () => {
    const outcome = classifyError(new TwitterApiError('Forbidden: you are blocked'));
    expect(outcome.verdict).toBe('permanent');
  });

  it('classifies unknown errors as retryable', async () => {
    const outcome = classifyError(new Error('ECONNRESET'));
    expect(outcome.verdict).toBe('retryable');
    expect(outcome.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns permanent failure when the account has no session cookie', async () => {
    const outcome = await executeTask(makeTask({ account: { id: 'a1', username: 'acc1', sessionCookie: null } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.verdict).toBe('permanent');
  });
});
