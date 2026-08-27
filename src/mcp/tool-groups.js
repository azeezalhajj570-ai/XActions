// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Tool groups, allowlist filtering, and the write-tool register for the
 * XActions MCP server.
 *
 * Three things live here:
 *
 * 1. GROUP_RULES assigns every tool name to exactly one group (read, write,
 *    dm, lists, spaces, analytics, ai, grok, automation, monitoring,
 *    workflows, persona, graph, data, x402, drafts, auth). Groups are what a
 *    user names in XACTIONS_MCP_TOOLS / XACTIONS_MCP_EXCLUDE or on the
 *    --tools / --exclude flags, so a config can say "read,analytics" instead
 *    of listing forty tool names.
 *
 * 2. WRITE_TOOLS enumerates every tool that posts, deletes, follows, mutes,
 *    sends, or otherwise changes state on X. The draft-approval gate
 *    (XACTIONS_MCP_REQUIRE_APPROVAL) intercepts exactly these.
 *
 * 3. createToolFilter() turns an include list plus an exclude list into a
 *    single isAllowed(name) predicate that ListTools and CallTool share, so a
 *    filtered tool is neither advertised nor callable.
 *
 * Modelled on the allowlist in xdevplatform/xmcp and the draft flow in x-use.
 */

/**
 * Tools that exist regardless of any filter. Removing these would strand
 * pending drafts with no way to approve or discard them.
 */
export const ALWAYS_AVAILABLE_TOOLS = Object.freeze([
  'x_list_drafts',
  'x_approve_draft',
  'x_discard_draft',
  'x_draft_status',
]);

/**
 * Ordered classification rules. The first matching rule wins, so exact
 * names come before prefixes and specific prefixes before broad ones.
 * `names` is an exact-match list, `prefixes` matches `name.startsWith()`.
 */
export const GROUP_RULES = Object.freeze([
  { group: 'drafts', names: [...ALWAYS_AVAILABLE_TOOLS] },
  { group: 'auth', names: ['x_login'] },
  {
    group: 'dm',
    names: ['x_send_dm', 'x_get_conversations', 'x_export_dms'],
  },
  {
    group: 'lists',
    names: ['x_get_lists', 'x_get_list_members'],
  },
  {
    group: 'spaces',
    names: ['x_get_spaces', 'x_scrape_space'],
    prefixes: ['x_space_'],
  },
  {
    group: 'grok',
    names: ['x_grok_query', 'x_grok_summarize', 'x_grok_analyze_image'],
  },
  {
    group: 'persona',
    prefixes: ['x_persona_'],
  },
  {
    group: 'graph',
    prefixes: ['x_graph_'],
  },
  {
    group: 'x402',
    prefixes: ['x_x402_', 'x402_', 'x_pay_', 'x_wallet_'],
  },
  {
    group: 'write',
    names: [
      'x_follow', 'x_unfollow', 'x_unfollow_non_followers',
      'x_post_tweet', 'x_post_thread', 'x_create_poll', 'x_schedule_post',
      'x_delete_tweet', 'x_reply', 'x_quote_tweet', 'x_like', 'x_retweet',
      'x_bookmark', 'x_clear_bookmarks', 'x_update_profile',
      'x_mute_user', 'x_unmute_user', 'x_toggle_protected',
      'x_publish_article', 'x_client_send_tweet',
    ],
  },
  {
    group: 'automation',
    names: [
      'x_auto_like', 'x_auto_follow', 'x_follow_engagers', 'x_unfollow_all',
      'x_smart_unfollow', 'x_auto_comment', 'x_auto_retweet',
      'x_bulk_execute',
    ],
  },
  {
    group: 'monitoring',
    names: [
      'x_monitor_account', 'x_monitor_keyword', 'x_follower_alerts',
      'x_track_engagement', 'x_brand_monitor', 'x_monitor_reputation',
    ],
    prefixes: ['x_stream_', 'x_notify_'],
  },
  {
    group: 'workflows',
    prefixes: ['x_workflow_', 'x_schedule_', 'x_rss_'],
  },
  {
    group: 'ai',
    names: [
      'x_analyze_voice', 'x_generate_tweet', 'x_rewrite_tweet',
      'x_summarize_thread', 'x_optimize_tweet', 'x_suggest_hashtags',
      'x_predict_performance', 'x_generate_variations',
    ],
  },
  {
    group: 'data',
    names: [
      'x_export_account', 'x_migrate_account', 'x_diff_exports',
      'x_import_data', 'x_convert_format',
    ],
    prefixes: ['x_dataset_', 'x_crm_', 'x_team_'],
  },
  {
    group: 'analytics',
    names: [
      'x_detect_unfollowers', 'x_get_analytics', 'x_get_post_analytics',
      'x_competitor_analysis', 'x_creator_analytics', 'x_analyze_sentiment',
      'x_reputation_report', 'x_best_time_to_post', 'x_account_report',
      'x_audience_insights', 'x_engagement_report', 'x_detect_bots',
      'x_find_influencers', 'x_smart_target', 'x_crypto_analyze',
      'x_growth_rate', 'x_compare_accounts', 'x_audience_overlap',
      'x_evergreen_analyze', 'x_check_premium',
    ],
    prefixes: ['x_history_'],
  },
  {
    group: 'read',
    names: ['x_list_platforms', 'x_download_video', 'x_get_settings'],
    prefixes: ['x_get_', 'x_search_', 'x_client_'],
  },
]);

/** Every group name, in rule order. */
export const GROUP_NAMES = Object.freeze([...new Set(GROUP_RULES.map((r) => r.group))]);

