// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM member extractor.
 *
 * Given an authenticated TwitterHttpClient and a group conversation ID
 * (g<digits>), fetches every accessible participant by paginating the
 * v1.1 conversation timeline and reading the `users` map the endpoint
 * returns alongside the entries (the response is requested with
 * dm_users=true). Falls back to an inbox scan for legacy conversation
 * shapes that do not return a users map.
 *
 * This module only discovers members — it never executes actions.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { REST_BASE } from '../../../src/scrapers/twitter/http/endpoints.js';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  NetworkError,
} from '../../../src/scrapers/twitter/http/errors.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 200; // hard safety cap — never loop forever

/**
 * Build the query-string params the web client uses for conversation reads.
 * `dm_users=true` is what makes the endpoint include the `users` map.
 */
function conversationParams(cursor) {
  const params = new URLSearchParams({
    include_profile_interstitial_type: '1',
    include_blocking: '1',
    include_blocked_by: '1',
    include_followed_by: '1',
    include_want_retweets: '1',
    include_mute_edge: '1',
    include_can_dm: '1',
    include_can_media_tag: '1',
    include_ext_has_nft_avatar: '1',
    skip_status: '1',
    cards_platform: 'Web-12',
    include_cards: '1',
    include_ext_alt_text: 'true',
    include_quote_count: 'true',
    include_reply_count: '1',
    tweet_mode: 'extended',
    include_ext_media_color: 'true',
    supports_reactions: 'true',
    dm_users: 'true',
    include_groups: 'true',
    include_inbox_timelines: 'true',
    ext: 'mediaColor,altText,mediaStats,highlightedLabel,voiceInfo',
    count: String(PAGE_SIZE),
  });
  if (cursor) params.set('max_id', cursor);
  return params.toString();
}

/**
 * Normalize one raw user object from the `users` map into a member.
 */
export function normalizeMember(uid, rawUser) {
  if (!uid || !rawUser) return null;
  const username = rawUser.screen_name || rawUser.username || rawUser.screenName || '';
  if (!username) return null;
  return {
    xUserId: String(uid),
    username,
    displayName: rawUser.name || rawUser.displayName || '',
    profileUrl: `https://x.com/${username}`,
    avatarUrl: rawUser.profile_image_url_https || rawUser.avatar || '',
    isAdmin: !!(rawUser.is_admin || rawUser.isAdmin),
    verified: !!(rawUser.verified || rawUser.is_blue_verified || rawUser.ext_verified),
  };
}

/**
 * Pull member objects out of a conversation-timeline response.
 *
 * @param {object} response - raw v1.1 conversation response
 * @returns {Array<object|null>} normalized members (may contain nulls)
 */
export function parseConversationUsers(response) {
  const users = response?.users ?? {};
  const timeline = response?.conversation_timeline ?? response ?? {};

  const members = [];

  // 1. The `users` map — the authoritative participant source.
  for (const [uid, u] of Object.entries(users)) {
    const member = normalizeMember(uid, u);
    if (member) members.push(member);
  }

  // 2. Any explicit participants array on the conversation timeline.
  const participants = timeline.participants ?? timeline.conversation?.participants ?? [];
  if (Array.isArray(participants)) {
    for (const p of participants) {
      const uid = p?.user_id ?? p?.userId ?? p?.id;
      const member = normalizeMember(uid, p);
      if (member) members.push(member);
    }
  }

  // 3. Sender IDs from entries that are not already in the users map (a
  //    member who never shows in `users` but sent a message).
  const entries = timeline.entries ?? [];
  for (const entry of entries) {
    const senderId = entry?.message?.sender_id ?? entry?.sender_id;
    if (!senderId) continue;
    const existing = members.some((m) => m && m.xUserId === String(senderId));
    if (!existing) {
      // No user object — emit a minimal member so the id is not lost.
      members.push({
        xUserId: String(senderId),
        username: '',
        displayName: '',
        profileUrl: '',
        avatarUrl: '',
        isAdmin: false,
        verified: false,
      });
    }
  }

  return members.filter(Boolean);
}

/**
 * Paginate the conversation timeline until no cursor remains.
 *
 * @param {object} client - authenticated TwitterHttpClient
 * @param {string} conversationId
 * @param {object} [options]
 * @param {function} [options.onProgress] - called with { processed, page }
 * @returns {Promise<{ members: object[], cursor: string|null, pages: number }>}
 */
