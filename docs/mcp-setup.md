# XActions MCP Server Setup Guide

> Use AI agents (Claude, Cursor, Windsurf, GPT) to automate X/Twitter — for free.

---

## 30-Second Quickstart

```bash
# Add to your AI client config, then restart the client
npx xactions-mcp
```

That's it. XActions will auto-install and start the MCP server.

---

## Getting Your auth_token

Most tools require an X/Twitter session cookie for authentication.

1. Go to [x.com](https://x.com) and **log in**
2. Open **DevTools** (F12 or Cmd+Option+I)
3. Go to **Application** → **Cookies** → `https://x.com`
4. Find the cookie named **`auth_token`**
5. Copy its value (a long hex string)

> ⚠️ Treat this like a password. Never share it publicly.

---

## Claude Desktop

### 1. Open config file

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### 2. Add XActions

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
      }
    }
  }
}
```

### 3. Restart Claude Desktop

Quit and reopen Claude Desktop. You should see XActions tools listed.

### Auto-generate config

```bash
npx xactions mcp-config
```

This detects your OS and outputs the correct config snippet. Use `--write` to write it directly.

---

## Cursor

Add to your **Cursor Settings** → **MCP Servers**:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
      }
    }
  }
}
```

Or add to `.cursor/mcp.json` in your project root.

---

## Windsurf

Add to your **Windsurf Settings** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
      }
    }
  }
}
```

---

## VS Code (GitHub Copilot)

Add to your **VS Code** user `settings.json` or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "xactions": {
        "command": "npx",
        "args": ["-y", "xactions-mcp"],
        "env": {
          "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
        }
      }
    }
  }
}
```

---

## Local Install (Alternative)

If you prefer a local install instead of npx:

```bash
npm install -g xactions
```

Then use `xactions-mcp` as the command instead of `npx`:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "xactions-mcp",
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XACTIONS_SESSION_COOKIE` | For most tools | Your X/Twitter `auth_token` cookie |
| `OPENROUTER_API_KEY` | For AI tools | Free key from [openrouter.ai](https://openrouter.ai) |
| `XACTIONS_MODE` | No | `local` (default, free) or `remote` |
| `XACTIONS_MCP_TOOLS` | No | Allowlist of tool or group names to expose (see [Tool filtering](#tool-filtering)) |
| `XACTIONS_MCP_EXCLUDE` | No | Denylist of tool or group names to hide; wins over the allowlist |
| `XACTIONS_MCP_REQUIRE_APPROVAL` | No | `1` holds every write tool as a draft until approved (see [Approval mode](#approval-mode-draft-before-you-post)) |
| `XACTIONS_MCP_TOKEN` | No | Bearer token required on `/mcp` when running with `--http` |
| `XACTIONS_MCP_HOST` | No | Bind address for `--http` (default `127.0.0.1`) |
| `XACTIONS_HOME` | No | Directory for local state such as `mcp-drafts.json` (default `~/.xactions`) |
| `DEBUG` | No | Set to `true` for verbose error stacks |

---

## Tool filtering

The server ships 149 tools. Most sessions need a handful, and a smaller tool list means a cheaper, more accurate model. Filter with an allowlist, a denylist, or both. Each accepts a comma-separated mix of:

- **tool names** such as `x_get_profile`
- **group names** such as `read` or `analytics`
- **prefix patterns** such as `x_get_*`

Groups (run `npx xactions-mcp --list-groups` to see every member):

| Group | What it covers |
|-------|----------------|
| `read` | Profiles, followers, tweets, search, threads, media, trends, notifications, `x_list_platforms` |
| `write` | Post, reply, quote, like, retweet, bookmark, follow, unfollow, mute, delete, profile edits |
| `dm` | Send, list, and export direct messages |
| `lists` | X Lists and their members |
| `spaces` | Spaces discovery, transcripts, and the live Space agent |
| `analytics` | Account reports, growth, engagement, sentiment, bots, influencers, history |
| `ai` | Voice analysis, tweet generation, rewriting, summarising, hashtag suggestions |
| `grok` | Grok queries and image analysis |
| `automation` | Auto-like, auto-follow, smart unfollow, auto-comment, bulk execution |
| `monitoring` | Streams, keyword and account monitors, follower alerts, notifications |
| `workflows` | Saved workflows, the local scheduler, RSS to tweet drafts |
| `persona` | The persona autopilot |
| `graph` | Social graph building and analysis |
| `data` | Account export and migration, datasets, CRM, teams, format conversion |
| `auth` | `x_login` |
| `x402` | Paid plugin tools, when a plugin registers them |
| `drafts` | The four approval tools; these are never filtered out |

The rules match [xdevplatform/xmcp](https://github.com/xdevplatform/xmcp): an empty allowlist means everything, the denylist always wins, and `x_list_drafts`, `x_approve_draft`, `x_discard_draft`, `x_draft_status` stay available so pending drafts can never be orphaned. `tools/list` only returns what passes the filter, and calling a hidden tool returns an error naming the group to enable rather than a generic "unknown tool".

Environment variables (any client):

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here",
        "XACTIONS_MCP_TOOLS": "read,analytics,x_post_tweet",
        "XACTIONS_MCP_EXCLUDE": "x_get_non_followers"
      }
    }
  }
}
```

