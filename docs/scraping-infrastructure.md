# Scraping Infrastructure

> Enterprise-grade scraping toolkit: proxy rotation, stealth browser, pagination engine, retry policies, and dataset storage — replaces Phantombuster, Apify, and similar SaaS tools.

## Overview

The scraping infrastructure (`src/scraping/`) provides three production-grade modules that work together to make scraping reliable at scale:

- **ProxyManager** — Proxy rotation with health tracking and auto-blacklisting
- **StealthBrowser** — Anti-detection Puppeteer wrapper with fingerprint randomization
- **PaginationEngine** — Smart scroll-based pagination with deduplication, checkpointing, and retry

These modules power all XActions scrapers internally and are also available as standalone imports.

---

## Architecture

```
src/scraping/
├── proxyManager.js       → Proxy rotation, health tracking, auto-blacklist
├── stealthBrowser.js     → Anti-detection Puppeteer with fingerprint randomization
└── paginationEngine.js   → Pagination, deduplication, checkpoints, retry, datasets
```

Data directories:
- `~/.xactions/datasets/` — Stored scraping datasets
- `~/.xactions/scrape-checkpoints/` — Pagination checkpoints for resume

---

## Quick Start

```javascript
import { ProxyManager } from 'xactions/src/scraping/proxyManager.js';
import { launchStealthBrowser, createStealthPage } from 'xactions/src/scraping/stealthBrowser.js';
import { PaginationEngine, RetryPolicy } from 'xactions/src/scraping/paginationEngine.js';

// 1. Set up proxies (optional)
const proxies = new ProxyManager(['http://proxy1:8080', 'http://proxy2:8080']);
await proxies.testAll();

// 2. Launch stealth browser
const proxy = proxies.getNext();
const browser = await launchStealthBrowser({ proxy, headless: true });
const page = await createStealthPage(browser, { proxy });

// 3. Scrape with pagination
const engine = new PaginationEngine({
  maxPages: 50,
  maxItems: 1000,
  scrollDelay: 1500,
  retries: 3,
  deduplicateBy: 'id',
  onProgress: (stats) => console.log(`${stats.total} items...`),
});

const result = await engine.scrapeWithPagination(page, async (page) => {
  return page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid="tweet"]')].map(el => ({
      id: el.querySelector('a[href*="/status/"]')?.href,
      text: el.querySelector('[data-testid="tweetText"]')?.textContent,
    }));
  });
});

console.log(`Scraped ${result.items.length} items in ${result.stats.duration}ms`);
await browser.close();
```

---

## Proxy Manager

### Creating

```javascript
import { ProxyManager } from 'xactions/src/scraping/proxyManager.js';

// From array
const pm = new ProxyManager([
  'http://user:pass@proxy1.example.com:8080',
  'socks5://proxy2.example.com:1080',
  '192.168.1.100:3128',
]);

// From file (one proxy per line)
const pm2 = new ProxyManager();
await pm2.loadFromFile('/path/to/proxies.txt');

// From environment variables
const pm3 = new ProxyManager();
pm3.loadFromEnv();
// Reads: XACTIONS_PROXIES (comma-separated) and XACTIONS_PROXY_FILE
```

### Rotation Strategies

```javascript
// Round-robin (deterministic)
const proxy = pm.getNext();

// Random selection
const proxy = pm.getRandom();
```

### Health Tracking

The proxy manager automatically tracks success/failure rates:

```javascript
// Mark results after each request
pm.markSuccess(proxy.url, responseTimeMs);
pm.markFailed(proxy.url);

// 3 consecutive failures → 10 minute blacklist (automatic)
// Blacklisted proxies are excluded from getNext()/getRandom()

// Get health stats
const stats = pm.getStats();
// [{ url, successes, failures, avgResponseTime, blacklisted }]

// Get only healthy proxies
const healthy = pm.getHealthy();
```

### Testing

```javascript
const results = await pm.testAll();
// Tests all proxies concurrently against httpbin.org
// Returns: [{ proxy, status: 'ok'|'failed', time }]
```

### Supported Formats

| Format | Example |
|--------|---------|
| HTTP | `http://proxy:8080` |
| HTTP with auth | `http://user:pass@proxy:8080` |
| SOCKS5 | `socks5://proxy:1080` |
| SOCKS4 | `socks4://proxy:1080` |
| host:port | `192.168.1.1:3128` |
| user:pass@host:port | `admin:secret@proxy:8080` |

