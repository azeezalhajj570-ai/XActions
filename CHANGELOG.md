# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- **The Cloudflare Worker treated any `X-PAYMENT` header as proof of payment.** `worker/index.js` passed a request carrying one straight through to the origin without decoding it or asking a facilitator, which would have made every priced endpoint free to anyone sending `X-PAYMENT: x`. It was not the live deployment (xactions.app runs the Pages Functions path, which verifies correctly), but `wrangler.toml` names that file as `main`, so one deploy would have published it. The gate now decodes the payload, matches the chain against the terms it published, verifies with the facilitator, and refuses when the facilitator rejects the payment or cannot be reached.
- **The x402 client signed whatever a server asked for.** `createX402Client` read the amount and recipient out of the 402 response and signed, with no ceiling, budget, or allowlist: one hostile endpoint could drain the wallet. It now enforces a per-call limit (`X402_MAX_PRICE_USD`, default $1), a session budget (`X402_MAX_TOTAL_USD`, default $10), and an optional payee allowlist (`X402_ALLOWED_PAYEES`), and refuses a 402 whose amount it cannot parse.
- **A Solana-only deployment advertised Base terms payable to an empty address.** The Express middleware registers the EVM scheme only, but an operator who set `X402_PAY_TO_ADDRESS_SOLANA` alone passed validation and published `{ network: "eip155:8453", payTo: "" }` on every route. It now refuses to initialize rather than serve unpayable terms, and names the two ways to fix it.
- **`/api/ai/health` and `/api/ai/pricing` advertised eleven chains the server rejects.** Every route offers only the configured network; the documents now say so.
- Registration of the EVM `exact` scheme against Solana network ids is gone, the development bypass announces itself with an `X-Payment-Bypassed` header instead of failing open silently, a failed middleware initialization is retried after a minute instead of answering 503 until restart, and `api/serverless.js` no longer tells agents "Payment accepted" for a payment it never verified.

### Added

- **[docs/audits/2026-08-28-x402-audit.md](docs/audits/2026-08-28-x402-audit.md)** — the full audit: all four payment paths, what each one verifies, the nine findings with reproductions, and what is worth keeping.
- **`tests/x402-gate.test.js`** — 14 tests against the real gate and the real client, with the facilitator stubbed at the fetch boundary. The existing x402 suite tests a mock middleware defined inside its own test file, and its "valid payment" case asserts that `0xMockSignature` returns 200, so it encoded the bypass as correct behaviour.
- `writer:comment` is priced like every other writer operation.


### Added

- **Sweeps run over any feed, not just a profile.** `scripts/engageProfile.js` now recognises a profile, its replies tab, search results, a list, a hashtag, and your home timeline, and keeps separate progress for each. It takes the permalink from the post's timestamp rather than the first `/status/` link in the row, so a post that quotes another post is no longer at risk of having the quoted post engaged instead. Author allow and block lists, keyword and skip-keyword matching, like floors and ceilings, and a skip-verified toggle keep a mixed-feed sweep aimed; your own posts are never engaged.
- **`XEngage.inspect()`.** Run it in the console and every post on screen comes back with either `eligible: true` or the exact filter that rejected it. A sweep that engages nothing used to be silent about why.
- **`x_engage` MCP tool.** Agents can run the same sweep: profile, search, or list, with the same filters and either templates or an LLM brief. It defaults to `dryRun: true`, is registered as a write tool so the approval gate covers it, and is charged against the daily action caps once per enabled action class.
- **`xactions engage --search` and `--list`**, plus `--from`, `--skip-user`, `--keyword`, `--skip-keyword`, `--min-likes`, and `--max-likes`. A run that engages nothing now prints a counted breakdown of why every post was skipped.
- **`xactions/engage` module.** The sweep engine (`resolveSource`, `collectTweets`, `runEngage`, per-feed state) is importable, and is the single implementation behind the CLI and the MCP tool, so they share progress files and cannot double-engage a post.

### Changed

- **Action caps can charge several classes for one call.** `resolveActionCharge` may now return a list, so a sweep that likes and replies draws on both budgets instead of only the first.


### Changed

- **The endpoint table and the browser fingerprint refresh themselves now, from x.com's own bundles.** Both were hand-maintained lists, so both were only ever as current as the last person who remembered. `npm run sync:endpoints` reads [fa0311/TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) (MIT), whose bot statically analyses x.com's JavaScript once a day, and regenerates `src/scrapers/twitter/http/x-endpoints.generated.js` with all 325 GraphQL operations, the 61 feature switches and the values x.com's own client sends for them, and the v1.1 REST dispatch table; `endpoints.js` keeps the hand-decided half (which operations XActions tracks, `QUERY_ID_PINS`, request-variable shapes, rate limits) and builds `GRAPHQL` from the generated data, so every existing export keeps working and runtime discovery still wins at runtime. The first live run confirmed all 43 pinned IDs still match x.com, and found the feature defaults had drifted: 12 switches missing, 5 sent with the wrong value, and 4 field toggles never sent at all. An operation XActions has no wrapper for now resolves anyway (`resolveGraphQL('BirdwatchFetchNotes')` for Community Notes), with `operationFeatures()` giving the exact switches that operation declares. `npm run sync:user-agents` does the same for the browser pool from [fa0311/latest-user-agent](https://github.com/fa0311/latest-user-agent) (MIT): Chrome 120 and Firefox 121, roughly two years stale, became Chrome 151, Edge 151 and Firefox 153 across Windows, macOS and Linux, each with the `Sec-CH-UA` client hints that agree with it. The default also changed from a random string per request to one consistent profile per session, because a client that claims three different browsers from one IP inside one cookie jar is a stronger tell than one slightly old string; rotation stays available per call, per process, or through `XACTIONS_ROTATE_USER_AGENT=1`. Both syncs record the upstream commit and fetch time, so a "last verified" claim has a source, and both have a `--check` mode that fails when the committed table has fallen behind. Docs: [docs/scraping-infrastructure.md](docs/scraping-infrastructure.md#keeping-the-endpoint-table-fresh).

### Fixed

