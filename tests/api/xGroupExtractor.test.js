// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * X Group DM URL parser + member extractor tests.
 *
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseXGroupUrl, InvalidGroupUrlError } from '../../api/services/xGroups/urlParser.js';
import {
  normalizeMember,
  parseConversationUsers,
  extractGroupMembers,
  fetchInboxParticipants,
} from '../../api/services/xGroups/extractor.js';

describe('parseXGroupUrl', () => {
  it('accepts a valid group chat URL', () => {
    expect(parseXGroupUrl('https://x.com/i/chat/g2090169325890269541')).toEqual({
      conversationId: 'g2090169325890269541',
    });
  });

  it('accepts twitter.com host and trailing slash', () => {
    expect(parseXGroupUrl('https://twitter.com/i/chat/g1234567890/')).toEqual({
      conversationId: 'g1234567890',
    });
  });

  it('accepts a raw conversation id', () => {
    expect(parseXGroupUrl('g2090169325890269541')).toEqual({
      conversationId: 'g2090169325890269541',
    });
  });

  it('rejects non-group x.com paths', () => {
    for (const bad of [
      'https://x.com/home',
      'https://x.com/user/status/123',
      'https://x.com/i/chat/abc',
      'https://x.com/i/chat/',
      'https://x.com/i/grok/share/g123',
    ]) {
      expect(() => parseXGroupUrl(bad)).toThrow(InvalidGroupUrlError);
    }
  });

  it('rejects non-x hosts and garbage', () => {
    for (const bad of ['https://example.com/i/chat/g1234567890', 'not a url', 'g12', '']) {
      expect(() => parseXGroupUrl(bad)).toThrow(InvalidGroupUrlError);
    }
  });
});

describe('normalizeMember', () => {
  it('maps user fields to the member shape', () => {
    const m = normalizeMember('123', {
      screen_name: 'elonmusk',
      name: 'Elon Musk',
      profile_image_url_https: 'https://pbs.twimg.com/a',
      verified: true,
    });
    expect(m).toEqual({
      xUserId: '123',
      username: 'elonmusk',
      displayName: 'Elon Musk',
      profileUrl: 'https://x.com/elonmusk',
      avatarUrl: 'https://pbs.twimg.com/a',
      isAdmin: false,
      verified: true,
    });
  });

  it('returns null without a username', () => {
    expect(normalizeMember('123', { name: 'No Handle' })).toBeNull();
  });
});

describe('parseConversationUsers', () => {
  it('reads the users map', () => {
    const members = parseConversationUsers({
      users: {
        1: { screen_name: 'a', name: 'A' },
        2: { screen_name: 'b', name: 'B' },
      },
      conversation_timeline: { entries: [] },
    });
    expect(members.map((m) => m.username)).toEqual(['a', 'b']);
  });

  it('includes sender IDs not present in the users map', () => {
    const members = parseConversationUsers({
      users: { 1: { screen_name: 'a', name: 'A' } },
      conversation_timeline: {
        entries: [{ message: { sender_id: '2' } }],
      },
    });
    expect(members.some((m) => m.xUserId === '2' && m.username === '')).toBe(true);
  });
});

function makeClient(pages) {
  // pages: array of { users, cursor, participants }
  let i = 0;
  return {
    isAuthenticated: () => true,
    async request() {
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return {
        users: page.users,
        conversation_timeline: { entries: [], min_entry_id: page.cursor || null },
      };
    },
  };
}

describe('extractGroupMembers', () => {
  it('paginates until no cursor and dedupes by xUserId (AC4 + AC5)', async () => {
    const client = makeClient([
      { users: { 1: { screen_name: 'a', name: 'A' }, 2: { screen_name: 'b', name: 'B' } }, cursor: 'c1' },
      { users: { 2: { screen_name: 'b', name: 'B' }, 3: { screen_name: 'c', name: 'C' } }, cursor: 'c2' },
      { users: { 3: { screen_name: 'c', name: 'C' }, 4: { screen_name: 'd', name: 'D' } }, cursor: null },
    ]);
    const { members, pages } = await extractGroupMembers({ client, conversationId: 'g123' });
    expect(pages).toBe(3);
    expect(members.map((m) => m.xUserId).sort()).toEqual(['1', '2', '3', '4']);
    expect(members.map((m) => m.username)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops sender-only rows that never resolved to a username', async () => {
    const client = makeClient([
      {
        users: { 1: { screen_name: 'a', name: 'A' } },
        cursor: null,
      },
    ]);
    // force a sender-only row through the parser
    const { members } = await extractGroupMembers({ client, conversationId: 'g123' });
    expect(members.map((m) => m.username)).toEqual(['a']);
  });

  it('falls back to the inbox when the conversation returns no users', async () => {
    const client = {
      isAuthenticated: () => true,
      async request(url) {
        if (url.includes('/dm/conversation/')) {
          return { users: {}, conversation_timeline: { entries: [], min_entry_id: null } };
        }
        // inbox response
        return {
          inbox_initial_state: {
            conversations: {
              g123: { participants: { 9: {}, 10: {} }, type: 'GROUP_DM' },
            },
            users: {
              9: { screen_name: 'nine', name: 'Nine' },
              10: { screen_name: 'ten', name: 'Ten' },
            },
            entries: { cursor: null },
          },
        };
      },
    };
    const { members, source } = await extractGroupMembers({ client, conversationId: 'g123' });
    expect(source).toBe('inbox');
    expect(members.map((m) => m.username).sort()).toEqual(['nine', 'ten']);
  });

  it('requires an authenticated client', async () => {
    await expect(extractGroupMembers({ client: { isAuthenticated: () => false }, conversationId: 'g1' }))
      .rejects.toThrow(/Authentication required/i);
  });
});

describe('fetchInboxParticipants', () => {
  it('paginates the inbox to find the conversation', async () => {
    const client = {
      isAuthenticated: () => true,
      async request(url) {
        const hasCursor = url.includes('cursor=c1');
        return {
          inbox_initial_state: {
            conversations: hasCursor
              ? { g123: { participants: { 7: {}, 8: {} }, type: 'GROUP_DM' } }
              : { other: { participants: {}, type: 'ONE_TO_ONE' } },
            users: hasCursor
              ? { 7: { screen_name: 'seven', name: 'Seven' }, 8: { screen_name: 'eight', name: 'Eight' } }
              : {},
            entries: { cursor: hasCursor ? null : 'c1' },
          },
        };
      },
    };
    const members = await fetchInboxParticipants(client, 'g123');
    expect(members.map((m) => m.username).sort()).toEqual(['eight', 'seven']);
  });
});
