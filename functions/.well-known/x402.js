// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /.well-known/x402
 *
 * x402 discovery: the machine-readable list of paid resources, their prices and
 * the address to pay. This is how an agent finds the XActions AI API without a
 * human in the loop, so it belongs on the edge alongside /openapi.json.
 *
 * @author nichxbt
 */

import { loadApiModules } from '../../src/edge/apiModules.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../src/video/edgeHttp.js';

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request, env }) {
  const api = await loadApiModules(env);
  return jsonResponse(api.generateWellKnown(), 200, corsHeaders(request));
}