- **A web page could drive your X account through the MCP HTTP transport.** `xactions-mcp --http` validated a bearer token but never the `Host` header, and binding to 127.0.0.1 does not keep a browser out: any page you visit can POST to `http://127.0.0.1:8787/mcp`, and DNS rebinding lets a hostile hostname resolve there. The MCP spec requires validating Host for exactly this reason and the SDK already shipped the check, so it now runs before anything reads a request body. Verified: a request carrying `Host: evil.example.com` is refused with 403 `Invalid Host`, while a normal loopback request is unaffected.
- **Every MCP registry install landed unauthenticated.** `server.json`, and therefore the public MCP Registry listing and the generated `smithery.yaml`, advertised `X_COOKIES`, `X_USERNAME` and `X_PASSWORD`. The server reads none of those; it reads `XACTIONS_SESSION_COOKIE` and `XACTIONS_CSRF_TOKEN`. Anyone following the registry set three variables that did nothing and got a guest-tier server with no explanation. The manifest now declares what the code reads, and `node scripts/sync-registry.mjs --check` fails if a manifest ever advertises an environment variable that nothing under `src/` reads.
- **`xactions skills` did not exist for anyone who installed from npm.** `package.json`'s `files` list shipped `src`, `types` and one config file, so the `skills/` catalogue and `.claude-plugin/` never reached the published tarball, and `xactions skills list` answered `unknown command` while the docs said it worked from a global install. Both directories now ship, along with `THIRD-PARTY-NOTICES.md`.

- **CI now runs the lint step its own header always promised, on every supported Node.** The workflow was titled "Tests + Lint" and had no lint job, so `npm run lint` only ever ran when someone remembered locally. Tests also ran on Node 20 alone while `engines` claims `>=20`, which makes 22 and 24 a claim rather than a guarantee; they now run on all three. Coverage was configured in `vitest.config.js` but `@vitest/coverage-v8` was never installed, so `--coverage` could not run at all: it is installed, `npm run test:coverage` exists, and CI reports the number (33.18 percent today) rather than gating on it, so the untested areas are visible instead of invisible.

- **`npm install xactions` no longer downloads about 413 MB it never uses.** Remotion and its `@rspack/core` bundler sat in `dependencies`, but they build the promo videos under `site/video/`, a directory `package.json`'s `files` list has never shipped, so every CLI user pulled 217 MB of measured bundler toolchain for code they do not receive. They are devDependencies now. `googleapis` (196 MB) moved to an optional peer dependency, which is what the google-sheets plugin already treated it as: it lazy-imports the module and prints "googleapis is not installed. Run: npm install googleapis" when it is absent, so the plugin behaves exactly as before for anyone who wants it. Nothing changes for the API server: Prisma, Bull, Redis, Socket.io, Stripe and Nodemailer stay in `dependencies` because the Docker image installs with `--omit=dev` and runs them.

- **Long-running AI operations could never be polled, and four route groups were open to anyone.** A new contract test (`tests/api/contract.test.js`) boots the real Express app and walks every path in the OpenAPI spec. It found that twenty handlers under `api/routes/ai/` imported `getJobStatus` from the job queue, which never exported it, so every status poll threw `getJobStatus is not a function`; `getJob` is the function they meant and is now exported under both names. It also found `/api/workflows`, `/api/streams`, `/api/schedule` and `/api/notifications` answering without a token while `/api/crm` and `/api/automations` require one, which on a public deployment let anyone list and trigger the owner's automations; all four now carry the same authentication. Finally, `GET /api/twitter/status`, `GET /api/admin/stats` and `GET /api/notifications` were documented in the spec but never implemented, and now report real state: whether a saved X session exists, instance uptime and payment totals, and the configured notification channels with recent signed webhook deliveries.

