// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /api/ai/pricing
 *
 * Per-operation USDC prices for the AI API, read from the same table the x402
 * payment gate charges against, so the published price and the charged price
 * cannot drift apart.
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
  return jsonResponse({ pricing: api.AI_OPERATION_PRICES }, 200, corsHeaders(request));
}
