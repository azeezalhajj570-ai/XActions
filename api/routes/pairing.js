// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { pendingSessions } from '../realtime/socketHandler.js';
import { validateSessionCookie } from './accounts.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/pairing/info
 * Lets the extension auto-configure its backend URL and confirm pairing is available.
 */
router.get('/info', (req, res) => {
  res.json({
    enabled: true,
    backendUrl: process.env.API_URL || 'http://localhost:3001',
  });
});

/**
 * POST /api/pairing/claim
 * The extension claims a dashboard session with the pairing code the dashboard
 * received over its socket. The code is short-lived (10 min) and single-use,
 * so it is the bearer credential — the extension never holds a JWT or any
 * server secret. The body carries the X session cookie (when available) and
 * the account the extension detected; the backend validates the cookie and
 * resolves the authoritative username itself, so a browser that cannot reach
 * x.com from the extension context still pairs correctly.
 *
 * Body: { pairingCode, sessionCookie?, username?, displayName?, profileUrl?, avatar? }
 */
router.post('/claim', async (req, res) => {
  const { pairingCode, sessionCookie, username, displayName, profileUrl, avatar } = req.body || {};

  if (!pairingCode || typeof pairingCode !== 'string') {
    return res.status(400).json({ error: 'pairingCode is required' });
  }

  const code = String(pairingCode).trim().toUpperCase();
  const entry = pendingSessions.get(code);

  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) pendingSessions.delete(code);
    return res.status(400).json({ error: 'Invalid or expired pairing code' });
  }

  if (entry.claimed) {
    return res.status(400).json({ error: 'Pairing code already used' });
  }

  // Resolve the authoritative account from the session cookie when present.
  let resolvedUsername = '';
  let verified = false;
  if (typeof sessionCookie === 'string' && /auth_token=[^;]+/.test(sessionCookie)) {
    const hasCt0 = /ct0=[^;]+/.test(sessionCookie);
    console.log(`[pairing] claim ${code}: cookie received (auth_token ✓, ct0 ${hasCt0 ? '✓' : '✗'}, len ${sessionCookie.length})`);
    try {
      const info = await validateSessionCookie(sessionCookie);
      resolvedUsername = (info?.username || '').trim().replace(/^@/, '');
      verified = Boolean(resolvedUsername);
    } catch (err) {
      console.warn('⚠️ Pairing claim: cookie validation failed:', err?.message);
    }
  } else {
    console.log(`[pairing] claim ${code}: no valid sessionCookie in body (${typeof sessionCookie})`);
  }

  const cleanUsername = (resolvedUsername || username || '').trim().replace(/^@/, '');
  if (!cleanUsername) {
    return res.status(400).json({ error: 'X account username is required' });
  }

  // Mark the code claimed so a second HTTP claim is refused. The entry stays
  // in the map: the agent's socket connection consumes it as the final step.
  entry.claimed = true;

  // Remember the X account on the user record so the dashboard can show it.
  try {
    await prisma.user.update({
      where: { id: entry.userId },
      data: { twitterUsername: cleanUsername },
    });
  } catch (error) {
    // Non-fatal: the pairing itself still succeeds without the DB update.
    console.warn('⚠️ Pairing claim: could not update twitterUsername:', error.message);
  }

  res.json({
    success: true,
    sessionId: entry.sessionId,
    backendUrl: process.env.API_URL || 'http://localhost:3001',
    username: cleanUsername,
    displayName: verified ? displayName || cleanUsername : (displayName || undefined),
    verified,
  });
});

export default router;