The same thing as CLI flags (Cursor, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp", "--tools", "read,analytics", "--exclude", "x_get_*"],
      "env": { "XACTIONS_SESSION_COOKIE": "your_auth_token_here" }
    }
  }
}
```

Unknown names are reported on stderr at startup and otherwise ignored, so a typo hides nothing silently.

---

## HTTP transport

Stdio is the default and is what Claude Desktop, Cursor, Windsurf, and VS Code speak. For a remote client, a shared team server, or a container, run the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) transport instead:

```bash
XACTIONS_MCP_TOKEN=$(openssl rand -hex 24) npx xactions-mcp --http --port 8787 --host 127.0.0.1
```

- The MCP endpoint is `POST /mcp` (plus `GET` for the event stream and `DELETE` to end a session). Sessions are managed by the server: the `initialize` response carries an `Mcp-Session-Id` header that every later request must echo.
- `GET /health` is unauthenticated and reports tool and session counts.
- `XACTIONS_MCP_TOKEN` turns on bearer auth for everything under `/mcp`. Without it the server will still start, but only bind it to loopback (the default). Set a token before you change `--host`.
- `MCP_TRANSPORT=http` and `PORT` are honoured too, for hosts like Railway that inject them.

Hand-check it with curl:

```bash
curl -s -i -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $XACTIONS_MCP_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
# copy the mcp-session-id header, then:
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $XACTIONS_MCP_TOKEN" -H "Mcp-Session-Id: <id>" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Claude Desktop and Cursor connect to a remote MCP server by URL. Cursor `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "xactions-remote": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer your_token_here" }
    }
  }
}
```

Tool filtering and approval mode apply to every HTTP session exactly as they do on stdio.

---

## Approval mode (draft before you post)

Giving an agent a live posting tool is a leap of faith. Approval mode, borrowed from [x-use](https://github.com/nirholas/x-use), removes it: with `XACTIONS_MCP_REQUIRE_APPROVAL=1` (or `--require-approval`) every side-effect tool is **held as a draft instead of executed**. Posting, replying, quoting, liking, retweeting, bookmarking, following, unfollowing, muting, blocking-style profile changes, DM sending, deleting, scheduling, bulk automation, workflow and persona runs, and joining Spaces are all covered; the exact register is `WRITE_TOOLS` in `src/mcp/tool-groups.js`. Read and analytics tools run immediately as before.

A held call returns the draft id:

```json
{
  "held": true,
  "draftId": "3f9c1a2b",
  "tool": "x_post_tweet",
  "args": { "text": "Shipping approval mode today." },
  "createdAt": "2026-08-27T05:15:05.512Z",
  "message": "Approval mode is on. \"x_post_tweet\" was saved as draft 3f9c1a2b and has NOT been executed.",
  "next": "Review with x_draft_status, run with x_approve_draft {\"id\":\"3f9c1a2b\"}, or drop with x_discard_draft."
}
```

Four tools manage drafts and are always available, whatever the tool filter says:

| Tool | Does |
|------|------|
| `x_list_drafts` | List drafts, newest first; optional `status` of `pending`, `executed`, `failed`, or `all` |
| `x_draft_status` | Show one draft with its arguments, state, and result or error |
| `x_approve_draft` | Execute the stored call exactly as submitted; an already-run draft is refused so nothing posts twice |
| `x_discard_draft` | Delete a draft without running it |

Drafts live in `~/.xactions/mcp-drafts.json` (`XACTIONS_HOME` overrides the directory), written atomically, so a second process, a script, or a person with a text editor can review the queue. The same list, approve, and discard functions are exported from `src/mcp/drafts.js` for use outside MCP.

Claude Desktop, read-only session that can still queue posts for you to approve elsewhere:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp", "--require-approval"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here",
        "XACTIONS_MCP_TOOLS": "read,analytics,write"
      }
    }
  }
}
```

