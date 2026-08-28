// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * POST /api/ai/scrape/profile  ($0.001 in USDC, Solana or Base)
 *
 * Body: `{ "username": "nasa" }`. A handle, an @handle or a profile URL all
 * work. Returns the full public profile: id, name, bio with t.co links
 * expanded, location, website, join date, follower and following counts, post
 * and like counts, avatar, banner, verification, pinned post id.
 *
 * There is no API key and no account. An unpaid call answers 402 with the terms;
 * pay and retry, and the payer's address is the only identity involved. See
 * docs/x402.md.
 *
 * @author nichxbt
 */

import { getProfile, normalizeHandle, statusForError } from '../../../../src/edge/twitterClient.js';
import { withX402 } from '../../../../src/edge/x402.js';
import { findPaidResource } from '../../../../src/edge/paidResources.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../../../src/video/edgeHttp.js';

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request }) {
  return jsonResponse(
    { error: 'method_not_allowed', message: 'POST a { username } body to this endpoint.' },
    405,
    corsHeaders(request),
  );
}

const RESOURCE = findPaidResource('/api/ai/scrape/profile');

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
      const profile = await getProfile(handle);
      return jsonResponse(
        { profile, paidBy: payment?.payer ?? null, network: payment?.requirements?.network ?? null },
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
