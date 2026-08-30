// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * XActions Accounts API Routes
 *
 * Linked X accounts (one per saved session cookie) that can be attached to
 * groups for group automation. Session cookies are validated at creation and
 * never returned in full to the client — only a `hasCookie` flag is exposed.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import { TwitterHttpClient } from '../../src/scrapers/twitter/http/client.js';
import { AuthError } from '../../src/scrapers/twitter/http/errors.js';

const prisma = new PrismaClient();
const router = Router();

router.use(authenticate);

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Strip @ and validate an X username. Returns null if invalid. */
function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

/**
 * Lightweight session-cookie validation: perform an authenticated call and
 * resolve the account's own username/id. Rejects invalid cookies with an
 * AuthError so callers can surface a permanent failure (no retry loop).
 *
 * @param {string} cookieString
 * @returns {Promise<{ username: string, twitterId: string }>}
 */
async function validateSessionCookie(cookieString) {
  const client = new TwitterHttpClient({ cookies: cookieString, maxRetries: 0 });
  const response = await client.graphql(
    'oKJZqMkGz6Kq8ZDdK2zBPA',
    'Viewer',
    {},
    {},
  );
  const user = response?.data?.viewer?.user?.result;
  if (!user?.rest_id || !user?.legacy?.screen_name) {
    throw new AuthError('Invalid session cookie — could not resolve account');
  }
  return { username: user.legacy.screen_name.toLowerCase(), twitterId: user.rest_id };
}

/** Mask a session cookie for API responses. */
function maskCookie(cookieString) {
  if (!cookieString) return null;
  const hasAuth = /auth_token=[^;]+/.test(cookieString);
  const hasCt0 = /ct0=[^;]+/.test(cookieString);
  if (!hasAuth) return null;
  return `${hasAuth ? 'auth_token=***' : ''}${hasCt0 ? '; ct0=***' : ''}`;
}

function serializeAccount(account, { includeCookie = false } = {}) {
  const { sessionCookie, ...rest } = account;
  return {
    ...rest,
    hasCookie: Boolean(sessionCookie && /auth_token=[^;]+/.test(sessionCookie)),
    ...(includeCookie ? { sessionCookie: maskCookie(sessionCookie) } : {}),
  };
}

// GET /api/accounts
router.get('/', async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ accounts: accounts.map((a) => serializeAccount(a)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/accounts  { username?, sessionCookie }
router.post('/', async (req, res) => {
  try {
    const { sessionCookie } = req.body || {};
    if (typeof sessionCookie !== 'string' || !/auth_token=[^;]+/.test(sessionCookie)) {
      return res.status(400).json({ error: 'A valid session cookie with auth_token is required' });
    }

    // Validate the cookie and resolve the account's username/id.
    let verified;
    try {
      verified = await validateSessionCookie(sessionCookie);
    } catch (error) {
      const status = error instanceof AuthError ? 400 : 502;
      return res.status(status).json({ error: `Cookie validation failed: ${error.message}` });
    }

    const username = cleanUsername(req.body?.username || verified.username);
    if (!username) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const account = await prisma.account.upsert({
      where: { userId_username: { userId: req.user.id, username } },
      update: {
        sessionCookie,
        isActive: true,
        isBlocked: false,
        authMethod: 'session',
      },
      create: {
        userId: req.user.id,
        username,
        sessionCookie,
        authMethod: 'session',
      },
    });

    res.json({ account: serializeAccount(account) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/accounts/:id
router.get('/:id', async (req, res) => {
  try {
    const account = await prisma.account.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ account: serializeAccount(account) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/accounts/:id  { isActive?, sessionCookie? }
router.patch('/:id', async (req, res) => {
  try {
    const account = await prisma.account.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const data = {};
    if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive;
    if (typeof req.body?.sessionCookie === 'string' && /auth_token=[^;]+/.test(req.body.sessionCookie)) {
      data.sessionCookie = req.body.sessionCookie;
      try {
        const verified = await validateSessionCookie(req.body.sessionCookie);
        data.isBlocked = false;
        if (!data.username) data.username = verified.username;
      } catch (error) {
        return res.status(400).json({ error: `Cookie validation failed: ${error.message}` });
      }
    }

    const updated = await prisma.account.update({
      where: { id: account.id },
      data,
    });
    res.json({ account: serializeAccount(updated) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', async (req, res) => {
  try {
    const account = await prisma.account.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Remove group links first, then the account (tasks cascade).
    await prisma.groupAccount.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