---

## Stealth Browser

Anti-detection Puppeteer wrapper that evades bot detection.

### Features

- **puppeteer-extra-plugin-stealth** integration (with graceful fallback)
- 20 rotating user-agent strings (Chrome, Firefox, Safari, Windows, Mac, Linux)
- Random viewport dimensions (1280-1920 × 720-1080)
- WebDriver flag override (`navigator.webdriver = false`)
- Language, plugins, platform spoofing
- Proxy authentication support
- No-sandbox mode for Docker/CI

### Launch Browser

```javascript
import { launchStealthBrowser, createStealthPage } from 'xactions/src/scraping/stealthBrowser.js';

const browser = await launchStealthBrowser({
  proxy: 'http://proxy:8080',   // Optional
  headless: true,               // Default: true
  userDataDir: '/tmp/chrome1',  // Optional: persistent profile
  viewport: { width: 1920, height: 1080 }, // Optional: custom size
  userAgent: 'Mozilla/5.0...',  // Optional: override UA
});

const page = await createStealthPage(browser, {
  proxy: { url: 'http://proxy:8080', username: 'user', password: 'pass' },
  userAgent: 'Custom UA', // Optional override
});
```

### Anti-Detection Patches

Applied automatically on every page:

| Patch | What it does |
|-------|-------------|
| `navigator.webdriver` | Returns `false` instead of `true` |
| `navigator.languages` | Returns `['en-US', 'en']` |
| `navigator.plugins` | Returns fake plugin list |
| `navigator.platform` | Matches user-agent OS |
| User-Agent | Random selection from 20 real browser UAs |
| Viewport | Random dimensions within realistic range |

---

## Pagination Engine

Handles infinite-scroll pages with deduplication, error recovery, and checkpointing.

### Basic Usage

```javascript
import { PaginationEngine } from 'xactions/src/scraping/paginationEngine.js';

const engine = new PaginationEngine({
  maxPages: 100,        // Max scroll iterations
  maxItems: 5000,       // Stop after this many items
  pageTimeout: 30000,   // 30s timeout per scroll
  scrollDelay: 1500,    // Delay between scrolls (ms)
  retries: 3,           // Retries on error
  deduplicateBy: 'id',  // Deduplicate items by this field
  onProgress: (stats) => console.log(stats),
});

const { items, stats } = await engine.scrapeWithPagination(page, extractFn);
```

### Deduplication

```javascript
// By field name
new PaginationEngine({ deduplicateBy: 'url' });

// By custom function
new PaginationEngine({
  deduplicateBy: (item) => `${item.username}:${item.tweetId}`,
});
```

### Checkpointing

Save progress and resume later:

```javascript
// Save checkpoint mid-scrape
const checkpointPath = await engine.saveCheckpoint('my-scrape-001');
// Saved to ~/.xactions/scrape-checkpoints/my-scrape-001.json

// Resume from checkpoint
const engine2 = new PaginationEngine({ maxItems: 5000 });
await engine2.resume(checkpointPath);
const { items } = await engine2.scrapeWithPagination(page, extractFn);
```

### Error Recovery

The engine automatically handles:
- **Stuck detection** — Stops after 3 consecutive empty scrolls
- **Error page detection** — Pauses 60s on "Rate limit" or "Something went wrong"
- **Scroll errors** — Retries with 5s delay

### Stats

```javascript
const { items, stats } = await engine.scrapeWithPagination(page, extractFn);

console.log(stats);
// {
//   total: 2500,
//   duplicatesRemoved: 340,
//   pagesScrolled: 85,
//   errorsRecovered: 2,
//   duration: 128000
// }
```

---

## Retry Policy

Standalone retry utility with exponential backoff.

```javascript
import { RetryPolicy } from 'xactions/src/scraping/paginationEngine.js';

const retry = new RetryPolicy({
  maxRetries: 3,
  baseDelay: 2000,       // Initial delay: 2s
  maxDelay: 60000,       // Cap at 60s
  backoffMultiplier: 2,  // Double each time: 2s → 4s → 8s
  retryOn: ['timeout', 'network-error', 'rate-limit', 'empty-result'],
});

const result = await retry.execute(async () => {
  const response = await fetch('https://api.example.com/data');
  if (!response.ok) throw new Error('Request failed');
  return response.json();
});
```