export async function fetchConversationMembers(client, conversationId, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const url = `${REST_BASE}/1.1/dm/conversation/${conversationId}.json`;

  const seen = new Map();
  let cursor = null;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) break;

    const query = conversationParams(cursor);
    let response;
    try {
      response = await client.request(`${url}?${query}`, { method: 'GET' });
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (err instanceof AuthError) throw err;
      if (err instanceof NotFoundError) throw err;
      if (err?.status === 403) throw new AuthError('No access to this conversation', { status: 403 });
      if (err?.status === 404) throw new NotFoundError('Conversation not found', { status: 404 });
      if (err?.status === 429) {
        throw new RateLimitError('Rate limited fetching conversation', {
          status: 429,
          resetAt: err?.data?.resetAt || null,
        });
      }
      if (err instanceof NetworkError || err?.type === 'network') throw err;
      throw new NetworkError(err?.message || 'Network error fetching conversation');
    }

    const pageMembers = parseConversationUsers(response);
    for (const m of pageMembers) {
      if (m.username) {
        seen.set(m.xUserId, m); // keep the richest record by user id
      }
    }

    pages += 1;
    onProgress({ processed: seen.size, page: pages });

    const timeline = response?.conversation_timeline ?? response ?? {};
    cursor = timeline.min_entry_id || timeline.cursor || null;
    if (!cursor) break;
  }

  return { members: [...seen.values()], cursor, pages };
}

/**
 * Fall back to scanning the DM inbox for the conversation and reading its
 * participant map, when the conversation endpoint returned no users.
 *
 * @param {object} client - authenticated TwitterHttpClient
 * @param {string} conversationId
 * @returns {Promise<object[]>} normalized members
 */
export async function fetchInboxParticipants(client, conversationId) {
  const url = `${REST_BASE}/1.1/dm/inbox_initial_state.json`;
  const seen = new Map();
  let cursor = null;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) break;

    const params = new URLSearchParams({
      dm_users: 'true',
      include_groups: 'true',
      include_inbox_timelines: 'true',
      supports_reactions: 'true',
      count: '50',
    });
    if (cursor) params.set('cursor', cursor);

    let response;
    try {
      response = await client.request(`${url}?${params.toString()}`, { method: 'GET' });
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (err instanceof AuthError) throw err;
      if (err?.status === 429) {
        throw new RateLimitError('Rate limited fetching inbox', { status: 429, resetAt: err?.data?.resetAt || null });
      }
      if (err?.status === 403) throw new AuthError('No access to inbox', { status: 403 });
      if (err?.status === 404) throw new NotFoundError('Inbox not found', { status: 404 });
      throw new NetworkError(err?.message || 'Network error fetching inbox');
    }

    const state = response?.inbox_initial_state ?? response ?? {};
    const conversations = state.conversations ?? {};
    const users = state.users ?? {};

    // Found the target conversation — collect its participants.
    if (conversations[conversationId]) {
      const conv = conversations[conversationId];
      const participantIds = Object.keys(conv.participants ?? {});
      for (const uid of participantIds) {
        const member = normalizeMember(uid, users[uid] ?? {});
        if (member) seen.set(member.xUserId, member);
      }
      // Some responses list participants as an array instead.
      if (Array.isArray(conv.participants)) {
        for (const p of conv.participants) {
          const uid = p?.user_id ?? p?.id;
          const member = normalizeMember(uid, p);
          if (member) seen.set(member.xUserId, member);
        }
      }
      if (seen.size > 0) break;
    }

    cursor = state.entries?.cursor || state.cursor || null;
    if (!cursor) break;
    pages += 1;
  }

  return [...seen.values()];
}

/**
 * Extract every accessible member of a group DM conversation.
 *
 * @param {object} options
 * @param {object} options.client - authenticated TwitterHttpClient
 * @param {string} options.conversationId
 * @param {function} [options.onProgress]
 * @returns {Promise<{ members: object[], pages: number, source: string }>}
 */
export async function extractGroupMembers({ client, conversationId, onProgress }) {
  if (!client?.isAuthenticated?.()) {
    throw new AuthError('Authentication required for DM operations', { status: 401 });
  }

  const { members, pages } = await fetchConversationMembers(client, conversationId, { onProgress });

  let source = 'conversation';
  if (members.length === 0) {
    // Legacy/edge shape: fall back to the inbox participant map.
    const inboxMembers = await fetchInboxParticipants(client, conversationId);
    if (inboxMembers.length > 0) source = 'inbox';
    return { members: inboxMembers, pages, source };
  }

  // Drop any sender-ID-only rows that never resolved to a username; the
  // username is the identity the rest of the app uses.
  const resolved = members.filter((m) => m.username);
  return { members: resolved, pages, source };
}