- **The video downloader on xactions.app works again.** `POST /api/video/extract` answered a bare `405` with an empty body, so [xactions.app/video](https://xactions.app/video) could not extract anything. The cause was routing, not the extractor: `dashboard/_redirects` forwarded `/api/*` to a Node backend on another origin, and Cloudflare Pages accepts a 200-rewrite only when it points at a relative path, so the rule was dropped at build time and every API request fell through to the static asset handler, which rejects any non-GET method. The three video endpoints now run as Cloudflare Pages Functions (`functions/api/video/`) alongside the site, with no backend, no database, and no browser: `extract` returns the full mp4 ladder (360p through 4K, best first) with thumbnail, duration and text; `download` streams the file back through xactions.app so the browser saves it with a real filename; `extract-form` keeps the no-JavaScript path working. Extraction reads X's public syndication endpoint first and falls back to fxtwitter, with the guest-token GraphQL lane available when `TWITTER_BEARER_TOKEN` is set. Results are cached at the edge for an hour per tweet. `/api/health` now answers for real (the `/status` page was reading a 404 as "degraded"), and every remaining `/api/*` route returns a JSON 503 naming what it needs instead of the site's HTML 404 page. Docs: [functions/README.md](functions/README.md).

### Changed

- **One extraction module for both surfaces.** `src/video/edgeExtractor.js` holds the credential-free lanes, and `api/services/videoExtractor.js` now imports them and keeps only its Puppeteer last resort, which removed 350 lines of duplicated parsing and fixed two bugs the copy had drifted into: a GraphQL query ID X rotated away from, and an fxtwitter parser that read one quality when the response carries the whole ladder. HLS playlists are filtered out of the variant list, since a `.m3u8` cannot be saved as a video file.

### Added

- **Installable by any Agent Skills installer, plus a CLI lane for agents and a `.mcpb` bundle for Claude Desktop.** The 49 skills already followed the [Agent Skills spec](https://agentskills.io/specification) except for one: `a2a-multi-agent` shipped with no frontmatter at all, so every third-party installer silently dropped it and resolved 48. It has `name`, `description`, `license` and `compatibility` now, and `npx skills add nirholas/XActions` installs the full catalogue (`references/` included) into whichever agent directories a machine has, alongside the existing `xactions skills install`. A rewritten root [AGENTS.md](AGENTS.md) tells an agent when to shell out instead of loading the MCP server: the tool list is 150 tools and about 60 KB of JSON on connect, which is a fair price for a long session or a write and a poor one for one lookup, so the file carries the decision table plus verified recipes for profile, tweets, search, followers, non-followers and analyze with the exact `--compact` and `--fields` flags (and the fact that `--compact` wins over `--json` when both are passed). And `node scripts/build-mcpb.mjs` builds `xactions-<version>.mcpb`, a bundle a user drags onto Claude Desktop > Settings > Extensions: the manifest prompts for the session cookie, the tool groups and the approval gate at install time, so nothing is typed into a JSON config. The build validates the manifest against the MCPB schema, then unpacks what it packed and starts the server from it, so a bundle that cannot launch fails at build time; `.github/workflows/release-mcpb.yml` attaches it with a SHA-256 to every `v*` tag. Docs: [docs/skills.md](docs/skills.md), [docs/mcp-setup.md](docs/mcp-setup.md).
- **Real-time events off x.com's own pipeline, instead of polling for them.** `createLivePipeline()` (`xactions/streaming`) holds one long-lived connection to `https://api.x.com/live_pipeline/events` open and pushes tweet engagement counters, DM updates and typing indicators as they happen, in under a second, with no poll interval. Topics are built with `Topic.tweetEngagement(id)`, `Topic.dmUpdate(conversationId)` and `Topic.dmTyping(conversationId)`, and `subscribe()` / `unsubscribe()` change what a running session watches without dropping the connection. Frames are normalised into `{ type, topic, payload, receivedAt, raw }` with `type` one of `engagement`, `dm`, `typing`, `config`, `unknown`, so an unmodelled frame key surfaces with its raw body rather than disappearing. It rides out trouble: a silence watchdog tied to the heartbeat the server advertises, subscriptions re-asserted before their TTL expires, reconnect with exponential backoff and jitter that re-subscribes every live topic, and a `close()` that resolves once nothing is left running. A session with no `auth_token` fails with a typed `LivePipelineAuthError` before a request is sent, because this endpoint rejects guest tokens. `createStream({ transport: 'live', topics, cookies })` runs a managed stream over it and emits `stream:engagement` / `stream:dm` / `stream:typing` to Socket.IO clients; `transport` defaults to `poll`, and any live stream that cannot connect, or gives up reconnecting, logs the reason once and falls back to polling. No new dependency: the transport is chunked HTTP, not a WebSocket, which is what x.com actually serves. Docs: [docs/streaming.md](docs/streaming.md#live-event-stream).
- **Sweep an X search: delete, like, repost, or reply to every result.** X gives you no bulk tool for "remove every reply I ever sent this account", but its search finds them (`from:you @someone`). [`scripts/searchSweep.js`](scripts/searchSweep.js) takes any search result list and applies one action to all of it, from the console, with a floating panel: a query builder that submits through X's own search box so the page never reloads out from under the script, a dry run, age / engagement / keyword filters that protect what you want to keep, DOM-verified actions, a two-minute rest every 25 posts, back-off after four failures, and a JSON export. Two things about X search it works around: results come back a slice at a time, so it re-runs the query for several passes and stops once two in a row find nothing; and the search index lags deletions by minutes, so every id it acts on is remembered in `localStorage` and skipped later. Deletion is refused on any post that is not yours, twice over, and delete is exclusive with the engagement actions. Replies come from templates or from an LLM given a one-line brief, the same two lanes as `engageProfile.js`. Docs: [docs/search-sweep.md](docs/search-sweep.md).
- **Multi-account rotation and resumable scrapes for the HTTP scraper.** `createAccountPool()` keeps any number of X sessions in `~/.xactions/accounts.db` (SQLite), tracks each account's rate-limit window per GraphQL operation from the `x-rate-limit-remaining` / `x-rate-limit-reset` headers, and leases the least-recently-used account that can serve; `createPooledClient(pool)` is a drop-in for `TwitterHttpClient` that retries a call on the next account after a 429 or a spent window and locks an account on 401/403. Accounts import from any cookie format `xactions login --cookies-file` accepts, and each can carry its own proxy, which now actually routes requests (through undici's `ProxyAgent`). `createCheckpoint({ key })` saves `{ cursor, count }` atomically after every page; pass it as the `checkpoint` option of `scrapeFollowers`, `scrapeFollowing`, `scrapeTweets`, `searchTweets`, and the other paginated scrapers, and an interrupted `--limit 50000` run picks up at the saved cursor with the remaining budget. Docs: [docs/scraping-infrastructure.md](docs/scraping-infrastructure.md#account-pool-and-resumable-scrapes-http-scraper).
- **`xactions drafts`, `xactions archive`, and two new `doctor` lines.** `drafts list|show|approve|discard|clear` puts the MCP approval queue (`XACTIONS_MCP_REQUIRE_APPROVAL`) in the terminal, with `approve --all` and `--json` on every sub-command; approval replays the call through the server's own `executeTool`, which is loaded only when needed. `archive summary|export|migrate <zip-or-folder>` reads the official X data export straight from disk: a counts-and-hashtags report, an export into the `xactions export` layout (`--formats json,csv,md,html`), and a Bluesky or Mastodon migration from the zip (dry run unless `--execute`), all with a progress spinner that goes quiet under `--json`. `doctor` now reports the GraphQL query-ID cache (count, age, stale warning) with `--refresh-ids` to rediscover them from x.com, and the multi-account pool (available, rate limited, locked) when `accounts.db` exists.
- **Ask XActions.** [xactions.app/ask](https://xactions.app/ask) answers questions about the toolkit in plain language: "how do I unfollow all users" gets the exact script, where to paste it, and its safety features, with clickable sources. Answers are grounded in a retrieval index built from the docs, the 49 skills, the tutorials, every browser script's header, and the dashboard pages (`npm run ask:index`, checked by `npm run docs:check`), plus a live GitHub issue search, and stream through a chain of free LLM lanes: Groq, Cerebras, OpenRouter free models, xAI, Gemini, Mistral, and Cloudflare Workers AI when a key is configured, and LLM7, Pollinations, and OVH with no key at all. The model picker lets you lead with your own key, kept in your browser. `POST /api/ask` (Server-Sent Events) runs at the Cloudflare edge, in Express, and in the Vercel serverless entry; the page falls back to running the same engine in the browser when no API answers. History is local to the browser and nothing is stored server-side. Docs: [docs/ask.md](docs/ask.md).
- **Pinned GraphQL query IDs refreshed against x.com (2026-08-27).** The offline fallback table in `src/scrapers/twitter/http/endpoints.js` and `src/client/api/graphqlQueries.js` now carries the IDs x.com serves today, so a fresh install works before the first auto-discovery run. `UserByScreenName`, `TweetDetail`, `SearchTimeline`, `Followers`, `Following`, `CreateTweet` and 16 more had rotated.
- **`xactions/portability` subpath export** so `import { importTwitterArchive } from 'xactions/portability'` resolves from an npm install.
- **Competitive and structural audit** at [docs/audits/2026-08-27-competitive-and-structural-audit.md](docs/audits/2026-08-27-competitive-and-structural-audit.md): 24 comparable projects surveyed, every gap listed by area, and the repo-health backlog with what this release already closed.
- **`xactions login --cookies-file <path>` and `xactions login --from-browser [browser]`.** Login no longer means pasting `auth_token` out of DevTools. `--cookies-file` imports a session from any common export: Netscape `cookies.txt` (including `#HttpOnly_` prefixes), Cookie-Editor / EditThisCookie JSON arrays, Playwright / Puppeteer `storageState`, or a raw `auth_token=...; ct0=...` header string. `--from-browser` reads x.com cookies straight out of a locally installed browser: Firefox on every platform, and Chromium-family browsers (chrome, chromium, brave, edge, arc) on Linux (default keyring-less key) and macOS (via the Keychain). Unsupported combinations (Windows Chromium, or a Linux Chromium sealed by the system keyring) print the exact `--cookies-file` export path to use instead. Both paths extract `auth_token` + `ct0` (and any other x.com cookies) and save through the same session storage every later command reads. New reusable module `src/client/auth/cookieImport.js` exports `parseCookieInput`, `detectCookieFormat`, and `readBrowserCookies` from the package root.
- **Every request the HTTP scraper sends is now signed the way x.com's own web client signs it.** x.com attaches an `x-client-transaction-id` header to every GraphQL and internal REST call; XActions generated none, which is one of the cheapest ways to tell a scraper from a browser. `src/scrapers/twitter/http/transactionId.js` builds the value per request from the HTTP method, the request path, the clock, and the `{verification key, animation key}` pair the x.com page itself carries, and `TwitterHttpClient` signs inside its retry loop so no value is ever replayed. `GuestTokenManager.getHeaders({ method, path })` signs too. The keys are extracted once and cached under `$XACTIONS_HOME/transaction-keys.json` for 24 hours, so signing costs one SHA-256 after the first call; a cold cache takes a published pair dictionary (about 200 ms, no bundle parsing) and falls back to parsing x.com's live page and `ondemand.s` chunk (about 350 ms) through the same webpack manifest parser query-ID discovery already uses. Signing never blocks a request: every failure path leaves the request unsigned rather than throwing, and a failed lookup is remembered for ten minutes. Off with `XACTIONS_TRANSACTION_ID=0` or `new TwitterHttpClient({ transactionId: false })`. Measured on the guest tier the header makes no observable difference (`200` and the same 150-per-window budget signed or not); the reported benefit is to how long an authenticated session survives, which only an authenticated multi-day run can confirm. Also fixed while wiring it: `GuestTokenManager.activate()` sent no User-Agent, and `guest/activate.json` answers such a request with a misleading `404 Sorry, that page does not exist`, so the HTTP scraper's guest lane could not get a token at all. Docs: [docs/scraping-infrastructure.md](docs/scraping-infrastructure.md#request-signing-x-client-transaction-id).

### Added

- **`xactions skills` and `--compact`.** `xactions skills list|show|install|uninstall` copies the bundled SKILL.md catalogue into the place your agent reads: `~/.claude/skills/` or `./.claude/skills/` (Claude Code), `./.cursor/rules/*.mdc` (Cursor), `~/.codex/skills/` plus a managed `AGENTS.md` block (Codex), or `./.windsurf/rules/` (Windsurf), idempotently and with a per-skill report; `doctor` now counts installs per target. The new global `--compact` flag prints the read commands (`profile`, `tweets`, `search`, `thread`, `followers`, `following`, `non-followers`, `hashtag`, `media`, `analyze`) as one tab-separated `key=value` record per line with only the essential fields, and `--fields id,text,likes` picks columns; both `--json` and `--compact` keep the spinner silent when stdout is a pipe.
- **Sweep a whole profile: like, repost, and reply to every post.** Doing this by hand on a hundred-post account is twenty minutes of clicking. [`scripts/engageProfile.js`](scripts/engageProfile.js) does it from the console with a floating panel: per-action toggles, speed presets, a 90-second rest every 20 posts, automatic back-off after three failures, DOM-verified actions, progress saved per profile so a reload resumes, undo for likes and reposts, and a JSON export. Replies come from templates (`{author}`, `{name}`, never the same one twice in a row) or from an LLM given a one-line brief. Grok works straight from the console because x.com's CSP allows `api.x.ai`; every other provider goes through the extension.
- **`xactions engage <username>`.** The same sweep from the terminal over the HTTP client: `--like --repost --comment`, `--prompt` for AI replies with any provider (OpenRouter, OpenAI, xAI, Anthropic, Ollama, custom URL), `--template`/`--templates-file`, `--since`, `--dry-run`, `--json`, and resumable progress in `~/.xactions/engage/`. Rate limits pause the run and continue.
- **Extension LLM relay.** The browser extension now answers `LLM_REQUEST` messages from page scripts by calling the provider from its service worker, which is not bound by x.com's Content-Security-Policy. Host permissions were added for OpenRouter, OpenAI, Anthropic, xAI, and localhost.
- **`POST /api/ai/writer/comment`** and `createCommentGenerator()` in `xactions/ai`: prompt-driven reply generation with no voice profile, shared by the CLI, the API, and the extension. Replies are sanitised and regenerated once when they open with boilerplate.


### Added

- **MCP server: tool filtering, Streamable HTTP, and an approval gate.** `XACTIONS_MCP_TOOLS` / `XACTIONS_MCP_EXCLUDE` (or `--tools` / `--exclude`) trim the 149-tool list by name, group (`read`, `write`, `dm`, `analytics`, ...), or `x_get_*` pattern, and a filtered tool is refused with the group to enable rather than a generic error. `xactions-mcp --http [--port 8787] [--host 127.0.0.1]` serves the MCP Streamable HTTP transport on `/mcp`, with bearer auth via `XACTIONS_MCP_TOKEN`; stdio stays the default. `XACTIONS_MCP_REQUIRE_APPROVAL=1` (or `--require-approval`) holds every write tool as a draft in `~/.xactions/mcp-drafts.json` instead of running it, and the always-available `x_list_drafts`, `x_draft_status`, `x_approve_draft`, and `x_discard_draft` tools manage the queue. Also fixed: `x_list_platforms` was declared but never handled and now lists every scraper platform with its capabilities and the adapter registry; 32 tool descriptions that were too short to guide a model were rewritten; and a coverage test now fails the build if a declared tool has no handler. Docs: [MCP setup guide](docs/mcp-setup.md).

### Added

- **GraphQL query IDs refresh themselves from x.com's bundles.** The HTTP scraper pinned every GraphQL query ID to a value copied from twikit, and X rotates those IDs with each web release; on 2026-08-27, 22 of the 26 pinned IDs were stale, including `UserByScreenName`, `TweetDetail` and `SearchTimeline`. `src/scrapers/twitter/http/queryIds.js` now loads an x.com page, reads its webpack chunk manifest, downloads `main` plus the feature chunks that carry our operations, and extracts the live `{queryId, operationName}` pairs into `~/.xactions/query-ids.json` (honours `XACTIONS_HOME`). `TwitterHttpClient` prefers the cached ID over the pinned one, refreshes once and retries when a call answers `404` or a `400` naming the persisted query, and refreshes in the background when the cache is older than 24 hours. The pinned table stays as the offline fallback. `queryIdStatus()` exposes `{cached, fetchedAt, count}` for `xactions doctor`.

### Added

- **Import your official X archive.** `importTwitterArchive(path)` in `src/portability` reads the data export X sends you (the GDPR zip, or the folder you extracted it to) and returns normalised tweets, likes, following, followers, blocks, mutes, DMs grouped by conversation, lists, account, profile and media references. Zips are streamed entry by entry with `yauzl` so multi-gigabyte archives never have to fit in memory; multi-part files (`tweets-part1.js`) are merged in order. `summarizeArchive` and `formatArchiveReport` produce a counts, date range, busiest year and top hashtag report; `exportArchive` writes the import in the same JSON/CSV/Markdown/HTML layout `export` produces, and `migrate` accepts `source: 'twitterArchive'` to go straight from the zip to a Bluesky or Mastodon dry run. See [docs/portability.md](docs/portability.md#import-your-x-archive).

## [3.5.0] - 2026-08-04

### Added

#### A CLI you can find your way around
- **Commands are grouped by task.** Running `xactions` printed fifty-three commands in one flat alphabetical list, which tells a newcomer nothing about where to start and an experienced user nothing about what else exists. The root help now sorts them into eight task-shaped groups (Start here, Read an account, Followers and audience, Search and monitor, Write and grow, Automate, Move data, Low level) with an examples block and pointers to `quickstart`, per-command help, and completions. The grouping is reconciled against the live command tree, so a newly registered command still appears (under "More") and a group entry naming a deleted command is caught by a test rather than shipped.
- **`xactions quickstart`.** A guided first run that reads what you already have configured and prints the three commands that will produce a result on your machine, then the directions worth exploring next. `--json` reports the detected setup state (config directory, whether a session is saved, guest or session tier) for scripts and CI.
- **`xactions completion bash|zsh|fish`.** Tab completion for every command, sub-command, and flag, generated from the live Commander tree rather than a hand-maintained list, so it stays correct as commands are added. Descriptions are escaped per shell: an unescaped colon in zsh's `name:description` format silently truncated half the descriptions, and an apostrophe would have terminated the quoted string early.

### Changed

- **`--json` now works on every read command.** It was accepted by `profile` and `analyze` only; `tweets`, `followers`, `following`, `non-followers`, `search`, `hashtag`, `thread`, and `media` rejected it with `error: unknown option '--json'` despite the docs promising it worked everywhere. All eight now accept it.
- **`--json` outranks `--output` and `--google-sheets`.** Passing both used to write the file and print nothing, so a script that piped `--json` while a config supplied `--output` silently produced no output. `--json` is now an explicit "give me the data on stdout" and wins.

### Documentation

- **[tutorial 05: Read any account like an analyst](tutorials/05-competitive-intelligence.md).** Reading an account report properly (median versus mean, engagement per view versus per follower, lifetime versus recent cadence), comparing accounts, follower overlap, and tracking a series over time. Runs entirely on the guest tier.
- **[tutorial 06: Everything is JSON](tutorials/06-everything-is-json.md).** XActions as a pipeline component: the real field names, jq filters, chaining commands, exit codes in cron and CI, and where to switch from shell to the Node client. Every snippet was run against live data before it was written down.
- **CLI reference corrected.** It carried a hardcoded `Version 3.0.0`, claimed an X account was required (most reads need none), and steered new users to `xactions login` (paste cookies out of DevTools) rather than `xactions connect` (log in through a real browser). It now documents the command groups, `quickstart`, and `completion`.

### Security

- `packages/xactions-mcp` raised off the vulnerable 3.4.4 dependency line, clearing the outstanding `npm audit` advisories. Released as 3.4.8 and carried into this version.


### Fixed

#### Public reads work again, without a browser
- **`Scraper.getProfile()` returned `HTTP 404 {"message":"Query not found"}` for every call.** The repo carried two independent tables of X GraphQL query IDs, and 11 of the client's had gone stale while the shared map stayed current. Query IDs now have exactly one home (`src/scrapers/twitter/http/endpoints.js`), and a test fails if a second copy reappears.
- **The HTTP client could not obtain a guest token at all.** X answers a request with no browser `User-Agent` with a misleading `HTTP 404 "Sorry, that page does not exist"`, which reads like a removed endpoint rather than a rejected client. Every request the client makes now carries one.
- **`xactions profile` printed `Followers: 0` and exited 0.** X stopped serving profile and timeline content to logged-out browsers, so the Puppeteer scrape found an empty page and the CLI reported the nothing it found as success. `profile`, `tweets`, `followers`, `following`, `search`, and `non-followers` now use the HTTP client, which is roughly an order of magnitude faster and needs no Chromium download.
- **`xactions non-followers` reported your entire following list as non-followers.** It filtered on a `followsBack` flag the GraphQL follow lists do not carry, so the predicate matched everything. It now diffs the follower and following lists.
- **The MCP server answered AI agents with every field set to `null`** (issue #27). `x_get_profile` and `x_get_tweets` had the same browser-path problem, which is worse in an agent context: an assistant cannot tell an empty result from a missing one, so it reports confidently wrong answers. Both now prefer the HTTP client and fall back to the browser.
- **Unauthenticated failures now say what to do.** X restricts search, followers, likes, bookmarks, and DMs to logged-in sessions and answers a guest request with a bare `404`. That surfaced as `HTTP 404: Not Found`, which sent people looking for a bug in XActions. It now raises `AUTH_REQUIRED` naming the endpoint and the fix. Errors also carry `endpoint`, `httpStatus`, and `rateLimitReset`, which positional constructor calls had been silently dropping.
- **`xactions login` now captures `ct0` as well as `auth_token`.** Without the CSRF token X treats the session as logged out, so session-tier endpoints kept failing after an apparently successful login.

#### Paid API
- **Every `/api/ai/*` endpoint returned `500` instead of `402`.** `@x402/core` v2 moved payment terms behind an `accepts` key; the flat v1 route shape made the SDK throw during route validation on every request. All 95 payment tests now pass against a live server.

#### Cross-platform
- **Every Bluesky scrape threw `Cannot read properties of undefined (reading '_client')`.** The XRPC helper detached the SDK method from its namespace before calling it. Profiles, posts, and follower lists all work again.
- **Mastodon bios and posts contained raw HTML entities** (`&amp;`, `&#39;`) after tag stripping.

#### Tests
- **`tests/mcp/server.test.js` never ran.** It imported `describe`/`it` from `node:test`, which registers with Node's runner rather than Vitest, so the file reported "No test suite found" and all 144 tool definitions went unvalidated.
- **`tests/x402-integration.test.js` failed for every contributor.** Its skip condition was inverted: it skipped in CI and ran on laptops, so a clean checkout produced 21 red `ECONNREFUSED` failures. It now probes for a server and skips when there is not one.
- Two A2A tests asserted a hardcoded `3.1.0` against the real version.

### Added

#### Examples and tutorials
- **[`examples/`](examples/)** — 8 runnable programs, each verified against the live API before release: profile lookup, timeline analysis, offline sentiment reports, a three-network comparison, CSV export, non-follower analysis, a keyword monitor, and an MCP client that drives the server over stdio.
- **[`tutorials/`](tutorials/)** — four guided walkthroughs: first scrape, MCP with Claude, cleaning up a following list, and building a brand monitor.

#### Documentation that cannot rot
- **`npm run docs:check`** fails on a dead relative link, a dead heading anchor, a referenced script that no longer exists, a stale version claim, a wrong MCP tool count, or a documented CLI command that does not exist. It is dependency-free and runs as its own CI job. It found 87 dead links, 25 stale version and tool-count claims, and 11 invented CLI commands on its first run; all are fixed.
- **`npm run docs:scripts`** regenerates the browser-script catalog from the scripts themselves, so a 93-entry list cannot drift.
- **`npm run check:endpoints`** probes every GraphQL endpoint and distinguishes a rotated query ID from an endpoint that merely needs a session, which is the failure that silently broke the client above.
- Five docs the index had promised but never had: [browser-scripts](docs/browser-scripts.md), [configuration](docs/configuration.md), [database](docs/database.md), [skills](docs/skills.md), [troubleshooting](docs/troubleshooting.md).

#### 40 new browser tools, and the Command Center now covers 108
- Added a full wave of browser-console tools so the toolkit covers essentially every X action, and folded them all into the Command Center (now 108 tools across 11 categories, with two new categories: **Create & Post** and **Lists**):
  - **Create & Post:** post a tweet, post a thread, schedule a post, create a poll, quote tweet, pin/unpin.
  - **Posting actions:** auto-repost, auto-reply to mentions, vote in polls, and **bulk-delete your own posts** by age/keyword/engagement (dry-run by default).
  - **Scrape everything:** followers, following, post likers, reposters + quote-tweeters, a user's likes, search results, a hashtag, a List, profile media, tweet replies, notifications, DMs, and Spaces. Each exports JSON + CSV.
  - **Lists:** create/rename/delete a List, add users to a List, follow all List members.
  - **DMs & account:** bulk/welcome DM, auto-reply DMs, edit full profile, privacy/settings toggles, manage muted words, notification cleaner.
  - **Grow & moderate:** follow-back everyone, remove a follower (dry-run), block-list import/export + block-chaining (dry-run).
  - **Diagnostics:** shadowban checker, tweet performance ranking, sentiment analyzer, audience overlap, trending monitor.
- Every new tool follows the same conventions as the rest: real `data-testid` DOM automation (no fragile hardcoded API IDs), randomized rate limiting, a `window.stop<Tool>()` switch on long loops, page guards, and JSON/CSV export on the scrapers. Bulk/irreversible tools default to a dry run.
- Docs: each tool gets its own page at `/scripts`, plus a Command Center tutorial (`docs/examples/tutorials/command-center-tutorial.md`).

#### Build fix
- Fixed a Command Center bundler bug where a tool containing a `$`-anchored regex template literal (e.g. `` `/${x}/?$` ``) corrupted the generated file, `String.replace` was interpreting the `$\`` sequence as a special replacement pattern. The injector now uses a function replacer.

#### ⚡ XActions Command Center: one script for every tool
- New `scripts/twitter/xactions-command-center.js`: paste one script into the browser console and get a searchable command palette of all 68 browser tools, no more hunting for the right file. Search and arrow-key navigation, nine categories (Scrape, Analytics, Grow, Engage, Clean Up, Moderate, Communities, Profile, Utilities), favorites and recents, and a per-tool options form (rendered from each tool's own config, with an "Edit as JSON" mode) so you never edit source by hand.
- Safety built in: every tool is tagged Safe / Writes / Bulk-irreversible, destructive tools require a second confirming click and show a warning, the palette tells you which page each tool expects (and warns if you're not on it), and a run dock lets you Stop long-running tools individually or all at once.
- Works within x.com's strict CSP: it bundles every tool directly (no remote fetch, no `eval`). Reopen anytime with the floating ⚡ button or Cmd/Ctrl+K.
- Generated by a new build (`scripts/build-toolkit.mjs` + `_command-center-shell.js`) that stays in sync with the tool files and fails the build on any drift. Docs: `scripts/twitter/README-command-center.md`.

### Fixed

#### Browser scripts: re-paste crash fixed repo-wide
- Converted the remaining 40 tools that still declared a top-level `const CONFIG` to `var CONFIG`. Pasting a script a second time into the same DevTools tab threw `Identifier 'CONFIG' has already been declared` and the script never ran, breaking the documented "run it again later" workflow. This finishes the fix an earlier pass started on part of the collection; every tool now re-pastes cleanly.

## [3.4.0] - 2026-07-20

### Fixed

#### Hosted API server crash on boot
- `api/routes/teams.js` default-imported `authMiddleware` from a module that only has named exports — in ESM that's a hard `SyntaxError` at startup, not a warning, so the hosted API server crashed before it could ever answer a health check. This is why xactions.app's dashboard pages (graph, analytics, unfollowers, admin, price-correlation) were showing "backend offline." Fixed and verified with a full local Docker build + boot against a real Postgres container: server starts cleanly, migrations run, `/api/health`, register, login, and authenticated reads all respond correctly. Swept the whole `api/`, `src/`, and `worker/` tree for the same class of bug — no other instances found.

#### Browser console scripts: 64 files audited
- Every script in `scripts/twitter/` (beyond the two already rewritten) was read end-to-end and fixed where real bugs were found. Highlights: all scripts using top-level `const CONFIG` broke on re-paste into an already-open DevTools console (a `SyntaxError`, since `const`/`let` bindings persist across console pastes in the same tab) — fixed to `var` everywhere. Added consistent `window.stopX()` abort switches to every long-running loop that lacked one. Fixed stale-DOM bugs in `mass-unblock.js`/`mass-unmute.js` (cached elements pointing at rows already removed from a virtualized list), a wrong-author-attribution bug on quote-tweets in `bookmark-exporter.js`, a duplicate-processing risk in the hashtag/location commenters, several `window.location.href` reloads that silently killed the running script mid-workflow, and wired up half-implemented options (filters, reply templates, video quality selection) that were declared but never actually checked.

### Added

#### Google Cloud Run deployment for the hosted API
- `deploy/gcp/provision-api.sh` + `deploy/gcp/cloudbuild-api.yaml`: one-shot provisioning (Cloud SQL Postgres, Secret Manager, IAM) and build/deploy for the `xactions-api` Cloud Run service, reusing the existing Memorystore Redis instance instead of standing up new infra. `api/services/jobQueue.js`'s Bull queue now namespaces its Redis keys so it can safely share that instance.

#### Cloudflare Workers Deployment
- Full-site Cloudflare deploy: one Worker serves the landing page, dashboard, docs, blog, and static assets from Workers static assets, replacing the Vercel deployment
- Edge API in the Worker: `/api/health`, `/api/ai/health`, `/api/ai/pricing`, `/openapi.json`, `/.well-known/x402`, and the x402 402 payment gate for `/api/ai/*`
- `API_ORIGIN` proxy: heavy API routes (auth, user, unfollowers, video) forward to the Node backend on Railway/Fly/Docker; a clear 503 with setup instructions when unset
- `npm run build:cloudflare` assembles `dist-cloudflare/` from `site/`, `dashboard/`, `public/`, and `llms*.txt`, mirroring the `vercel.json` route table
- `npm run deploy:cloudflare` builds and deploys via `wrangler deploy`

#### Browser extension install page + extension-first account actions
- New `/extension` page: what the extension does, a 30-second load-unpacked install guide (Chrome/Edge/Brave/Firefox), all 11 automations, and why it runs locally (your X login never leaves your browser)
- Wired into the integrations page, footer, and sitemap
- Hosted service no longer executes X account actions server-side: follow/unfollow/like/reply/post routes return `501` pointing to the extension, so the service never custodies your session token or drives your account from a datacenter. Paid reads (scrape, analytics) are unaffected

## [3.3.0] - 2026-07-19

### Improved

#### Site-wide visual glow-up (X.com-clone kept)
- Enhanced the shared styling (common.css, components.css, docs.css, the injected sidebar) so ~400 pages level up at once: accent gradient + glow, depth shadows, active-nav gradient pill, glowing buttons, card hover lift, refined badges/tabs/inputs/code, ambient background glow, and load-in motion. Layout and blue identity unchanged.
- Landing page and every app page got the same treatment in their own styles.

### Fixed

- App pages (agent, graph, monitor, analytics, thread, video, login, admin, team, unfollowers, price-correlation, and more) now degrade gracefully when the hosted API is offline: designed "backend offline" notices and empty states instead of infinite spinners or console error floods. Stopped runaway polling and socket reconnection. Fixed a broken element id, a stuck loading overlay, and graph's cross-origin CORS calls (now same-origin).
- Docs pages that embedded full script source no longer run 20,000px tall (long code scrolls in a capped box).
- Footer column headings no longer render inline with their first link.
- Repaired every broken documentation cross-link (664 .md links plus repo-file links) and rebuilt the sitemap from 47 stale URLs to 535 real ones.

## [3.2.2] - 2026-07-19

### Added

#### xactions.app is live again, on Cloudflare Pages (free)
- `deploy/cloudflare/`: build script + `_redirects` deploying the full site
  (landing page, dashboard app, docs, tutorials, blog, scripts directory)
  to Cloudflare Pages, free of charge (the prior Vercel deployment was
  disabled and the domain has been down)
- Live now at the Pages project URL; `xactions.app` custom domain pending
  the nameserver switch to Cloudflare at the registrar
- `deploy/gcp/` (Cloud Run + nginx) kept as a fallback path for
  environments without Cloudflare access

## [3.2.1] - 2026-07-19

### Fixed

#### Browser script audit (103 bugs across 52 files)
- Full audit of every paste-in-console script in `scripts/twitter/`; report in `docs/audits/2026-07-19-browser-scripts.md`
- Fatal bugs: 6 scripts killed themselves by navigating mid-run; 3 infinite loops; an action script that liked/followed whatever page was open; blind menu clicks that could trigger unintended actions
- Correctness: quoted-tweet ID misattribution (9 scripts), locale-dependent repost/reply detection (8), K/M/B engagement multiplier and NaN bugs, CSV corruption from unquoted dates, React value-tracker bugs that made update-bio and DM sending silently no-op, wrong-DM-recipient matching, false clipboard success claims
- Reliability: end-of-list stall detection that never fired, missing `videoComponent` selectors, unrevoked Blob URLs, setInterval re-entrancy
- `src/cli/index.js`: `await` in a non-async SIGINT handler crashed the whole CLI on load

### Added

#### Cloud Run deployment for xactions.app
- `deploy/gcp/`: Dockerfile, nginx config, and Cloud Build pipeline serving the landing page, dashboard, docs, tutorials, and blog with the same clean-URL routing the Vercel deployment had (Vercel deployment is disabled and the domain has been down)

## [3.2.0] - 2026-07-19

### Added

#### Scraper Toolbox (browser console)
- `scripts/twitter/scraper-toolbox.js`: interactive on-page control panel for scraping any X timeline (profile, search, list, likes, bookmarks, home)
- Start / pause / resume / stop, live progress, draggable panel, settings persisted in localStorage
- Captures X's own GraphQL responses: exact like/repost/reply/view/bookmark counts, full text of long posts, media URLs, language codes; promoted posts skipped
- Live filters applied at export time: keywords (include/exclude), only/skip specific users, min likes/reposts/views, date range, repost/reply/quote/pinned toggles, media, language
- Exports: JSON, CSV, Markdown, TXT, HTML downloads plus clipboard copy (JSON or clear text)
- Console API: `window.XActionsToolbox`
- Docs: `scripts/twitter/README-scraper-toolbox.md`

### Fixed

#### scrape-profile-posts.js (v2.1.0)
- Elapsed time was reported 3x too small (divided by 3000 instead of 1000)
- HTML export table rendered at 300% width; text export separators were 300 chars wide
- Tweet IDs could be attributed to a quoted tweet's URL instead of the post itself
- Pinned posts were counted as reposts; repost/reply detection no longer depends on the English UI
- End-of-timeline detection never triggered when `verbose: false`
- Video attachments using the newer `videoComponent` testid were not detected

## [3.1.0] - 2026-02-25

### Added

#### Plugin System
- Community plugin architecture — create `xactions-plugin-*` npm packages
- Plugin loader, manager, and template in `src/plugins/`
- CLI commands: `xactions plugin install/list/remove`
- MCP server auto-discovers and registers plugin tools

#### Real-Time Streaming
- Live event streams for tweets, followers, and mentions via Socket.IO
- Puppeteer-based polling with Redis deduplication and rate limit backoff
- Browser pool management (max 3 concurrent instances)
- MCP tools: `x_stream_start`, `x_stream_stop`, `x_stream_list`

#### Workflow Engine
- Declarative JSON automation pipelines with triggers, actions, and conditions
- Cron scheduling, webhook triggers, event-based triggers
- 3 example workflows: competitor monitor, auto-engage keywords, follower growth report
- CLI: `xactions workflow create/run/list`
- MCP tools: `x_workflow_create`, `x_workflow_run`, `x_workflow_list`

#### Cross-Platform Scrapers
- Unified scraper interface: `scrape(platform, type, options)`
- Bluesky support via AT Protocol (@atproto/api) — no Puppeteer needed
- Mastodon support via public REST API — any instance URL
- Threads support via Puppeteer
- Backward compatible — existing Twitter imports unchanged

#### Sentiment Analysis & Reputation Monitoring
- Built-in rule-based sentiment analyzer (works offline, zero dependencies)
- Optional LLM mode via OpenRouter for nuanced analysis
- Reputation monitoring with trend detection and anomaly alerts
- Alert delivery via webhook, Socket.IO, or console
- Daily/weekly reputation reports

#### Account Portability
- Full account export: profile, tweets, followers, following, bookmarks, likes
- Output formats: JSON, CSV, Markdown, self-contained HTML archive viewer
- Export diff tool — compare two snapshots to see changes
- Migration stubs for Bluesky and Mastodon

#### Social Graph Analysis
- Graph builder crawls N degrees from seed account
- Algorithms: mutual connections, bridge accounts, cluster detection, influence scoring
- Exports to D3.js JSON and Gephi GEXF formats
- Self-contained HTML visualization with force-directed layout

#### Browser Extension
- Manifest V3 Chrome/Firefox extension
- Popup UI to run automations without console access
- Content script injection, settings persistence, activity badge

#### Dashboard Enhancements
- `automations.html` — automation control panel with start/stop toggles
- `monitor.html` — real-time activity feed with Chart.js visualizations
- `workflows.html` — visual workflow builder
- `analytics.html` — sentiment timeline, mention analysis, alert configuration
- Full docs site generated at `dashboard/docs/`

#### New API Routes
- `/api/streams` — real-time stream management
- `/api/workflows` — workflow CRUD and execution
- `/api/analytics` — sentiment analysis and monitoring
- `/api/portability` — account export and migration
- `/api/graph` — social graph building and analysis
- `/api/automations` — automation start/stop control
- 15+ additional routes for bookmarks, discovery, engagement, posting, etc.

#### New Browser Scripts
- `engagementBooster.js` — systematic engagement with target accounts
- `sentimentAnalyzer.js` — in-browser sentiment scoring
- `shadowbanChecker.js` — detect account restrictions
- `viralTweetDetector.js` — find viral content early
- `followerGrowthTracker.js` — track growth over time
- `tweetScheduleOptimizer.js` — find best posting times
- `welcomeNewFollowers.js` — auto-welcome with templates
- `quoteTweetAutomation.js` — strategic quote tweeting
- `threadComposer.js` — multi-tweet thread builder
- `contentCalendar.js` — plan and schedule content
- `audienceDemographics.js` — analyze follower demographics
- `accountHealthMonitor.js` — monitor account health signals
- `pinTweetManager.js` — manage pinned tweets
- `bulkDeleteTweets.js` — mass delete old tweets
- `autoReply.js` — automated reply with templates

#### Other
- TypeScript type declarations (`types/index.d.ts`)
- Docker support (Dockerfile + docker-compose)
- New npm exports: `xactions/streaming`, `xactions/analytics`, `xactions/plugins`
- `xactions-mcp` and `xactions-agent` bin commands

### Changed
- MCP server expanded from ~200 to 140+ registered tools
- Package exports updated for multi-platform scraper paths
- Dependencies updated: vitest 4.x, puppeteer 24.x, added node-cron, better-sqlite3, exceljs

## [1.0.0] - 2026-02-11

### Added

- Initial release
