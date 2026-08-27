# Scrapers

Multi-platform, multi-framework scraping system. Supports Twitter/X, Bluesky, Threads, and Mastodon with pluggable browser backends.

---

## Quick Start

### Node.js

```js
import {
  createBrowser,
  createPage,
  loginWithCookie,
  scrapeProfile,
  scrapeFollowers,
  scrapeTweets,
  searchTweets,
} from 'xactions/scrapers';

const browser = await createBrowser();
const page = await createPage(browser);
await loginWithCookie(page, process.env.X_AUTH_TOKEN);

// Scrape a profile
const profile = await scrapeProfile(page, 'elonmusk');

// Scrape followers (paginated)
const followers = await scrapeFollowers(page, 'nichxbt', { max: 500 });

// Scrape recent tweets
const tweets = await scrapeTweets(page, 'nichxbt', { max: 100 });

// Search tweets
const results = await searchTweets(page, 'XActions', { max: 50 });

await browser.close();
```

### CLI

```bash
xactions scrape profile elonmusk
xactions scrape followers nichxbt --max 500
xactions scrape tweets nichxbt --max 100
xactions search "AI agents" --max 50
```

### Browser Script

```js
// Paste in DevTools console on x.com
// Scrape followers from the current page
// See scripts/scrapeFollowers.js
```

---

## Platforms

### Twitter/X (Primary)

Full support for all scraping operations via browser automation on x.com.

```js
import { twitter } from 'xactions/scrapers';

const profile = await twitter.scrapeProfile(page, 'elonmusk');
const followers = await twitter.scrapeFollowers(page, 'nichxbt');
const tweets = await twitter.scrapeTweets(page, 'nichxbt');
```

### Bluesky

```js
import { bluesky } from 'xactions/scrapers';

const profile = await bluesky.scrapeProfile('user.bsky.social');
```

### Threads

```js
import { threads } from 'xactions/scrapers';

const profile = await threads.scrapeProfile('zuck');
```

### Mastodon

```js
import { mastodon } from 'xactions/scrapers';

const profile = await mastodon.scrapeProfile('user@mastodon.social');
```

---

## Scraper Functions (Twitter/X)

| Function | Description |
|----------|-------------|
| `scrapeProfile(page, username)` | Name, bio, followers, following, verified status |
| `scrapeFollowers(page, username, opts)` | Paginated follower list with profiles |
| `scrapeFollowing(page, username, opts)` | Paginated following list |
| `scrapeTweets(page, username, opts)` | User's tweets with engagement counts |
| `searchTweets(page, query, opts)` | Search results |
| `scrapeThread(page, tweetUrl)` | Full thread (all replies in chain) |
| `scrapeLikes(page, username, opts)` | User's liked tweets |
| `scrapeHashtag(page, hashtag, opts)` | Tweets containing a hashtag |
| `scrapeMedia(page, username, opts)` | User's media tweets (images/video) |
| `scrapeListMembers(page, listId, opts)` | Members of a Twitter list |
| `scrapeBookmarks(page, opts)` | Your bookmarked tweets |
| `scrapeNotifications(page, opts)` | Your notification feed |
| `scrapeTrending(page)` | Current trending topics |
| `scrapeCommunityMembers(page, communityId, opts)` | Community members |

### Options

Most scraper functions accept an options object:

```js
const opts = {
  max: 500,          // Maximum items to scrape
  delay: 1500,       // Delay between scroll/pagination (ms)
  format: 'json',    // Output format: 'json' | 'csv'
  output: 'out.json' // File to save results to
};
```

---

## Communities, notifications, trends and Spaces (HTTP client)

These run on the HTTP client, not Puppeteer: no browser starts, and each call is
one GraphQL request. Import them from `xactions/scrapers/twitter/http`, or reach
them as methods on the object `createHttpScraper()` returns. Every read here
needs a logged-in session (`xactions login`); trends by place are the exception
and work on the guest tier.

```js
import { createHttpScraper } from 'xactions/scrapers/twitter/http';

const x = await createHttpScraper({ cookie: process.env.X_COOKIE });

const community = await x.scrapeCommunity('1493446837214187523');
const posts = await x.scrapeCommunityTweets(community.id, { limit: 100 });
const mine = await x.scrapeMyCommunities();
```

### Communities

| Function | Description |
|----------|-------------|
| `scrapeCommunity(id)` | Community details: name, description, member count, rules, moderators |
| `scrapeCommunityTweets(id, opts)` | Community timeline, `{ ranking: 'latest' \| 'top' }` |
| `scrapeCommunityMedia(id, opts)` | Media posts from a community |
| `searchCommunityTweets(query, opts)` | Search within communities |
| `scrapeMyCommunities(opts)` | Communities the logged-in account belongs to |
| `scrapeCommunityDiscovery(opts)` | Communities X suggests |
| `joinCommunity(id)` / `leaveCommunity(id)` | Membership mutations |
| `requestToJoinCommunity(id, opts)` | Ask to join a restricted community |

### Notifications

| Function | Description |
|----------|-------------|
| `scrapeNotifications(opts)` | The full notifications timeline as typed events |
| `scrapeMentions(opts)` | The Mentions tab only |
| `scrapeVerifiedNotifications(opts)` | The Verified tab only |

Each entry is normalised to `{ id, type, users, tweet, timestamp }`, where
`type` is one of `follow`, `like`, `retweet`, `reply`, `mention`, `quote` or
`generic`, so a notification handler can switch on it without reading X's raw
entry shapes.

### Trends, highlights and Spaces

