# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Sweep a whole profile: like, repost, and reply to every post.** Doing this by hand on a hundred-post account is twenty minutes of clicking. [`scripts/engageProfile.js`](scripts/engageProfile.js) does it from the console with a floating panel: per-action toggles, speed presets, a 90-second rest every 20 posts, automatic back-off after three failures, DOM-verified actions, progress saved per profile so a reload resumes, undo for likes and reposts, and a JSON export. Replies come from templates (`{author}`, `{name}`, never the same one twice in a row) or from an LLM given a one-line brief. Grok works straight from the console because x.com's CSP allows `api.x.ai`; every other provider goes through the extension.
- **`xactions engage <username>`.** The same sweep from the terminal over the HTTP client: `--like --repost --comment`, `--prompt` for AI replies with any provider (OpenRouter, OpenAI, xAI, Anthropic, Ollama, custom URL), `--template`/`--templates-file`, `--since`, `--dry-run`, `--json`, and resumable progress in `~/.xactions/engage/`. Rate limits pause the run and continue.
- **Extension LLM relay.** The browser extension now answers `LLM_REQUEST` messages from page scripts by calling the provider from its service worker, which is not bound by x.com's Content-Security-Policy. Host permissions were added for OpenRouter, OpenAI, Anthropic, xAI, and localhost.
- **`POST /api/ai/writer/comment`** and `createCommentGenerator()` in `xactions/ai`: prompt-driven reply generation with no voice profile, shared by the CLI, the API, and the extension. Replies are sanitised and regenerated once when they open with boilerplate.


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
