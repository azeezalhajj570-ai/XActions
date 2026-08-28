// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /openapi.json
 *
 * The OpenAPI 3.1 description of the XActions AI API. Agents and tool
 * generators read this to discover the endpoints and their prices, so it has to
 * answer on the deployed site, not only on a self-hosted Node server.
 *
 * @author nichxbt
 */

import { loadApiModules } from '../src/edge/apiModules.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../src/video/edgeHttp.js';

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request, env }) {
  const api = await loadApiModules(env);
  return jsonResponse(api.generateSpec(), 200, corsHeaders(request));
}