### Error Classification

| Error Type | Triggered By | Retried? |
|-----------|-------------|----------|
| `timeout` | AbortError, TimeoutError | ✅ |
| `network-error` | ECONNREFUSED, ENOTFOUND, fetch failures | ✅ |
| `rate-limit` | 429 status, "Rate limit" in message | ✅ |
| `empty-result` | Custom "empty" errors | ✅ |
| Other | Unrecognized errors | ❌ (thrown immediately) |

---

## Dataset Storage

The PaginationEngine stores results in `~/.xactions/datasets/` as JSON files, compatible with the Apify dataset format.

### CLI

```bash
# List datasets
xactions dataset list

# Export a dataset
xactions dataset export my-scrape --format json --output data.json
xactions dataset export my-scrape --format csv --output data.csv

# Delete
xactions dataset delete my-scrape
```

### API

```http
GET    /api/datasets/                    # List
GET    /api/datasets/:name               # Get items
GET    /api/datasets/:name/export?format=json
DELETE /api/datasets/:name
```

---

## Scraper Adapters

XActions includes adapter wrappers for multiple scraping backends (`src/scrapers/adapters/`):

| Adapter | Uses | Best For |
|---------|------|----------|
| `puppeteer` | Puppeteer + stealth | Default — full JavaScript rendering |
| `playwright` | Playwright | Alternative to Puppeteer |
| `cheerio` | cheerio | Static HTML (fastest) |
| `got-jsdom` | got + jsdom | Lightweight JS rendering |
| `crawlee` | Crawlee framework | Large-scale crawling |
| `selenium` | selenium-webdriver | Legacy compatibility |

All adapters implement the same `BaseScraper` interface:

```javascript
import { createScraper } from 'xactions/src/scrapers/adapters/index.js';

const scraper = createScraper('puppeteer'); // or 'playwright', 'cheerio', etc.
await scraper.init();
const data = await scraper.scrape(url, options);
await scraper.close();
```

---

## Cross-Platform Scrapers

XActions scrapers support multiple social platforms:

| Platform | Module | Features |
|----------|--------|----------|
| Twitter/X | `src/scrapers/twitter/` | Profiles, followers, tweets, search, media |
| Bluesky | `src/scrapers/bluesky/` | Profiles, followers, posts |
| Mastodon | `src/scrapers/mastodon/` | Profiles, followers, toots (any instance) |
| Threads | `src/scrapers/threads/` | Profiles, followers, posts |

```javascript
import scrapers from 'xactions/scrapers';

// Twitter (default)
const profile = await scrapers.scrapeProfile(page, 'nichxbt');

// Bluesky
import bluesky from 'xactions/scrapers/bluesky';
const bskyProfile = await bluesky.getProfile('nichxbt.bsky.social');

// Mastodon
import mastodon from 'xactions/scrapers/mastodon';
const mastoProfile = await mastodon.getProfile('user', 'https://mastodon.social');
```

---

## GraphQL Query ID Discovery

Every GraphQL call to x.com is addressed by a persisted query ID
(`/i/api/graphql/<queryId>/<operationName>`). X rotates those IDs whenever it
ships a new web bundle, and a stale ID answers `404 Query not found`. That is
the single most common way a no-API client breaks, and the reason a scraper
that worked last month stops working with no code change.

The HTTP scraper refreshes its IDs the way the web client does, from x.com's
own JavaScript bundles (`src/scrapers/twitter/http/queryIds.js`):

1. Load an x.com page that still ships the classic client (`/home`, then
   `/i/flow/login`). `https://x.com/` itself is a server-rendered shell with
   no bundles, so it is only a last resort.
2. Read the inline webpack runtime's chunk manifest (chunk name to hash) and the
   `main.*.js` URL.
3. Download `main` plus the feature chunks that carry the operations XActions
   uses (`bundle.LoggedInMain`, `ondemand.HoverCard`, the Bookmarks, HomeTimeline
   and TweetActivity `shared~` chunks, ...). About 2 MB in total. A full sweep of
   every chunk (`scope: 'full'`) is ~130 MB and only worth it when you need an
   operation outside the table.
