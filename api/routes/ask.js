// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Ask XActions API
 *
 *   POST /api/ask          { question, history?, byok? }  -> text/event-stream
 *   GET  /api/ask/health                                  -> index + lane status
 *
 * Retrieval runs over dashboard/data/ask-index.json (built by
 * `npm run ask:index`), the answer streams through the free LLM chain in
 * src/ask/lanes.js. Server-Sent Events, one JSON object per `data:` line:
 * sources, lane, delta, done, error.
 *
 * @module api/routes/ask
 */

import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, createSearcher, SUGGESTED_QUESTIONS } from '../../src/ask/engine.js';
import { buildLaneChain } from '../../src/ask/lanes.js';

const router = express.Router();
const INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dashboard/data/ask-index.json');

let searcherPromise = null;
function getSearcher() {
  if (!searcherPromise) {
    searcherPromise = readFile(INDEX_PATH, 'utf8').then((raw) => {
      const index = JSON.parse(raw);
      return { searcher: createSearcher(index), digest: index.digest, counts: index.counts };
    });
    searcherPromise.catch(() => { searcherPromise = null; });
  }
  return searcherPromise;
}

router.get('/health', async (req, res) => {
  try {
    const { searcher, digest, counts } = await getSearcher();
    res.set('cache-control', 'no-store').json({
      status: 'ok',
      index: { chunks: searcher.size, digest, counts },
      lanes: buildLaneChain(process.env).map((l) => l.name),
      suggested: SUGGESTED_QUESTIONS,
    });
  } catch (error) {
    res.status(503).json({ status: 'error', message: `ask index unavailable: ${error.message}. Run npm run ask:index.` });
  }
});

router.post('/', async (req, res) => {
  const { question, history, byok } = req.body || {};
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'question is required' });
  }
  let searcher;
  try {
    ({ searcher } = await getSearcher());
  } catch (error) {
    return res.status(503).json({ error: 'INDEX_UNAVAILABLE', message: error.message });
  }

  res.status(200).set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    await ask({
      question,
      history: Array.isArray(history) ? history : [],
      searcher,
      env: process.env,
      byok: byok && typeof byok === 'object' ? byok : undefined,
      onEvent: send,
      signal: controller.signal,
    });
  } catch (error) {
    send({ type: 'error', message: error.message });
  } finally {
    res.end();
  }
});

export default router;
