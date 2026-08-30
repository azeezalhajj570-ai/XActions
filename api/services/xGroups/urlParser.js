// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM URL parser.
 *
 * Resolves a group-chat URL (https://x.com/i/chat/g<digits>) — or a raw
 * conversation ID — into a normalized `g...` conversation ID.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

export class InvalidGroupUrlError extends Error {
  constructor(message = 'Invalid X Group DM URL') {
    super(message);
    this.name = 'InvalidGroupUrlError';
    this.code = 'INVALID_GROUP_URL';
  }
}

// Matches the /i/chat/g<digits> path on x.com or twitter.com (with or
// without trailing slash / query string), or a bare g<digits> id.
const GROUP_CHAT_RE = /(?:^|\/)(g\d{6,})(?:\/|$|\?|#)/;

// Bare raw-ID form: exactly "g" followed by digits (6+ to avoid noise).
const RAW_ID_RE = /^g\d{6,}$/;

/**
 * Parse a URL or raw ID into a group DM conversation ID.
 *
 * @param {string} input
 * @returns {{ conversationId: string }}
 * @throws {InvalidGroupUrlError} when the input is not a group chat URL
 */
export function parseXGroupUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new InvalidGroupUrlError('URL is required');

  // Bare raw ID form.
  if (RAW_ID_RE.test(raw)) {
    return { conversationId: raw };
  }

  // URL form — require an actual x.com/twitter.com host to avoid treating
  // arbitrary paths as group chats.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidGroupUrlError(`Not a valid URL: ${raw}`);
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'x.com' && host !== 'twitter.com') {
    throw new InvalidGroupUrlError(`Not an x.com URL: ${raw}`);
  }

  const match = GROUP_CHAT_RE.exec(parsed.pathname);
  if (!match) {
    throw new InvalidGroupUrlError(`Not an X Group DM URL: ${raw}`);
  }

  return { conversationId: match[1] };
}