4. Extract every `{queryId, operationName, operationType}` descriptor and write
   them to `~/.xactions/query-ids.json` (or `$XACTIONS_HOME/query-ids.json`)
   with a `fetchedAt` timestamp.

### Resolution order

For any operation: the cached/discovered ID, then the hardcoded table in
`src/scrapers/twitter/http/endpoints.js`. Offline behaviour is unchanged: with
no cache and no network the hardcoded IDs are used exactly as before. The cache
wins over the table because it was read from x.com's live bundle, and the
table value may have rotated since it was pinned.

### When it refreshes

`TwitterHttpClient` handles this on its own:

- A GraphQL call that fails with `404`, or `400` with an error naming the
  persisted query, triggers one refresh and one retry with the new ID. If the
  refreshed ID is unchanged, or discovery fails (offline), the original error is
  rethrown. Mutations are only retried when the first attempt was rejected for a
  stale ID, so nothing is ever sent twice.
- When the cache is older than 24 hours, a refresh starts in the background (at
  most once per hour per process) without blocking the call.

Pass `autoRefreshQueryIds: false` to the client to turn both off. Under vitest
the default is off, so unit tests never reach the network unless they opt in.

### API

```javascript
import {
  discoverQueryIds,
  refreshQueryIds,
  getQueryId,
  resolveOperation,
  queryIdStatus,
} from 'xactions/scrapers/twitter/http/queryIds.js';

// Probe x.com now and persist the result
const { count, source, cachePath } = await discoverQueryIds();
console.log(`${count} operations from ${source.mainBundle} -> ${cachePath}`);

// Cache > discovered > hardcoded, never touches the network
getQueryId('TweetDetail');                 // 'XMOz5h24KAZ86qKffKTLdQ'
resolveOperation('Likes');                 // { queryId, operationName: 'Favoriters', source: 'cache' }

// Force a refresh (concurrent callers share one in-flight discovery)
await refreshQueryIds({ fetch: myProxiedFetch, scope: 'full' });

// For diagnostics (`xactions doctor` reads this)
queryIdStatus();                           // { cached, fetchedAt, count, cachePath, stale }
```

`resolveOperation` accepts either an operationName (`Favoriters`) or a key of
the hardcoded table (`Likes`). `src/client/api/graphqlQueries.js` reads the same
cache on every access, so the high-level `Scraper` client benefits without
changes.

### Verifying against live x.com

```bash
node --input-type=module -e '
import { discoverQueryIds } from "./src/scrapers/twitter/http/queryIds.js";
import { GRAPHQL } from "./src/scrapers/twitter/http/endpoints.js";
const r = await discoverQueryIds({ persist: false });
for (const e of Object.values(GRAPHQL)) {
  const live = r.operations[e.operationName]?.queryId;
  console.log(e.operationName.padEnd(26), live === e.queryId ? "match" : `differs (${live})`);
}'
```

On 2026-08-27 this found 148 operations and 22 of the 26 hardcoded IDs had
rotated, including `UserByScreenName`, `TweetDetail` and `SearchTimeline`.

---

## Account Pool and Resumable Scrapes (HTTP scraper)

