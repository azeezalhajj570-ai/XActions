// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * xactions-edge: public X/Twitter reads from any JavaScript runtime.
 *
 * The XActions edge is an MCP server, which normally means you need an agent
 * framework to talk to it. This package is the other door: a plain client with
 * plain methods, zero dependencies, and no build step, that speaks the same
 * protocol underneath.
 *
 *   import { createClient } from 'xactions-edge';
 *   const x = createClient();
 *   const nasa = await x.profile('nasa');
 *
 * Runs unchanged in Node 18+, browsers, Cloudflare Workers, Deno and Bun. The
 * only requirement is `fetch`.
 *
 * @module xactions-edge
 * @author nichxbt
 * @see https://xactions.app/docs/mcp-remote
 */

export const DEFAULT_ENDPOINT = 'https://xactions.app/mcp';
export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_NAME = 'xactions-edge';
export const CLIENT_VERSION = '1.0.0';

/**
 * A call that failed. `code` is the JSON-RPC code for a protocol failure, or
 * `null` when the server ran the tool and the tool itself reported a problem
 * (a deleted post, a rate limit), which is the common case.
 */
export class XActionsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number|null, tool?: string|null, status?: number|null, retryable?: boolean }} [details]
   */
  constructor(message, { code = null, tool = null, status = null, retryable = false } = {}) {
    super(message);
    this.name = 'XActionsError';
    this.code = code;
    this.tool = tool;
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RATE_LIMIT_HINT = /rate.?limit|\b429\b/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Low-level Streamable HTTP client for an MCP server.
 *
 * Handshake happens once, lazily, on the first call and is then reused. The
 * server is stateless, so there is no session to keep alive and no socket to
 * reconnect: every call is one HTTP round trip.
 */
export class McpClient {
  /**
   * @param {object} [options]
   * @param {string} [options.endpoint] MCP endpoint URL.
   * @param {typeof fetch} [options.fetch] Custom fetch, for tests or proxies.
   * @param {number} [options.timeout] Per-request timeout in ms. Default 20000.
   * @param {number} [options.retries] Retries for retryable failures. Default 2.
   * @param {Record<string,string>} [options.headers] Extra request headers.
   */
  constructor({ endpoint = DEFAULT_ENDPOINT, fetch: fetchImpl, timeout = 20000, retries = 2, headers = {} } = {}) {
    this.endpoint = endpoint;
    this.timeout = timeout;
    this.retries = Math.max(0, retries);
    this.headers = headers;
    this.fetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    if (!this.fetch) {
      throw new XActionsError('No fetch available. Use Node 18+, or pass { fetch } explicitly.');
    }
    this.serverInfo = null;
    this._id = 0;
    this._ready = null;
  }

  /** @returns {number} */
  _nextId() {
    this._id += 1;
    return this._id;
  }

  /**
   * Send one JSON-RPC request and return its result.
   * @param {string} method
   * @param {object} [params]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<any>}
   */
  async request(method, params, { signal } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this._nextId(), method, ...(params ? { params } : {}) });

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await sleep(2 ** (attempt - 1) * 500);

      let response;
      try {
        response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTOCOL_VERSION,
            ...this.headers,
          },
          body,
          signal: signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(this.timeout) : undefined),
        });
      } catch (error) {
        lastError = new XActionsError(`Could not reach ${this.endpoint}: ${error.message}`, { retryable: true });
        continue;
      }

      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = new XActionsError(
          `${method} failed: HTTP ${response.status}`,
          { status: response.status, retryable },
        );
        if (!retryable) throw lastError;
        continue;
      }

      const payload = await response.json();
      if (payload?.error) {
        throw new XActionsError(payload.error.message || `${method} failed`, { code: payload.error.code });
      }
      return payload?.result;
    }

    throw lastError;
  }

  /**
   * Send a notification. Nothing comes back.
   * @param {string} method
   * @param {object} [params]
   */
  async notify(method, params) {
    await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION, ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    });
  }

  /**
   * Run the MCP handshake once and cache it.
   * @returns {Promise<object>} The server's `initialize` result.
   */
  async initialize() {
    if (!this._ready) {
      this._ready = this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      }).then(async (result) => {
        this.serverInfo = result;
        await this.notify('notifications/initialized').catch(() => {});
        return result;
      });
      this._ready.catch(() => {
        this._ready = null;
      });
    }
    return this._ready;
  }

  /** @returns {Promise<Array<object>>} */
  async listTools(options) {
    await this.initialize();
    return (await this.request('tools/list', {}, options)).tools;
  }

  /**
   * Call a tool and return its structured output.
   *
   * A tool that fails answers with `isError`, not a protocol error, so this
   * turns that into a thrown `XActionsError` carrying the tool's own wording.
   *
   * @param {string} name
   * @param {object} [args]
   * @param {{ signal?: AbortSignal, raw?: boolean }} [options] `raw: true` returns the full MCP result.
   * @returns {Promise<any>}
   */
  async call(name, args = {}, options = {}) {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args }, options);
    if (options.raw) return result;
    if (result?.isError) {
      const message = result.content?.map((part) => part.text).filter(Boolean).join('\n') || `${name} failed`;
      throw new XActionsError(message, { tool: name, retryable: RATE_LIMIT_HINT.test(message) });
    }
    return result?.structuredContent ?? result?.content?.map((part) => part.text).join('\n') ?? null;
  }

  /** @returns {Promise<Array<object>>} */
  async listPrompts(options) {
    await this.initialize();
    return (await this.request('prompts/list', {}, options)).prompts;
  }

  /**
   * @param {string} name
   * @param {Record<string,string>} [args]
   * @returns {Promise<{description: string, messages: Array<object>}>}
   */
  async getPrompt(name, args = {}, options) {
    await this.initialize();
    return this.request('prompts/get', { name, arguments: args }, options);
  }

  /**
   * List documentation resources, following pagination to the end.
   * @returns {Promise<Array<object>>}
   */
  async listResources(options) {
    await this.initialize();
    const all = [];
    let cursor;
    do {
      const page = await this.request('resources/list', cursor ? { cursor } : {}, options);
      all.push(...(page.resources || []));
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  /**
   * @param {string} uri
   * @returns {Promise<string>} The resource body as markdown.
   */
  async readResource(uri, options) {
    await this.initialize();
    const result = await this.request('resources/read', { uri }, options);
    return result.contents?.map((entry) => entry.text).join('\n\n') ?? '';
  }
}

/**
 * The friendly client. Every method is one MCP tool call, unwrapped to the data
 * you actually wanted.
 */
export class XActions {
  /**
   * @param {ConstructorParameters<typeof McpClient>[0]} [options]
   */
  constructor(options = {}) {
    this.mcp = new McpClient(options);
  }

  /**
   * Public profile for an account.
   * @param {string} handle Handle, @handle, or profile URL.
   * @returns {Promise<object>}
   */
  async profile(handle, options) {
    return (await this.mcp.call('x_profile', { handle }, options)).profile;
  }

  /**
   * Recent posts from an account, newest first.
   * @param {string} handle
   * @param {{ limit?: number }} [params]
   * @returns {Promise<Array<object>>}
   */
  async posts(handle, { limit } = {}, options) {
    return (await this.mcp.call('x_posts', { handle, ...(limit ? { limit } : {}) }, options)).posts;
  }

  /**
   * One post in full.
   * @param {string} post Post ID or status URL.
   * @returns {Promise<object>}
   */
  async post(post, options) {
    return (await this.mcp.call('x_post', { post }, options)).post;
  }

  /**
   * The conversation around a post, in order.
   * @param {string} post
   * @param {{ limit?: number }} [params]
   * @returns {Promise<{focal: object, posts: Array<object>, author: object, truncated: boolean}>}
   */
  async thread(post, { limit } = {}, options) {
    return this.mcp.call('x_thread', { post, ...(limit ? { limit } : {}) }, options);
  }

  /**
   * Downloadable MP4 variants for a post, best quality first.
   * @param {string} post
   * @returns {Promise<{videos: Array<object>, thumbnail: string|null, username: string, tweetId: string}>}
   */
  async video(post, options) {
    return this.mcp.call('x_video', { post }, options);
  }

  /**
   * The best download link for a post's video, ready to hand to a browser or a
   * file writer.
   * @param {string} post
   * @returns {Promise<string>}
   */
  async videoUrl(post, options) {
    const { videos } = await this.video(post, options);
    if (!videos?.length) throw new XActionsError('This post has no video.', { tool: 'x_video' });
    return videos[0].downloadUrl || videos[0].url;
  }

  /**
   * Search the XActions documentation, skills and browser scripts.
   * @param {string} query
   * @param {{ limit?: number }} [params]
   * @returns {Promise<Array<{title: string, url: string, text: string}>>}
   */
  async docs(query, { limit } = {}, options) {
    return (await this.mcp.call('xactions_docs', { query, ...(limit ? { limit } : {}) }, options)).results;
  }

  /** @returns {Promise<Array<object>>} Every tool the server exposes. */
  tools(options) {
    return this.mcp.listTools(options);
  }

  /** @returns {Promise<object>} The server's identity and instructions. */
  async info() {
    return this.mcp.initialize();
  }
}

/**
 * Create a client.
 * @param {ConstructorParameters<typeof McpClient>[0]} [options]
 * @returns {XActions}
 */
export function createClient(options) {
  return new XActions(options);
}

export default createClient;
