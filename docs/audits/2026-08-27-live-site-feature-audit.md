# XActions audit: every feature on xactions.app, exercised live (2026-08-27)

Scope: the deployed site at `https://xactions.app`, not the repo. Every route the
site publishes was fetched, every interactive dashboard page was loaded in a real
Chromium, the primary action on each feature page was performed for real, and
every API endpoint the dashboard calls was probed directly.

Reproduce with the harness that ships alongside this document:

```bash
node scripts/audit-site.mjs                        # audit https://xactions.app
node scripts/audit-site.mjs --base http://localhost:8787
node scripts/audit-site.mjs --routes-only          # skip Chromium
```

It writes `tmp/site-audit/site-audit.json` (full detail: status codes, console
errors, failed subresources, per-feature API calls and their response bodies) and
`tmp/site-audit/SITE_AUDIT.md` (the summary), and exits non-zero when anything
fails, so it can gate a deploy. Chromium comes from `playwright`; point `NODE_PATH`
at a tree that has it if this repo's `node_modules` does not.

## Result of the first run

| Sweep | Checked | Failing |
|---|---:|---:|
| Routes | 719 | 198 |
| Pages loaded in Chromium | 46 | 10 |
| Features exercised | 6 | 5 |
| API endpoints | 27 | 27 |

## 1. The whole API surface is missing, not broken

Every `/api/*` path answers with the static 404 page, including the ones that are
supposed to be free and unauthenticated:

| Endpoint | Live status |
|---|---|
| `GET /api/health` | 404 (HTML) |
| `GET /api/ai/health`, `GET /api/ai/pricing` | 404 (HTML) |
| `GET /api/ask/health`, `POST /api/ask` | 404 (HTML) |
| `GET /openapi.json`, `GET /.well-known/x402` | 404 (HTML) |
| `POST /api/video/extract` | 405, empty body |
| `POST /api/thread/unroll`, `GET /api/graph/:handle`, `GET /api/analytics/*` | 404 (HTML) |

The 405 on `POST` and the 404-page body on `GET` are both the signature of a
static asset server answering: nothing dynamic is deployed in front of it. The
consequences a user sees are "Video API is temporarily unavailable" on `/video`,
an empty graph on `/graph`, and five 404s in the console on `/agent`.

Cause: xactions.app is served by a Cloudflare **Pages** project built from
`deploy/cloudflare/build.sh`, whose only dynamic rule is this line in
`deploy/cloudflare/_redirects`:

```
/api/* https://web-production-2eb69.up.railway.app/api/:splat 200
```

That Railway deployment is gone, and Cloudflare Pages does not proxy `_redirects`
rules to an external origin anyway, so the rule was never doing anything.

The repo already holds the replacement: `worker/index.js` plus `wrangler.toml`
serve the same static assets **and** the edge API (`/api/health`, `/api/ai/health`,
`/api/ai/pricing`, `/api/ask`, `/openapi.json`, `/.well-known/x402`, the x402
payment gate) from one Cloudflare Worker, with `run_worker_first = ["/api/*", ...]`.
Deploying that Worker is what puts the API back. It needs a Cloudflare API token,
which is the one thing this audit could not supply for itself.

## 2. The deployment is stale by roughly 200 pages

The live sitemap lists 535 URLs; the repo's lists 707. Everything in the gap
404s, including whole documentation sections and several product pages:

| Group | 404s |
|---|---:|
| `/docs/step-by-step/*` | 62 |
| `/docs/guides/*` | 57 |
| `/docs/prompts/*` | 24 |
| `/docs/skills/*` | 17 |
| `/scripts/*` | 25 |
| `/ask`, `/playground`, `/examples`, `/extension` | 4 |

These pages all exist in `dashboard/` on `main`. They are missing because the
deployment predates them, not because anything is wrong with them. The same
Worker deploy fixes this: `scripts/build-cloudflare.mjs` assembles
`dist-cloudflare/` from `dashboard/`, `site/` and `public/` in one pass.

## 3. Guest reads were returning nothing (fixed)

Independent of the deployment, the no-login read path was broken end to end, which
would have kept `/analytics`, `/graph`, `/playground`, `/thread` and the profile
scrape empty even with the API deployed. Three causes, all fixed in
`fix(scrapers): follow x.com's GraphQL envelope and typed User shape`:

- `client.graphql()` returned x.com's raw body as `.data`, one level deeper than
  every scraper reads. The `data` envelope is stripped now.
- x.com moved `User` fields out of `legacy` into `core`, `avatar`, `banner`,
  `location`, `privacy`, `website`, `profile_bio`, `relationship_counts`,
  `tweet_counts`, `action_counts`, `verification` and `pinned_items`. Guest
  responses carry no `legacy` block at all. `parseUserData` and the author block of
  `parseTweetData` read the typed shape first, with `legacy` as the fallback.
- The user timeline container was renamed `timeline_v2` to `timeline`, so every
  timeline read parsed an empty instruction list. Both names are accepted.

The test suite had been masking the first of these: the `http-scraper` fixtures
served the inner half of each response, so the double-nesting cancelled out. They
now serve the full body x.com puts on the wire.

Verified live with a guest token: `scrapeProfile('nasa')`, `scrapeTweets('nasa')`
and `scrapeTweetById` all return real data, and `node scripts/verify-live.mjs`
turns the badge green.

## 4. Still open

- **Deploy the Worker.** Needs a Cloudflare API token. Until then every fix above
  is correct in the repo and invisible on the site.
- **Thread unroll for guests.** `TweetDetail` answers 404 to a guest token, so
  `scrapeThread` cannot reconstruct a conversation without a session. The focal
  tweet reads fine through `TweetResultByRestId`; the reply chain needs either a
  session cookie or the syndication lane.
- **Heavy routes.** Auth, billing, admin, teams, operations and the job queue need
  the Node backend and a database. With `API_ORIGIN` unset the Worker answers 503
  with setup instructions, which is honest but is still a dead feature on the page.