/**
 * Tools that change state on X (or send something on the user's behalf).
 * The approval gate stores these as drafts instead of executing them.
 * Read tools, analytics, and local bookkeeping (persona create/edit, CRM
 * tagging, dataset listing) are deliberately absent: they touch nothing a
 * follower could see.
 */
export const WRITE_TOOLS = Object.freeze(new Set([
  // Posting and engagement
  'x_post_tweet', 'x_post_thread', 'x_create_poll', 'x_schedule_post',
  'x_delete_tweet', 'x_reply', 'x_quote_tweet', 'x_like', 'x_retweet',
  'x_bookmark', 'x_clear_bookmarks', 'x_publish_article', 'x_client_send_tweet',
  // Relationship and account state
  'x_follow', 'x_unfollow', 'x_unfollow_non_followers',
  'x_mute_user', 'x_unmute_user', 'x_update_profile', 'x_toggle_protected',
  // Direct messages
  'x_send_dm',
  // Bulk automation
  'x_auto_like', 'x_auto_follow', 'x_follow_engagers', 'x_unfollow_all',
  'x_smart_unfollow', 'x_auto_comment', 'x_auto_retweet', 'x_bulk_execute',
  // Scheduled and workflow execution
  'x_schedule_add', 'x_workflow_run', 'x_migrate_account',
  // Persona autopilot
  'x_persona_run',
  // Spaces (joining is visible to the host)
  'x_space_join',
  // Outbound notifications
  'x_notify_send',
]));

/**
 * Resolve the group a tool belongs to.
 * @param {string} name
 * @returns {string} group name; unknown tools fall into "other"
 */
export function groupOf(name) {
  for (const rule of GROUP_RULES) {
    if (rule.names?.includes(name)) return rule.group;
    if (rule.prefixes?.some((p) => name.startsWith(p))) return rule.group;
  }
  return 'other';
}

/**
 * Build a group -> tool names map for a concrete tool list.
 * @param {Array<{name: string}>} tools
 * @returns {Record<string, string[]>}
 */
export function buildGroups(tools) {
  const groups = {};
  for (const tool of tools) {
    const g = groupOf(tool.name);
    (groups[g] ||= []).push(tool.name);
  }
  return groups;
}

/**
 * Is this tool a side-effect tool the approval gate should intercept?
 * @param {string} name
 */
export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

/**
 * Parse a comma or whitespace separated selection string into a list of
 * lower-cased tokens. Accepts arrays too, so CLI flags that were given more
 * than once merge naturally.
 * @param {string | string[] | undefined | null} value
 * @returns {string[]}
 */
export function parseSelection(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((v) => String(v).split(/[\s,]+/))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Expand a token list into the set of tool names it selects. A token is a
 * tool name, a group name, or a wildcard suffix pattern such as `x_get_*`.
 * @param {string[]} tokens
 * @param {Array<{name: string}>} tools
 * @returns {{ names: Set<string>, unknown: string[] }}
 */
export function expandSelection(tokens, tools) {
  const names = new Set();
  const unknown = [];
  const groups = buildGroups(tools);
  const known = new Set(tools.map((t) => t.name));

  for (const token of tokens) {
    if (groups[token]) {
      for (const n of groups[token]) names.add(n);
    } else if (token.endsWith('*')) {
      const prefix = token.slice(0, -1);
      let hit = false;
      for (const n of known) {
        if (n.startsWith(prefix)) { names.add(n); hit = true; }
      }
      if (!hit) unknown.push(token);
    } else if (known.has(token)) {
      names.add(token);
    } else {
      unknown.push(token);
    }
  }
  return { names, unknown };
}

/**
 * Create the shared allow predicate.
 *
 * Semantics (matching xmcp): an empty include list means "everything";
 * exclude always wins over include; the draft tools are never filtered.
 *
 * @param {object} options
 * @param {string | string[]} [options.include] tool/group tokens to allow
 * @param {string | string[]} [options.exclude] tool/group tokens to deny
 * @param {Array<{name: string}>} options.tools the full tool list to filter
 * @returns {{
 *   isAllowed: (name: string) => boolean,
 *   filter: <T extends {name: string}>(list: T[]) => T[],
 *   include: Set<string> | null,
 *   exclude: Set<string>,
 *   unknown: string[],
 *   active: boolean,
 * }}
 */
export function createToolFilter({ include, exclude, tools }) {
  const includeTokens = parseSelection(include);
  const excludeTokens = parseSelection(exclude);

  const inc = includeTokens.length ? expandSelection(includeTokens, tools) : null;
  const exc = expandSelection(excludeTokens, tools);

  const includeSet = inc ? inc.names : null;
  const excludeSet = exc.names;
  const always = new Set(ALWAYS_AVAILABLE_TOOLS);

  const isAllowed = (name) => {
    if (always.has(name)) return true;
    if (excludeSet.has(name)) return false;
    if (includeSet && !includeSet.has(name)) return false;
    return true;
  };

  return {
    isAllowed,
    filter: (list) => list.filter((t) => isAllowed(t.name)),
    include: includeSet,
    exclude: excludeSet,
    unknown: [...(inc?.unknown || []), ...exc.unknown],
    active: Boolean(includeSet) || excludeSet.size > 0,
  };
}

export default {
  ALWAYS_AVAILABLE_TOOLS,
  GROUP_RULES,
  GROUP_NAMES,
  WRITE_TOOLS,
  groupOf,
  buildGroups,
  isWriteTool,
  parseSelection,
  expandSelection,
  createToolFilter,
};
