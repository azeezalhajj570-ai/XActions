// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /api/ai/health
 *
 * Whether the AI API is answering and whether x402 payment is configured for
 * this deployment, including the facilitator and the pay-to address an agent
 * would settle against.
 *
 * @author nichxbt
 */

import { loadApiModules } from '../../../src/edge/apiModules.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../../src/video/edgeHttp.js';

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request, env }) {
  const api = await loadApiModules(env);
  return jsonResponse(
    {
      service: 'XActions AI API',
      status: 'operational',
      runtime: 'cloudflare-pages-functions',
      timestamp: new Date().toISOString(),
      x402: {
        enabled: api.isX402Configured(),
        version: 2,
        facilitator: api.FACILITATOR_URL,
        payTo: api.PAY_TO_ADDRESS,
      },
    },
    200,
    corsHeaders(request),
  );
}