Cursor, approval on with the drafts reviewed in the same chat:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here",
        "XACTIONS_MCP_REQUIRE_APPROVAL": "1"
      }
    }
  }
}
```

A typical exchange: the agent calls `x_post_tweet`, gets draft `3f9c1a2b` back, and shows you the text. You say "approve it", the agent calls `x_approve_draft {"id":"3f9c1a2b"}`, and only then does the tweet go out.

### Approve drafts from the terminal

You do not have to go back through the agent to release a draft. `xactions drafts` reads the same `mcp-drafts.json` the server writes:

```bash
xactions drafts list                # id, status, age, tool, argument summary
xactions drafts show 3f9c1a2b       # the full arguments
xactions drafts approve 3f9c1a2b    # runs it through the server's own dispatcher
xactions drafts approve --all       # every pending draft, oldest first
xactions drafts discard 3f9c1a2b    # drop it
```

This is the setup for a read-only agent session where a person releases posts from a shell: give the agent `XACTIONS_MCP_REQUIRE_APPROVAL=1`, and review the queue with `xactions drafts list` whenever you like. Both sides honour `XACTIONS_HOME`, so point them at the same directory if you have moved it. Full reference: [cli-reference.md](cli-reference.md#drafts-approve-mcp-write-calls-from-the-terminal).

---

## Available Tools

### Scraping (free, no API key needed)

| Tool | Description |
|------|-------------|
| `x_get_profile` | Get any user's profile (bio, followers, etc.) |
| `x_get_followers` | Scrape a user's followers list |
| `x_get_following` | Scrape who a user follows |
| `x_get_tweets` | Scrape a user's recent tweets |
| `x_search_tweets` | Search tweets by keyword |
| `x_get_thread` | Unroll and read an entire thread |
| `x_download_video` | Extract video download URL from a tweet |

### Analysis

| Tool | Description |
|------|-------------|
| `x_detect_unfollowers` | Snapshot followers to detect unfollowers over time |
| `x_analyze_sentiment` | Sentiment analysis (rule-based or LLM) |
| `x_best_time_to_post` | Find optimal posting times from tweet history |
| `x_competitor_analysis` | Compare metrics across accounts |
| `x_brand_monitor` | Monitor brand mentions with sentiment |

### Actions (require auth_token)

| Tool | Description |
|------|-------------|
| `x_follow` | Follow a user |
| `x_unfollow` | Unfollow a user |
| `x_like` | Like a tweet |
| `x_post_tweet` | Post a tweet |
| `x_post_thread` | Post a multi-tweet thread |
| `x_reply` | Reply to a tweet |
| `x_retweet` | Retweet a tweet |
| `x_bookmark` | Bookmark a tweet |
| `x_send_dm` | Send a direct message |

### AI Tools (require OPENROUTER_API_KEY)

| Tool | Description |
|------|-------------|
| `x_analyze_voice` | Analyze a user's writing style |
| `x_generate_tweet` | Generate tweets in a user's voice |
| `x_summarize_thread` | AI-powered thread summarization |

---

## Example Prompts

Try these with Claude, Cursor, or any MCP-compatible AI:

### Research
> "Get the profile and last 20 tweets from @elonmusk. Summarize the main topics."

### Growth
> "Find everyone I follow who doesn't follow me back. Show me the list sorted by how long ago I followed them."

### Content
> "Analyze @paulg's writing style, then generate 3 tweet ideas about startups in his voice."

### Analytics
> "Compare the follower counts, tweet frequency, and engagement of @openai, @anthropic, and @google."

### Engagement
> "Search for tweets about 'AI agents' from the last day. Like the top 5 most engaging ones."

---

## Troubleshooting

### `npx xactions-mcp` returns 404 / package not found

Make sure you have the latest version. If the `xactions-mcp` package hasn't been published yet, use either of these alternatives:

```bash
# Option 1: Use the -p flag to install from the xactions package
npx -p xactions xactions-mcp

# Option 2: Install globally first
npm install -g xactions
xactions-mcp
```

For MCP client configs, the `-p` flag approach:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "-p", "xactions", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_here"
      }
    }
  }
}
```

### "Tool not found" or no tools showing

1. Make sure the MCP server is configured correctly in your client
2. Restart your AI client after changing config
3. Check that Node.js 18+ is installed: `node --version`

### "Could not follow/unfollow/post"

Auth is required for action tools. Make sure `XACTIONS_SESSION_COOKIE` is set in your MCP config `env`.

### "OPENROUTER_API_KEY required"

AI tools (voice analysis, tweet generation, thread summarization) need an OpenRouter API key. Get a free one at [openrouter.ai](https://openrouter.ai).

### Server won't start

```bash
# Test manually
node node_modules/xactions/src/mcp/server.js

# Or if globally installed
xactions-mcp
```

### Browser automation errors

XActions uses Puppeteer for browser automation. If you see Chrome/Chromium errors:

```bash
# Install Chromium dependencies (Linux)
npx puppeteer browsers install chrome
```

---

## Links

- **GitHub**: [github.com/nirholas/XActions](https://github.com/nirholas/XActions)
- **npm**: [npmjs.com/package/xactions](https://www.npmjs.com/package/xactions)
- **Dashboard**: [xactions.app](https://xactions.app)
- **Issues**: [github.com/nirholas/XActions/issues](https://github.com/nirholas/XActions/issues)

---

*Built by [@nichxbt](https://x.com/nichxbt). Apache 2.0 License.*
