// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { describe, it, expect } from 'vitest';
import { buildLaneChain, streamCompletion, BYOK_PROVIDERS } from '../../src/ask/lanes.js';

describe('ask lanes: chain construction', () => {
  it('always ends with the three keyless lanes', () => {
    const names = buildLaneChain({}).map((l) => l.name);
    expect(names).toEqual(['llm7', 'pollinations', 'ovh']);
  });

  it('adds keyed free lanes ahead of the keyless ones', () => {
    const names = buildLaneChain({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k', CLOUDFLARE_AI_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }).map((l) => l.name);
    expect(names).toEqual(['groq', 'gemini', 'cloudflare', 'llm7', 'pollinations', 'ovh']);
  });

  it('a BYOK provider leads the chain and unknown providers are ignored', () => {
    expect(buildLaneChain({}, { byok: { provider: 'xai', apiKey: 'k' } })[0].name).toBe('byok:xai');
    expect(buildLaneChain({}, { byok: { provider: 'nope', apiKey: 'k' } })[0].name).toBe('llm7');
    for (const p of Object.values(BYOK_PROVIDERS)) expect(p.url).toMatch(/^https:\/\//);
  });
});

describe('ask lanes: live keyless completion', () => {
  it('streams an answer from a keyless lane with no env at all', async () => {
    const deltas = [];
    const lanes = [];
    const result = await streamCompletion(buildLaneChain({}), [{ role: 'user', content: 'Reply with exactly the word PONG.' }], {
      onDelta: (t) => deltas.push(t),
      onLane: (l) => lanes.push(l),
      maxTokens: 20,
    });
    expect(lanes.length).toBe(1);
    expect(result.text.toUpperCase()).toContain('PONG');
    expect(deltas.join('')).toBe(result.text);
  }, 90000);
});
