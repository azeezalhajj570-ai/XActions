// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { pendingSessions } from '../realtime/socketHandler.js';

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
 * server secret. The body also carries the X account detected on the tab so
 * the dashboard can show who is connected.
 *
 * Body: { pairingCode, username, displayName?, profileUrl?, avatar? }
 */
router.post('/claim', async (req, res) => {
  const { pairingCode, username, displayName, profileUrl, avatar } = req.body || {};

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

  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'X account username is required' });
  }

  // Mark the code claimed so a second HTTP claim is refused. The entry stays
  // in the map: the agent's socket connection consumes it as the final step.
  entry.claimed = true;

  // Remember the X account on the user record so the dashboard can show it.
  const cleanUsername = username.trim().replace(/^@/, '');
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
  });
});

export default router;
