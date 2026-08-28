// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * POST /api/ai/scrape/tweets  ($0.005 in USDC, Solana or Base)
 *
 * Body: `{ "username": "nasa", "limit": 20 }`. Returns the account's recent
 * public posts with engagement counts, media (including direct mp4 URLs for
 * video), quoted posts, and the cursor for the next page.
 *
 * No API key and no account: an unpaid call answers 402 with the terms. See
 * docs/x402.md.
 *
 * @author nichxbt
 */

import { getTweets, normalizeHandle, statusForError } from '../../../../src/edge/twitterClient.js';
import { withX402 } from '../../../../src/edge/x402.js';
import { findPaidResource } from '../../../../src/edge/paidResources.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../../../src/video/edgeHttp.js';

const RESOURCE = findPaidResource('/api/ai/scrape/tweets');

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request }) {
  return jsonResponse(
    { error: 'method_not_allowed', message: 'POST a { username, limit } body to this endpoint.' },
    405,
    corsHeaders(request),
  );
}

export const onRequestPost = withX402(
  { price: RESOURCE.price, description: RESOURCE.description },
  async ({ request, payment }) => {
    const cors = corsHeaders(request);

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const handle = normalizeHandle(body?.username ?? body?.handle ?? body?.url);
    if (!handle) {
      return jsonResponse(
        { error: 'INVALID_INPUT', message: 'username is required: a handle, @handle, or profile URL.' },
        400,
        cors,
      );
    }

    try {
      const { user, tweets, cursor } = await getTweets(handle, { limit: body?.limit });
      return jsonResponse(
        {
          user: user ? { id: user.id, username: user.username, name: user.name } : null,
          tweets,
          cursor,
          paidBy: payment?.payer ?? null,
          network: payment?.requirements?.network ?? null,
        },
        200,
        cors,
      );
    } catch (error) {
      return jsonResponse(
        { error: error.name || 'SCRAPE_FAILED', message: error.message },
        statusForError(error),
        cors,
      );
    }
  },
);
