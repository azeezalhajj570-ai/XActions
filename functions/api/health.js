// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /api/health
 *
 * Health of the edge API surface that xactions.app actually serves. It reports
 * which endpoints answer at the edge and whether a full Node backend origin is
 * configured, so /status shows the truth instead of guessing from a 404.
 *
 * @author nichxbt
 */

import { corsHeaders, jsonResponse, preflightResponse } from '../../src/video/edgeHttp.js';

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request, env }) {
  return jsonResponse({
    status: 'ok',
    runtime: 'cloudflare-pages-functions',
    edgeEndpoints: [
      'GET /api/health',
      'POST /api/video/extract',
      'POST /api/video/extract-form',
      'GET /api/video/download',
    ],
    originConfigured: Boolean(env.XACTIONS_API_ORIGIN),
    timestamp: new Date().toISOString(),
  }, 200, corsHeaders(request));
}