| Function | Description |
|----------|-------------|
| `scrapeTrends(opts)` | Trends for the account's own location |
| `scrapeTrendsByWoeid(woeid)` | Trends for a place; `1` is worldwide |
| `scrapeTrendLocations()` | Every place X publishes trends for, with WOEIDs |
| `scrapeExplorePage(opts)` | The Explore tab, tab by tab |
| `scrapeHighlights(user, opts)` | Posts an account pinned to its Highlights tab |
| `scrapeArticles(user, opts)` | Long-form Articles by an account |
| `scrapeVerifiedFollowers(user, opts)` | Verified followers only |
| `scrapeFollowersYouKnow(user, opts)` | Followers the logged-in account also follows |
| `scrapeAudioSpace(spaceId)` | Space details: title, state, host, speakers, listener count |

```js
// What is trending in Japan right now (woeid 23424856)
const jp = await x.scrapeTrendsByWoeid(23424856);
console.log(jp.map((t) => `${t.name} (${t.postCount ?? 'n/a'})`).join('\n'));
```

The query IDs behind all of these are discovered from x.com at runtime and
cached, so they keep working when X rotates them. See
[Scraping infrastructure](scraping-infrastructure.md#graphql-query-id-discovery).

---

## Adapter System

Swap browser backends without changing scraper code.

### Available Adapters

| Adapter | Package | Description |
|---------|---------|-------------|
| `puppeteer` | puppeteer | Default. Chromium headless browser |
| `playwright` | playwright | Multi-browser (Chromium, Firefox, WebKit) |
| `cheerio` | cheerio | HTTP-only, no browser (limited to public pages) |
| `got-jsdom` | got + jsdom | HTTP + DOM parsing |
| `selenium` | selenium-webdriver | Selenium WebDriver |
| `crawlee` | crawlee | Apify's crawling framework |

### Switching Adapters

```js
import { setDefaultAdapter, getAdapter, listAdapters } from 'xactions/scrapers';

// List available adapters
console.log(listAdapters());

// Switch to Playwright
setDefaultAdapter('playwright');

// Or use a specific adapter for one operation
const adapter = getAdapter('cheerio');
```

### Custom Adapters

```js
import { BaseAdapter, registerAdapter } from 'xactions/scrapers';

class MyAdapter extends BaseAdapter {
  async createBrowser(options) { /* ... */ }
  async createPage(browser) { /* ... */ }
  async goto(page, url) { /* ... */ }
  async evaluate(page, fn) { /* ... */ }
  async close(browser) { /* ... */ }
}

registerAdapter('my-adapter', MyAdapter);
```

---

## Browser Scripts

Standalone scripts for DevTools console. Copy from `scripts/` and paste on x.com:

| Script | Description |
|--------|-------------|
| `scrapeFollowers.js` | Export follower list |
| `scrapeFollowing.js` | Export following list |
| `scrapeProfile.js` | Extract profile data |
| `scrapeLikes.js` | Export liked tweets |
| `scrapeMedia.js` | Export media tweets |
| `scrapeHashtag.js` | Scrape tweets by hashtag |
| `scrapeSearch.js` | Scrape search results |
| `scrapeBookmarks.js` | Export bookmarks |
| `scrapeDMs.js` | Export DM conversations |
| `scrapeList.js` | Scrape list members |
| `scrapeReplies.js` | Scrape reply threads |
| `scrapeQuoteRetweets.js` | Scrape quote retweets |
| `scrapeNotifications.js` | Export notification feed |
| `scrapeSpaces.js` | Scrape Spaces metadata |
| `scrapeExplore.js` | Scrape Explore/trending |
| `scrapeAnalytics.js` | Scrape analytics data |
| `bookmarkExporter.js` | Advanced bookmark export with folders |
| `threadUnroller.js` | Unroll a thread into JSON/text |
| `viralTweetsScraper.js` | Find viral tweets in a niche |
| `videoDownloader.js` | Download Twitter/X videos |

### Output Formats

Browser scripts export data as:

- **JSON** — downloaded as `.json` file
- **CSV** — downloadable spreadsheet
- **Console** — printed to DevTools console as a table

---

## API Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/api/twitter/profile/:username` | GET | Scrape profile |
| `/api/twitter/followers/:username` | GET | Scrape followers |
| `/api/twitter/following/:username` | GET | Scrape following |
| `/api/twitter/tweets/:username` | GET | Scrape tweets |
| `/api/twitter/search` | GET | Search tweets (`?q=query`) |

---

## Rate Limits & Best Practices

X enforces aggressive rate limits. Follow these guidelines:

1. **Add delays** — minimum 1-3 seconds between actions
2. **Batch operations** — scrape in chunks of 100-500, pause between batches
3. **Respect pagination** — don't skip the built-in scroll delays
4. **Rotate sessions** — if scraping at scale, use multiple auth tokens
5. **Use proxies** — the `proxyManager` in `src/scraping/` handles rotation

```js
import { ProxyManager } from 'xactions/scraping/proxyManager';

const proxy = new ProxyManager({
  proxies: ['http://proxy1:8080', 'http://proxy2:8080'],
  rotateEvery: 50,  // Rotate after 50 requests
});
```

---

## Pagination Engine

For large-scale scraping, use the pagination engine:

```js
import { PaginationEngine } from 'xactions/scraping/paginationEngine';

const engine = new PaginationEngine({
  maxPages: 100,
  delay: 2000,
  onPage: (items) => { /* process batch */ },
});
```

---

## Stealth Mode

Avoid detection with the stealth browser:

```js
import { StealthBrowser } from 'xactions/scraping/stealthBrowser';

const browser = new StealthBrowser({
  headless: true,
  fingerprint: 'randomize',
  userAgent: 'rotate',
});
```
