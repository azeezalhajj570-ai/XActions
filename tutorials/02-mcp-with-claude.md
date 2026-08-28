# Tutorial 02 — Claude that can use X

**Time:** 10 minutes · **Login required:** optional · **You need:** Node.js 18+ and an MCP client

MCP (Model Context Protocol) is how AI assistants call external tools. This
tutorial connects XActions' 144 tools to Claude Desktop, Cursor, or Windsurf, so
you can ask for a competitor analysis in English and have the assistant actually
go and get the data.

Assumes [Tutorial 01](01-your-first-scrape.md).

---

## Step 1 — Prove the server works first

Before touching any client config, confirm the server itself runs. This one step
saves most of the debugging people do later:

```bash
npx -y xactions-mcp
```

You should see, on stderr:

```
💻 XActions MCP Server: Local mode (free)
⚡ XActions MCP Server v3.5.0 - 153 tools

📋 Tools available: 151
   Scraping: x_get_profile, x_get_followers, x_get_following, x_get_tweets, x_search_tweets, x_get_thread, x_download_video
   Analysis: x_detect_unfollowers, x_analyze_sentiment, x_best_time_to_post, x_competitor_analysis, x_brand_monitor
   Actions: x_follow, x_unfollow, x_like, x_post_tweet, x_post_thread, x_reply
   AI: x_analyze_voice, x_generate_tweet, x_summarize_thread

✅ Server running on stdio
   Ready for connections from Claude, Cursor, Windsurf, and any MCP client.
```

It then sits waiting for JSON-RPC on stdin, which is correct. Press
<kbd>Ctrl</kbd>+<kbd>C</kbd>.

To go further and actually complete a handshake and a tool call:

```bash
git clone https://github.com/nirholas/XActions.git
cd XActions && npm install
node examples/08-mcp-tool-call.js
```

```
Connected to xactions-mcp v3.4.4
Server offers 144 tools.

Calling x_get_profile — Get profile information for a user...

{
  "name": "NASA",
  "username": "NASA",
  "followers": 92227380,
  ...
}
```

If that prints a profile, the server is healthy. Anything that goes wrong from
here is client configuration.

---

## Step 2 — Configure your client

### Claude Desktop

Edit the config file:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"]
    }
  }
}
```

Quit Claude Desktop **completely** and reopen it. A new chat is not enough: MCP
servers are spawned at application startup.

### Cursor

`.cursor/mcp.json` in your project, or the global equivalent:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, same shape.

### Claude Code

```bash
claude mcp add xactions -- npx -y xactions-mcp
```

---

## Step 3 — Add a session

Without a session the server still starts and still offers all 144 tools. The
guest-tier ones work; the rest report that they need a login. To unlock
everything, put your cookies in the `env` block:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "npx",
      "args": ["-y", "xactions-mcp"],
      "env": {
        "XACTIONS_SESSION_COOKIE": "your_auth_token_value",
        "XACTIONS_CSRF_TOKEN": "your_ct0_value"
      }
    }
  }
}
```

Get both from DevTools → **Application** → **Cookies** → `https://x.com`. They
go here rather than in a `.env` file because MCP servers are launched with a
minimal environment and will not pick one up.

Restart the client again.

---

## Step 4 — Use it

Ask in plain language. The assistant picks the tools.

**Research:**

> Look up @nasa and @spacex on X. Compare their follower counts, posting
> frequency, and which one gets more engagement per post.

**Analysis:**

> Pull the last 50 posts from @vercel and tell me which topics performed best.
> Group them by theme.

**Audit (needs a session):**

> Who am I following that doesn't follow me back? Sort by follower count and
> don't unfollow anyone, just show me the list.

**Monitoring (needs a session):**

> Search X for mentions of "XActions" in the last day and summarise the
> sentiment.

The assistant chains tools on its own: `x_get_profile` to resolve the account,
`x_get_tweets` to pull the timeline, then its own reasoning over the results.

---

## Step 5 — Know what it can do

The 144 tools group roughly like this:

| Group | Examples | Session |
|-------|----------|:-------:|
| Scraping | `x_get_profile`, `x_get_tweets`, `x_get_thread` | no |
| Scraping | `x_get_followers`, `x_get_following`, `x_search_tweets` | yes |
| Posting | `x_post_tweet`, `x_post_thread`, `x_create_poll`, `x_schedule_post` | yes |
| Engagement | `x_like`, `x_retweet`, `x_reply`, `x_bookmark` | yes |
| Bulk | `x_unfollow_non_followers`, `x_detect_unfollowers`, `x_mass_block` | yes |
| Analytics | `x_best_time_to_post`, `x_engagement_analytics`, `x_shadowban_check` | mixed |
| Cross-platform | Bluesky, Mastodon, and Threads variants of the scrapers | no |

To list them yourself:

```bash
node examples/08-mcp-tool-call.js x_get_profile nasa
```

or ask the assistant: *"What XActions tools do you have?"*

---

## Step 6 — Give it a playbook

Tools tell an assistant *what it can do*. [Skills](../docs/skills.md) tell it
*how to do a specific job well*: which tools in which order, what the rate
limits are, what not to do.

```
Read skills/follower-monitoring/SKILL.md, then set up unfollower tracking for my account.
```

There are 49 of them in [`skills/`](../skills/). They are plain markdown, so they
work with any assistant, MCP or not.

---

## When it does not connect

Work down this list in order. It is ordered by how often each one is the answer.

**Did you fully restart the client?** Not a new chat. Quit and reopen.

**Is the JSON valid?** A trailing comma silently disables the entire config
file. Paste it into a validator.

**Is `node` on the client's PATH?** MCP clients launch servers with a minimal
environment, so a Node installed by nvm, fnm, or asdf is frequently invisible to
them. Use absolute paths:

```json
{
  "mcpServers": {
    "xactions": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/XActions/src/mcp/server.js"]
    }
  }
}
```

Find yours with `which node`.

**Does the server run standalone?** Back to Step 1. If `npx -y xactions-mcp`
fails there, the problem is not the client.

Fuller list: [docs/troubleshooting.md](../docs/troubleshooting.md#mcp-server-not-connecting).

---

## What you learned

- Verify the server before configuring the client, not after
- Config lives in the client, and a full restart is required
- Cookies go in the MCP `env` block, not a `.env` file
- Guest tools work with no login; the rest need `auth_token` **and** `ct0`
- Skills turn a pile of tools into a procedure

## Next

- **[Tutorial 03 — Clean up your following list](03-clean-up-your-following.md)**
- [MCP setup reference](../docs/mcp-setup.md)
- [Skills reference](../docs/skills.md)