One X session gets roughly 50 GraphQL calls per operation per 15-minute window, which caps a single-account follower scrape at about 1,000 users before it stalls. The HTTP scraper solves this the way [twscrape](https://github.com/vladkens/twscrape) does: a pool of accounts in SQLite, per-account per-operation rate-limit tracking from the `x-rate-limit-*` headers, and automatic rotation. Interrupted scrapes resume from a saved cursor, the idea behind [Scweet](https://github.com/Altimis/Scweet)'s resume mode.

Both live in `src/scrapers/twitter/http/` and are exported from `xactions/src/scrapers/twitter/http/index.js`.

### Account pool

```javascript
import { createAccountPool, createPooledClient, createCheckpoint, scrapeFollowers } from 'xactions/src/scrapers/twitter/http/index.js';
import fs from 'node:fs';

// Accounts persist in $XACTIONS_HOME/accounts.db (default ~/.xactions/accounts.db).
// Cookies accept a header string, Netscape cookies.txt text, a Cookie-Editor JSON
// export, Playwright storageState, an array of { name, value }, or authToken + ct0.
const pool = createAccountPool({
  accounts: [
    { name: 'main', authToken: process.env.X_AUTH_TOKEN_1, ct0: process.env.X_CT0_1 },
    { name: 'alt', cookies: fs.readFileSync('./alt-cookies.txt', 'utf8'), proxy: 'socks5://127.0.0.1:1080' },
  ],
});

// Manage it like a CLI would
pool.add({ name: 'third', cookies: 'auth_token=...; ct0=...' });
pool.importCookies('fourth', fs.readFileSync('./cookies.json', 'utf8'));
pool.remove('third');
console.log(pool.list());   // [{ name, proxy, locked, lockReason, lastUsed, limits: { Followers: { remaining, resetAt, coolingDown } } }]
console.log(pool.stats());  // { total, locked, leased, available, coolingDown, nextResetAt, accounts }
```

Each account gets its own `TwitterHttpClient` with its cookies and proxy (proxies route through undici's `ProxyAgent`). `acquire(operation)` leases the least-recently-used account that is unlocked and outside its rate-limit window for that operation; when every account is cooling down it waits for the earliest reset (bounded by `maxWaitMs`, default 15 minutes) and throws an `AccountPoolError` naming the next reset when the wait would exceed the budget.

```javascript
const lease = await pool.acquire('Followers', { maxWaitMs: 60_000 });
try {
  const page = await lease.client.graphql(queryId, 'Followers', variables);
} finally {
  lease.release();
}
pool.markLocked('alt', 'challenge required'); // skipped by acquire until pool.unlock('alt')
```

### Pooled client

`createPooledClient(pool)` exposes the same `graphql()`, `request()`, `rest()`, and `graphqlPaginate()` as a single client and passes as the `client` argument of every scraper. A 429 (or a response whose `x-rate-limit-remaining` reaches 0) records the window and retries the same call on the next account; a 401/403 locks the account and moves on. After every account has been tried the last error is rethrown.

```javascript
const client = createPooledClient(pool, {
  maxAccounts: 3,                    // most accounts one call may try (default: pool size)
  onRotate: ({ from, operation, reason }) => console.log(`${operation}: ${from} ${reason}`),
});

const followers = await scrapeFollowers(client, 'elonmusk', { limit: 5000 });
```

### Resumable scrapes

A checkpoint is a small JSON file (`{ cursor, count, updatedAt, meta }`) written atomically after every page under `$XACTIONS_HOME/checkpoints/`. Pass it as the `checkpoint` option of `scrapeFollowers`, `scrapeFollowing`, `scrapeLikers`, `scrapeRetweeters`, `scrapeListMembers`, `scrapeTweets`, `scrapeTweetsAndReplies`, or `searchTweets`. A run that starts with a saved checkpoint continues from its cursor, and the `count` already collected is subtracted from `limit`, so re-running the same command finishes the job. The file is deleted when the scrape completes.

```javascript
const checkpoint = createCheckpoint({ key: 'followers:elonmusk' });

// Run 1 dies at page 400 (rate-limit wall, network drop, Ctrl-C).
// Run 2, same call, starts at the page-400 cursor with the remaining budget.
const rest = await scrapeFollowers(client, 'elonmusk', { limit: 50000, checkpoint });

console.log(checkpoint.resume()); // null once finished; otherwise { cursor, count, updatedAt, meta }
checkpoint.clear();               // start over
```

Because a resumed run returns only the users fetched after the cursor, write results out as they arrive (for example from `onProgress`, or by appending each run's output) rather than relying on a single final array.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `XACTIONS_PROXIES` | Comma-separated proxy list |
| `XACTIONS_PROXY_FILE` | Path to proxy list file |
| `XACTIONS_SESSION_COOKIE` | Default X/Twitter auth token |
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chrome path |

---

## Tips

- **Start without proxies** — Most use cases don't need them for moderate volumes
- **Use checkpointing** for large scrapes (>1000 items) — resume if interrupted
- **Set `deduplicateBy`** to avoid counting the same item twice during scrolling
- **Monitor `stats.errorsRecovered`** — high values indicate rate limiting
- **Rotate user data dirs** for multi-account scraping to maintain separate cookies
- **Use the stealth browser** even without proxies — the anti-detection patches alone reduce block rates significantly
