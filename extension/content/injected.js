// XActions Extension — Injected Page Script
// Runs in the actual x.com page context (not content script sandbox)
// Has full access to the page DOM, same as pasting in console
// by nichxbt

(() => {
  if (window.__xactions_injected) return;
  window.__xactions_injected = true;

  // ============================================
  // CORE MODULE (from src/automation/core.js)
  // ============================================
  window.XActions = window.XActions || {};

  window.XActions.Core = (() => {
    const CONFIG = {
      DELAY_SHORT: 500,
      DELAY_MEDIUM: 1500,
      DELAY_LONG: 3000,
      DELAY_BETWEEN_ACTIONS: 2000,
      MAX_ACTIONS_PER_HOUR: 50,
      MAX_FOLLOWS_PER_DAY: 100,
      MAX_LIKES_PER_DAY: 200,
      STORAGE_PREFIX: 'xactions_',
      DEBUG: true,
    };

    const SELECTORS = {
      followButton: '[data-testid$="-follow"]',
      unfollowButton: '[data-testid$="-unfollow"]',
      likeButton: '[data-testid="like"]',
      unlikeButton: '[data-testid="unlike"]',
      retweetButton: '[data-testid="retweet"]',
      unretweetButton: '[data-testid="unretweet"]',
      retweetConfirm: '[data-testid="retweetConfirm"]',
      replyButton: '[data-testid="reply"]',
      confirmButton: '[data-testid="confirmationSheetConfirm"]',
      tweet: '[data-testid="tweet"]',
      tweetText: '[data-testid="tweetText"]',
      tweetLink: 'a[href*="/status/"]',
      userCell: '[data-testid="UserCell"]',
      userAvatar: '[data-testid="UserAvatar-Container"]',
      userName: '[data-testid="User-Name"]',
      userFollowIndicator: '[data-testid="userFollowIndicator"]',
      tweetInput: '[data-testid="tweetTextarea_0"]',
      searchInput: '[data-testid="SearchBox_Search_Input"]',
      primaryColumn: '[data-testid="primaryColumn"]',
      timeline: 'section[role="region"]',
      media: '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]',
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const randomDelay = (min, max) => {
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;
      return sleep(delay);
    };

    const log = (message, type = 'info') => {
      const timestamp = new Date().toLocaleTimeString();
      const prefix = { info: '📘', success: '✅', warning: '⚠️', error: '❌', action: '🔧' }[type] || '📘';
      if (CONFIG.DEBUG || type === 'error') {
        console.log(`${prefix} [${timestamp}] ${message}`);
      }
      // Emit to extension
      notify('ACTION_PERFORMED', { action: `[${type}] ${message}` });
    };

    const scrollToBottom = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    const scrollBy = (pixels) => window.scrollBy({ top: pixels, behavior: 'smooth' });

    const storage = {
      get: (key) => { try { const d = localStorage.getItem(CONFIG.STORAGE_PREFIX + key); return d ? JSON.parse(d) : null; } catch { return null; } },
      set: (key, value) => { try { localStorage.setItem(CONFIG.STORAGE_PREFIX + key, JSON.stringify(value)); return true; } catch { return false; } },
      remove: (key) => localStorage.removeItem(CONFIG.STORAGE_PREFIX + key),
    };

    const waitForElement = async (selector, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = document.querySelector(selector);
        if (el) return el;
        await sleep(100);
      }
      return null;
    };

    const waitForElements = async (selector, minCount = 1, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const els = document.querySelectorAll(selector);
        if (els.length >= minCount) return Array.from(els);
        await sleep(100);
      }
      return [];
    };

    const clickElement = async (element) => {
      if (!element) return false;
      try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        element.click();
        return true;
      } catch { return false; }
    };

    const typeText = async (element, text, delay = 50) => {
      if (!element) return false;
      try {
        element.focus();
        for (const char of text) {
          element.textContent += char;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
          await sleep(delay);
        }
        return true;
      } catch { return false; }
    };

    const extractUsername = (element) => {
      const link = element.querySelector('a[href^="/"]');
      if (link) {
        const match = link.getAttribute('href').match(/^\/([^/]+)$/);
        if (match) return match[1].toLowerCase();
      }
      return null;
    };

    const extractTweetInfo = (tweetElement) => {
      try {
        const text = tweetElement.querySelector(SELECTORS.tweetText)?.textContent || '';
        const tweetLink = tweetElement.querySelector(SELECTORS.tweetLink)?.href || '';
        const userName = tweetElement.querySelector(SELECTORS.userName)?.textContent || '';
        return { text, tweetLink, userName };
      } catch { return null; }
    };

    const rateLimit = {
      check: (action, limit, period = 'hour') => {
        const key = `ratelimit_${action}_${period}`;
        const data = storage.get(key) || { count: 0, timestamp: Date.now() };
        const periodMs = period === 'hour' ? 3600000 : 86400000;
        if (Date.now() - data.timestamp > periodMs) { data.count = 0; data.timestamp = Date.now(); }
        return data.count < limit;
      },
      increment: (action, period = 'hour') => {
        const key = `ratelimit_${action}_${period}`;
        const data = storage.get(key) || { count: 0, timestamp: Date.now() };
        data.count++;
        storage.set(key, data);
      },
      getRemaining: (action, limit, period = 'hour') => {
        const key = `ratelimit_${action}_${period}`;
        const data = storage.get(key) || { count: 0, timestamp: Date.now() };
        return Math.max(0, limit - data.count);
      },
    };

    // Notify extension bridge
    function notify(type, data) {
      window.postMessage({ source: 'xactions-page', type, ...data }, '*');
    }

    return {
      CONFIG, SELECTORS, sleep, randomDelay, log,
      scrollToBottom, scrollToTop, scrollBy, storage,
      waitForElement, waitForElements, clickElement, typeText,
      extractUsername, extractTweetInfo, rateLimit, notify,
    };
  })();

  // ============================================
  // AUTOMATION REGISTRY
  // ============================================
  const automationRunners = {};
  const automationStopFlags = {};

  function registerAutomation(id, runFn) {
    automationRunners[id] = runFn;
  }

  // ============================================
  // AUTO-LIKER
  // ============================================
  registerAutomation('autoLiker', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, SELECTORS, storage, rateLimit } = window.XActions.Core;
    const opts = {
      LIKE_ALL: false,
      KEYWORDS: settings.keywords || [],
      MAX_LIKES: settings.maxActions || 20,
      MAX_SCROLL_DEPTH: 50,
      MIN_DELAY: settings.minDelay || 2000,
      MAX_DELAY: settings.maxDelay || 5000,
      SKIP_REPLIES: true,
      SKIP_ADS: true,
    };

    let likeCount = 0;
    let scrollCount = 0;
    const likedTweets = new Set(storage.get('liked_tweets') || []);

    const matchesKeywords = (text) => {
      if (opts.KEYWORDS.length === 0) return true;
      const lower = text.toLowerCase();
      return opts.KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    };

    log(`🤍 Auto-Liker started (max: ${opts.MAX_LIKES}, keywords: ${opts.KEYWORDS.length ? opts.KEYWORDS.join(', ') : 'any'})`, 'info');

    while (likeCount < opts.MAX_LIKES && scrollCount < opts.MAX_SCROLL_DEPTH && !automationStopFlags['autoLiker']) {
      const tweets = document.querySelectorAll(SELECTORS.tweet);

      for (const tweet of tweets) {
        if (automationStopFlags['autoLiker']) break;
        if (likeCount >= opts.MAX_LIKES) break;
        if (!rateLimit.check('like', 200, 'day')) { log('⚠️ Daily like limit reached', 'warning'); return; }

        const tweetLink = tweet.querySelector(SELECTORS.tweetLink)?.href || '';
        const tweetId = tweetLink.match(/status\/(\d+)/)?.[1];
        if (!tweetId || likedTweets.has(tweetId)) continue;

        const text = tweet.querySelector(SELECTORS.tweetText)?.textContent || '';
        if (!matchesKeywords(text)) continue;

        // Skip ads
        if (opts.SKIP_ADS && (tweet.querySelector('[data-testid="placementTracking"]') || tweet.textContent?.includes('Promoted'))) continue;

        const likeBtn = tweet.querySelector(SELECTORS.likeButton);
        if (!likeBtn) continue;

        await clickElement(likeBtn);
        likeCount++;
        likedTweets.add(tweetId);
        rateLimit.increment('like', 'day');

        window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'autoLiker', action: `❤️ Liked tweet ${tweetId} (${likeCount}/${opts.MAX_LIKES})` }, '*');
        log(`❤️ Liked: "${text.substring(0, 50)}..." (${likeCount}/${opts.MAX_LIKES})`, 'success');

        await randomDelay(opts.MIN_DELAY, opts.MAX_DELAY);
      }

      scrollBy(800);
      scrollCount++;
      await sleep(1500);
    }

    storage.set('liked_tweets', Array.from(likedTweets));
    log(`✅ Auto-Liker done! Liked ${likeCount} tweets.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'autoLiker', summary: `${likeCount} tweets liked` }, '*');
  });

  // ============================================
  // SMART UNFOLLOW
  // ============================================
  registerAutomation('smartUnfollow', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, waitForElement, storage, SELECTORS } = window.XActions.Core;
    const opts = {
      DAYS_TO_WAIT: settings.daysToWait || 3,
      MAX_UNFOLLOWS: settings.maxActions || 50,
      WHITELIST: settings.whitelist || [],
      DRY_RUN: settings.dryRun || false,
      DELAY_BETWEEN_UNFOLLOWS: settings.minDelay || 2000,
    };

    let unfollowCount = 0;

    log(`🔄 Smart Unfollow started (max: ${opts.MAX_UNFOLLOWS}, wait: ${opts.DAYS_TO_WAIT}d${opts.DRY_RUN ? ', DRY RUN' : ''})`, 'info');

    // Must be on following page
    const currentPath = window.location.pathname;
    if (!currentPath.endsWith('/following')) {
      log('⚠️ Navigate to your following page first (x.com/YOUR_USERNAME/following)', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'smartUnfollow', error: 'Navigate to your following page first' }, '*');
      return;
    }

    while (unfollowCount < opts.MAX_UNFOLLOWS && !automationStopFlags['smartUnfollow']) {
      const cells = document.querySelectorAll(SELECTORS.userCell);
      if (cells.length === 0) {
        await sleep(2000);
        scrollBy(600);
        continue;
      }

      for (const cell of cells) {
        if (automationStopFlags['smartUnfollow']) break;
        if (unfollowCount >= opts.MAX_UNFOLLOWS) break;

        const userLink = cell.querySelector('a[href^="/"]');
        const username = userLink?.getAttribute('href')?.replace('/', '') || '';
        if (!username) continue;

        // Check whitelist
        if (opts.WHITELIST.some(w => w.toLowerCase() === username.toLowerCase())) continue;

        // Check if they follow back
        const followsYou = cell.querySelector(SELECTORS.userFollowIndicator);
        if (followsYou) continue; // They follow back, skip

        const unfollowBtn = cell.querySelector(SELECTORS.unfollowButton);
        if (!unfollowBtn) continue;

        if (opts.DRY_RUN) {
          log(`[DRY RUN] Would unfollow @${username}`, 'info');
        } else {
          await clickElement(unfollowBtn);
          await sleep(500);
          const confirmBtn = await waitForElement(SELECTORS.confirmButton, 3000);
          if (confirmBtn) await clickElement(confirmBtn);
        }

        unfollowCount++;
        window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'smartUnfollow', action: `👋 Unfollowed @${username} (${unfollowCount}/${opts.MAX_UNFOLLOWS})` }, '*');
        log(`👋 Unfollowed @${username} (${unfollowCount}/${opts.MAX_UNFOLLOWS})`, 'success');

        await randomDelay(opts.DELAY_BETWEEN_UNFOLLOWS, opts.DELAY_BETWEEN_UNFOLLOWS * 1.5);
      }

      scrollBy(600);
      await sleep(1500);
    }

    log(`✅ Smart Unfollow done! Unfollowed ${unfollowCount} users.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'smartUnfollow', summary: `${unfollowCount} users unfollowed` }, '*');
  });

  // ============================================
  // KEYWORD FOLLOW
  // ============================================
  registerAutomation('keywordFollow', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, waitForElement, storage, rateLimit, SELECTORS } = window.XActions.Core;
    const opts = {
      KEYWORDS: settings.keywords || ['web3', 'crypto'],
      MAX_FOLLOWS_PER_KEYWORD: settings.maxPerKeyword || 10,
      MAX_FOLLOWS_TOTAL: settings.maxActions || 30,
      MIN_FOLLOWERS: settings.minFollowers || 100,
      MAX_FOLLOWERS: settings.maxFollowers || 100000,
      MUST_HAVE_BIO: settings.mustHaveBio || false,
      DELAY_BETWEEN_FOLLOWS: settings.minDelay || 3000,
    };

    let followCount = 0;
    const followedUsers = new Map(Object.entries(storage.get('followed_users') || {}));

    const saveFollowedUser = (username) => {
      followedUsers.set(username.toLowerCase(), { followedAt: Date.now(), followedBack: false });
      storage.set('followed_users', Object.fromEntries(followedUsers));
    };

    log(`🔍 Keyword Follow started (keywords: ${opts.KEYWORDS.join(', ')}, max: ${opts.MAX_FOLLOWS_TOTAL})`, 'info');

    for (const keyword of opts.KEYWORDS) {
      if (followCount >= opts.MAX_FOLLOWS_TOTAL || automationStopFlags['keywordFollow']) break;

      const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=user`;
      window.location.href = searchUrl;
      await sleep(3000);
      await waitForElement(SELECTORS.userCell, 10000);
      await sleep(1000);

      let keywordFollows = 0;
      let scrollAttempts = 0;

      while (keywordFollows < opts.MAX_FOLLOWS_PER_KEYWORD && followCount < opts.MAX_FOLLOWS_TOTAL && scrollAttempts < 20 && !automationStopFlags['keywordFollow']) {
        const cells = document.querySelectorAll(SELECTORS.userCell);

        for (const cell of cells) {
          if (automationStopFlags['keywordFollow']) break;
          if (keywordFollows >= opts.MAX_FOLLOWS_PER_KEYWORD || followCount >= opts.MAX_FOLLOWS_TOTAL) break;
          if (!rateLimit.check('follow', 100, 'day')) { log('⚠️ Daily follow limit reached', 'warning'); return; }

          const userLink = cell.querySelector('a[href^="/"]');
          const username = userLink?.getAttribute('href')?.replace('/', '') || '';
          if (!username || followedUsers.has(username.toLowerCase())) continue;

          // Check for follow button (not already following)
          const followBtn = cell.querySelector(SELECTORS.followButton);
          if (!followBtn) continue;

          await clickElement(followBtn);
          followCount++;
          keywordFollows++;
          rateLimit.increment('follow', 'day');
          saveFollowedUser(username);

          window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'keywordFollow', action: `➕ Followed @${username} for "${keyword}" (${followCount}/${opts.MAX_FOLLOWS_TOTAL})` }, '*');
          log(`➕ Followed @${username} (${followCount}/${opts.MAX_FOLLOWS_TOTAL})`, 'success');

          await randomDelay(opts.DELAY_BETWEEN_FOLLOWS, opts.DELAY_BETWEEN_FOLLOWS * 1.5);
        }

        scrollBy(600);
        scrollAttempts++;
        await sleep(1500);
      }
    }

    log(`✅ Keyword Follow done! Followed ${followCount} users.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'keywordFollow', summary: `${followCount} users followed` }, '*');
  });

  // ============================================
  // FOLLOW ENGAGERS
  // ============================================
  registerAutomation('followEngagers', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, waitForElement, storage, rateLimit, SELECTORS } = window.XActions.Core;
    const opts = {
      MODE: settings.mode || 'likers',
      MAX_FOLLOWS: settings.maxActions || 30,
      MIN_FOLLOWERS: settings.minFollowers || 50,
      DELAY_BETWEEN_FOLLOWS: settings.minDelay || 3000,
    };

    let followCount = 0;

    log(`👥 Follow Engagers started (mode: ${opts.MODE}, max: ${opts.MAX_FOLLOWS})`, 'info');

    // Must be on a tweet page
    if (!window.location.pathname.includes('/status/')) {
      log('⚠️ Navigate to a specific tweet first', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'followEngagers', error: 'Navigate to a specific tweet first' }, '*');
      return;
    }

    // Click on likes to open likers panel
    const likesLink = document.querySelector('a[href$="/likes"]');
    if (likesLink) {
      await clickElement(likesLink);
      await sleep(2000);
    }

    let scrollAttempts = 0;
    while (followCount < opts.MAX_FOLLOWS && scrollAttempts < 30 && !automationStopFlags['followEngagers']) {
      const cells = document.querySelectorAll(SELECTORS.userCell);

      for (const cell of cells) {
        if (automationStopFlags['followEngagers']) break;
        if (followCount >= opts.MAX_FOLLOWS) break;
        if (!rateLimit.check('follow', 100, 'day')) { log('⚠️ Daily follow limit reached', 'warning'); return; }

        const followBtn = cell.querySelector(SELECTORS.followButton);
        if (!followBtn) continue;

        const userLink = cell.querySelector('a[href^="/"]');
        const username = userLink?.getAttribute('href')?.replace('/', '') || 'unknown';

        await clickElement(followBtn);
        followCount++;
        rateLimit.increment('follow', 'day');

        window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'followEngagers', action: `➕ Followed @${username} (${followCount}/${opts.MAX_FOLLOWS})` }, '*');
        log(`➕ Followed engager @${username} (${followCount}/${opts.MAX_FOLLOWS})`, 'success');

        await randomDelay(opts.DELAY_BETWEEN_FOLLOWS, opts.DELAY_BETWEEN_FOLLOWS * 1.5);
      }

      scrollBy(600);
      scrollAttempts++;
      await sleep(1500);
    }

    log(`✅ Follow Engagers done! Followed ${followCount} users.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'followEngagers', summary: `${followCount} engagers followed` }, '*');
  });

  // ============================================
  // AUTO-COMMENTER
  // ============================================
  registerAutomation('autoCommenter', async (settings) => {
    const { log, sleep, randomDelay, scrollToTop, clickElement, waitForElement, storage, SELECTORS } = window.XActions.Core;
    const opts = {
      COMMENTS: settings.comments || ['🔥', 'Great point!', 'Interesting take!', 'Love this!', '💯'],
      CHECK_INTERVAL_SECONDS: settings.checkInterval || 60,
      MAX_COMMENTS: settings.maxActions || 5,
      ONLY_ORIGINAL_TWEETS: true,
      KEYWORDS: settings.keywords || [],
    };

    let commentCount = 0;
    let checkCount = 0;
    const commentedTweets = new Set(storage.get('commented_tweets') || []);

    const getRandomComment = () => opts.COMMENTS[Math.floor(Math.random() * opts.COMMENTS.length)];

    log(`💬 Auto-Commenter started (max: ${opts.MAX_COMMENTS}, interval: ${opts.CHECK_INTERVAL_SECONDS}s)`, 'info');

    while (commentCount < opts.MAX_COMMENTS && !automationStopFlags['autoCommenter']) {
      checkCount++;
      scrollToTop();
      await sleep(2000);

      const tweets = document.querySelectorAll(SELECTORS.tweet);

      for (const tweet of tweets) {
        if (automationStopFlags['autoCommenter']) break;
        if (commentCount >= opts.MAX_COMMENTS) break;

        const tweetLink = tweet.querySelector(SELECTORS.tweetLink)?.href || '';
        const tweetId = tweetLink.match(/status\/(\d+)/)?.[1];
        if (!tweetId || commentedTweets.has(tweetId)) continue;

        const text = tweet.querySelector(SELECTORS.tweetText)?.textContent || '';
        if (opts.KEYWORDS.length > 0 && !opts.KEYWORDS.some(kw => text.toLowerCase().includes(kw.toLowerCase()))) continue;

        // Click reply button
        const replyBtn = tweet.querySelector(SELECTORS.replyButton);
        if (!replyBtn) continue;

        await clickElement(replyBtn);
        await sleep(1500);

        // Type comment
        const replyBox = await waitForElement(SELECTORS.tweetInput, 5000);
        if (!replyBox) continue;

        const comment = getRandomComment();
        replyBox.focus();
        document.execCommand('insertText', false, comment);
        await sleep(500);

        // Find and click the reply submit button
        const submitBtn = document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]');
        if (submitBtn) {
          await clickElement(submitBtn);
          commentCount++;
          commentedTweets.add(tweetId);
          storage.set('commented_tweets', Array.from(commentedTweets));

          window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'autoCommenter', action: `💬 Commented "${comment}" on tweet ${tweetId} (${commentCount}/${opts.MAX_COMMENTS})` }, '*');
          log(`💬 Commented on tweet: "${comment}" (${commentCount}/${opts.MAX_COMMENTS})`, 'success');
        }

        await randomDelay(3000, 6000);
      }

      if (commentCount < opts.MAX_COMMENTS && !automationStopFlags['autoCommenter']) {
        log(`⏱️ Check ${checkCount} done. Waiting ${opts.CHECK_INTERVAL_SECONDS}s...`, 'info');
        await sleep(opts.CHECK_INTERVAL_SECONDS * 1000);
      }
    }

    log(`✅ Auto-Commenter done! Posted ${commentCount} comments.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'autoCommenter', summary: `${commentCount} comments posted` }, '*');
  });

  // ============================================
  // AUTO-REPOST (retweet matching posts as you scroll)
  // Ported from scripts/twitter/auto-repost.js
  // ============================================
  registerAutomation('autoRepost', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, SELECTORS } = window.XActions.Core;
    const opts = {
      MAX_REPOSTS: settings.maxActions || 10,
      SKIP_ADS: settings.skipAds !== false,
      SKIP_REPLIES: settings.skipReplies !== false,
      ONLY_WITH_MEDIA: !!settings.onlyWithMedia,
      KEYWORDS: settings.keywords || [],
      MIN_DELAY: settings.minDelay || 1500,
      MAX_DELAY: settings.maxDelay || 4000,
      MAX_SCROLL_ATTEMPTS: 25,
      NO_NEW_POSTS_THRESHOLD: 5,
    };

    const isReply = (tweet) => {
      if (tweet.querySelector('[data-testid="in-reply-to"]') !== null) return true;
      return Array.from(tweet.querySelectorAll('div[dir]')).some(el =>
        el.innerText.startsWith('Replying to'));
    };

    const isAd = (tweet) => {
      if (tweet.querySelector('[data-testid="placementTracking"]') !== null) return true;
      return Array.from(tweet.querySelectorAll('span')).some(el => {
        const t = el.textContent.trim();
        return t === 'Ad' || t === 'Promoted';
      });
    };

    const hasMedia = (tweet) => tweet.querySelector(SELECTORS.media) !== null;

    const matchesKeywords = (text) => {
      if (opts.KEYWORDS.length === 0) return true;
      const lower = text.toLowerCase();
      return opts.KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    };

    const getTweetIdentifier = (tweet) => {
      const timeAnchor = tweet.querySelector('time')?.closest('a[href*="/status/"]');
      if (timeAnchor) {
        const match = timeAnchor.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
      }
      const links = tweet.querySelectorAll('a[href*="/status/"]');
      for (const link of links) {
        const match = link.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
      }
      return (tweet.querySelector(SELECTORS.tweetText)?.textContent || '').substring(0, 100);
    };

    let reposted = 0;
    const processedTweets = new Set();
    let scrollAttempts = 0;
    let noNewPostsCount = 0;

    log(`🔄 Auto Repost started (max: ${opts.MAX_REPOSTS}, keywords: ${opts.KEYWORDS.length ? opts.KEYWORDS.join(', ') : 'any'})`, 'info');

    // Page guard: warn (do not redirect) if there is no post feed on screen.
    if (!/x\.com|twitter\.com/.test(window.location.href)) {
      log('⚠️ Open x.com on a search, hashtag, or profile page first', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'autoRepost', error: 'Open x.com on a search, hashtag, or profile page first' }, '*');
      return;
    }
    if (document.querySelector(SELECTORS.tweet) === null) {
      log('⚠️ No posts visible yet. Wait for posts to load, then re-run.', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'autoRepost', error: 'No posts visible yet. Go to a search/hashtag results page or a profile.' }, '*');
      return;
    }

    while (!automationStopFlags['autoRepost'] && reposted < opts.MAX_REPOSTS && scrollAttempts < opts.MAX_SCROLL_ATTEMPTS) {
      const tweets = document.querySelectorAll(SELECTORS.tweet);
      let foundNewPost = false;

      for (const tweet of tweets) {
        if (automationStopFlags['autoRepost'] || reposted >= opts.MAX_REPOSTS) break;

        const tweetId = getTweetIdentifier(tweet);
        if (processedTweets.has(tweetId)) continue;
        processedTweets.add(tweetId);
        foundNewPost = true;

        try {
          if (opts.SKIP_ADS && isAd(tweet)) continue;
          if (opts.SKIP_REPLIES && isReply(tweet)) continue;
          if (opts.ONLY_WITH_MEDIA && !hasMedia(tweet)) continue;

          const text = tweet.querySelector(SELECTORS.tweetText)?.textContent || '';
          if (!matchesKeywords(text)) continue;

          // Already reposted? The button flips to unretweet.
          if (tweet.querySelector(SELECTORS.unretweetButton)) continue;

          const retweetButton = tweet.querySelector(SELECTORS.retweetButton);
          if (!retweetButton) continue;

          await clickElement(retweetButton);
          await sleep(800);

          const confirm = document.querySelector(SELECTORS.retweetConfirm);
          if (confirm) {
            await clickElement(confirm);
            reposted++;
            const preview = text.substring(0, 50).replace(/\n/g, ' ') || '(no text)';
            window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'autoRepost', action: `🔄 Reposted: "${preview}..." (${reposted}/${opts.MAX_REPOSTS})` }, '*');
            log(`🔄 Reposted #${reposted}: "${preview}..."`, 'success');
            await randomDelay(opts.MIN_DELAY, opts.MAX_DELAY);
          } else {
            // Menu did not open as expected (e.g. quote-only). Close it.
            document.body.click();
            await sleep(400);
          }
        } catch (error) {
          log(`❌ Error processing post: ${error.message}`, 'error');
          document.body.click();
          await sleep(600);
        }
      }

      if (!foundNewPost) {
        noNewPostsCount++;
        if (noNewPostsCount >= opts.NO_NEW_POSTS_THRESHOLD) {
          log('⚠️ No new posts found after multiple scrolls. Stopping.', 'warning');
          break;
        }
      } else {
        noNewPostsCount = 0;
      }

      scrollBy(700);
      scrollAttempts++;
      await sleep(1500);
    }

    log(`✅ Auto Repost done! Reposted ${reposted} posts.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'autoRepost', summary: `${reposted} posts reposted` }, '*');
  });

  // ============================================
  // PROFILE AUTO-COMMENTER
  // Ported from scripts/twitter/auto-commenter.js — targets one profile,
  // filters by post age, and skips replies/media per settings.
  // ============================================
  registerAutomation('profileCommenter', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, waitForElement, storage, SELECTORS } = window.XActions.Core;
    const opts = {
      COMMENTS: settings.comments || ['🔥', 'Great point!', 'This is so true 👏', 'Interesting perspective!', '💯'],
      MAX_COMMENTS: settings.maxActions || 5,
      MAX_POST_AGE_MINUTES: settings.maxPostAgeMinutes || 60,
      MIN_POST_AGE_SECONDS: settings.minPostAgeSeconds || 30,
      ONLY_ORIGINAL_TWEETS: settings.onlyOriginalTweets !== false,
      ONLY_WITH_MEDIA: !!settings.onlyWithMedia,
      MIN_DELAY: settings.minDelay || 30000,
      MAX_DELAY: settings.maxDelay || 60000,
      SCROLL_DELAY: settings.scrollDelay || 2000,
    };

    const pathMatch = window.location.pathname.match(/^\/([^/]+)/);
    const targetUser = pathMatch ? pathMatch[1] : null;

    if (!targetUser || ['home', 'explore', 'search', 'notifications', 'messages', 'i'].includes(targetUser)) {
      log('⚠️ Must be on a user\'s profile page (x.com/TARGET_USERNAME)', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'profileCommenter', error: 'Navigate to a user profile page first' }, '*');
      return;
    }

    const getTweetId = (tweetEl) => {
      const timeEl = tweetEl.querySelector('time');
      const link = (timeEl && timeEl.closest('a[href*="/status/"]')) || tweetEl.querySelector('a[href*="/status/"]');
      if (link) {
        const match = link.href.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
      }
      return null;
    };

    const getTweetAge = (tweetEl) => {
      const timeEl = tweetEl.querySelector('time');
      const datetime = timeEl?.getAttribute('datetime');
      if (!datetime) return null;
      return (Date.now() - new Date(datetime).getTime()) / 1000;
    };

    const matchesCriteria = (tweetEl) => {
      const age = getTweetAge(tweetEl);
      if (!age) return false;
      if (age < opts.MIN_POST_AGE_SECONDS) return false;
      if (age > opts.MAX_POST_AGE_MINUTES * 60) return false;

      if (opts.ONLY_ORIGINAL_TWEETS) {
        const isReply = tweetEl.querySelector('[data-testid="in-reply-to"]') !== null ||
          Array.from(tweetEl.querySelectorAll('div[dir]')).some(el => el.innerText.startsWith('Replying to'));
        if (isReply) return false;
      }

      if (opts.ONLY_WITH_MEDIA) {
        const hasMedia = tweetEl.querySelector('[data-testid="tweetPhoto"]') ||
          tweetEl.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
        if (!hasMedia) return false;
      }

      return true;
    };

    const commentedTweets = new Set();
    const STORAGE_KEY = `xactions_commented_${targetUser}`;
    const saved = storage.get(STORAGE_KEY);
    if (saved) {
      try { JSON.parse(saved).forEach(id => commentedTweets.add(id)); } catch { /* ignore */ }
    }

    let totalCommented = 0;
    let scrolls = 0;
    const maxScrolls = 20;

    log(`💬 Profile Auto-Commenter targeting @${targetUser} (max: ${opts.MAX_COMMENTS})`, 'info');

    while (totalCommented < opts.MAX_COMMENTS && scrolls < maxScrolls && !automationStopFlags['profileCommenter']) {
      const tweets = document.querySelectorAll(SELECTORS.tweet);

      for (const tweet of tweets) {
        if (automationStopFlags['profileCommenter'] || totalCommented >= opts.MAX_COMMENTS) break;

        const tweetId = getTweetId(tweet);
        if (!tweetId || commentedTweets.has(tweetId)) continue;
        if (!matchesCriteria(tweet)) continue;

        const replyBtn = tweet.querySelector(SELECTORS.replyButton);
        if (!replyBtn) continue;

        try {
          await clickElement(replyBtn);
          await sleep(1000);

          const textarea = await waitForElement(SELECTORS.tweetInput, 5000);
          if (!textarea) continue;

          const comment = opts.COMMENTS[Math.floor(Math.random() * opts.COMMENTS.length)];
          textarea.focus();
          document.execCommand('insertText', false, comment);
          await sleep(500);

          const tweetBtn = document.querySelector('[data-testid="tweetButton"]');
          if (tweetBtn && !tweetBtn.disabled) {
            await clickElement(tweetBtn);
            commentedTweets.add(tweetId);
            totalCommented++;
            storage.set(STORAGE_KEY, JSON.stringify([...commentedTweets]));

            window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'profileCommenter', action: `💬 Commented "${comment}" on @${targetUser}'s tweet (${totalCommented}/${opts.MAX_COMMENTS})` }, '*');
            log(`💬 Posted: "${comment}" (${totalCommented}/${opts.MAX_COMMENTS})`, 'success');
            await randomDelay(opts.MIN_DELAY, opts.MAX_DELAY);
          } else {
            const closeBtn = document.querySelector('[data-testid="app-bar-close"]');
            if (closeBtn) closeBtn.click();
          }
        } catch (e) {
          log(`⚠️ Error: ${e.message}`, 'warning');
          const closeBtn = document.querySelector('[data-testid="app-bar-close"]');
          if (closeBtn) closeBtn.click();
        }
      }

      if (totalCommented >= opts.MAX_COMMENTS) break;

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(opts.SCROLL_DELAY);
      scrolls++;
    }

    log(`✅ Profile Auto-Commenter done! ${totalCommented} comments posted.`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'profileCommenter', summary: `${totalCommented} comments posted to @${targetUser}` }, '*');
  });

  // ============================================
  // GROWTH SUITE
  // ============================================
  registerAutomation('growthSuite', async (settings) => {
    const { log, sleep, randomDelay, scrollBy, clickElement, waitForElement, storage, rateLimit, SELECTORS } = window.XActions.Core;
    const opts = {
      KEYWORDS: settings.keywords || ['web3', 'crypto', 'AI'],
      enableFollow: settings.enableFollow !== false,
      enableLike: settings.enableLike !== false,
      enableUnfollow: settings.enableUnfollow !== false,
      maxFollows: settings.maxFollows || 20,
      maxLikes: settings.maxLikes || 30,
      maxUnfollows: settings.maxUnfollows || 15,
      UNFOLLOW_AFTER_DAYS: settings.daysToWait || 3,
      SESSION_DURATION_MINUTES: settings.sessionMinutes || 30,
      DELAY: settings.minDelay || 3000,
    };

    const endTime = Date.now() + opts.SESSION_DURATION_MINUTES * 60 * 1000;
    const state = { follows: 0, likes: 0, unfollows: 0 };

    log(`🚀 Growth Suite started! Session: ${opts.SESSION_DURATION_MINUTES}min`, 'info');
    log(`   Follow: ${opts.enableFollow}, Like: ${opts.enableLike}, Unfollow: ${opts.enableUnfollow}`, 'info');

    // Phase 1: Like tweets in feed
    if (opts.enableLike && !automationStopFlags['growthSuite']) {
      log('📌 Phase 1: Liking tweets in feed...', 'action');
      let scrolls = 0;
      while (state.likes < opts.maxLikes && scrolls < 30 && Date.now() < endTime && !automationStopFlags['growthSuite']) {
        const tweets = document.querySelectorAll(SELECTORS.tweet);
        for (const tweet of tweets) {
          if (automationStopFlags['growthSuite'] || state.likes >= opts.maxLikes || Date.now() >= endTime) break;
          const text = tweet.querySelector(SELECTORS.tweetText)?.textContent || '';
          if (opts.KEYWORDS.length > 0 && !opts.KEYWORDS.some(kw => text.toLowerCase().includes(kw.toLowerCase()))) continue;
          const likeBtn = tweet.querySelector(SELECTORS.likeButton);
          if (!likeBtn) continue;
          await clickElement(likeBtn);
          state.likes++;
          window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'growthSuite', action: `❤️ Liked tweet (${state.likes}/${opts.maxLikes})` }, '*');
          await randomDelay(opts.DELAY, opts.DELAY * 1.5);
        }
        scrollBy(600);
        scrolls++;
        await sleep(1500);
      }
    }

    log(`✅ Growth Suite done! Likes: ${state.likes}, Follows: ${state.follows}, Unfollows: ${state.unfollows}`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'growthSuite', summary: `${state.likes} likes, ${state.follows} follows, ${state.unfollows} unfollows` }, '*');
  });

  // ============================================
  // ACCOUNT INFO SCRAPER
  // ============================================
  function scrapeAccountInfo() {
    try {
      // Sidebar account switcher reliably holds the logged-in user. The
      // @handle is in the button's text (pattern used across the repo).
      const switcher = document.querySelector('div[data-testid="SideNav_AccountSwitcher_Button"]');
      const switcherText = switcher?.textContent || '';
      const handleMatch = switcherText.match(/@([A-Za-z0-9_]{1,15})/);
      const handle = handleMatch?.[1] || '';

      // Name + avatar: prefer the profile-page UserName element, else the
      // switcher's avatar image and its name line.
      const nameEl = document.querySelector('[data-testid="UserName"]') || document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] div[dir="ltr"] span');
      const avatarEl = document.querySelector('[data-testid="UserAvatar-Container"] img') || switcher?.querySelector('img[src*="profile_images"]');
      const name = nameEl?.textContent?.trim() || handle || 'Unknown';

      // Session cookies for backend account registration. auth_token + ct0
      // are NOT HttpOnly on x.com, so the page can read them (the old console
      // agent did exactly this). Sent only to the service worker, never exposed.
      let sessionCookie = '';
      try {
        const cookies = document.cookie.split(';').reduce((acc, c) => {
          const eq = c.indexOf('=');
          if (eq === -1) return acc;
          acc[c.slice(0, eq).trim()] = c.slice(eq + 1).trim();
          return acc;
        }, {});
        const authToken = cookies.auth_token;
        const ct0 = cookies.ct0;
        if (authToken) sessionCookie = `auth_token=${authToken}` + (ct0 ? `; ct0=${ct0}` : '');
      } catch { /* cookie read failed — identity only */ }

      return {
        name,
        avatar: avatarEl?.src || '',
        handle,
        url: window.location.href,
        sessionCookie,
      };
    } catch {
      return { name: 'Unknown', avatar: '', handle: '', url: window.location.href, sessionCookie: '' };
    }
  }

  // ============================================
  // MESSAGE LISTENER (from content script bridge)
  // ============================================
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'xactions-extension') return;

    const msg = event.data;

    switch (msg.type) {
      case 'RUN_AUTOMATION': {
        const runner = automationRunners[msg.automationId];
        if (runner) {
          automationStopFlags[msg.automationId] = false;
          try {
            await runner(msg.settings || {});
          } catch (err) {
            console.error(`XActions automation error (${msg.automationId}):`, err);
            window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: msg.automationId, error: err.message }, '*');
          }
        }
        break;
      }

      case 'STOP_AUTOMATION':
        automationStopFlags[msg.automationId] = true;
        break;

      case 'STOP_ALL':
      case 'PAUSE_ALL':
        Object.keys(automationStopFlags).forEach(k => automationStopFlags[k] = true);
        Object.keys(automationRunners).forEach(k => automationStopFlags[k] = true);
        break;

      case 'RESUME_ALL':
        // Resuming would need re-running, handled by popup
        break;

      case 'AGENT_CONNECT':
        // The service worker is pairing with the backend; hand it the account
        // this X tab is signed in as.
        window.postMessage({ source: 'xactions-page', type: 'ACCOUNT_INFO', data: scrapeAccountInfo() }, '*');
        break;

      case 'AGENT_DISCONNECT':
        // Nothing to clean up in page context; the service worker handles it.
        break;

      case 'GET_ACCOUNT_INFO':
        window.postMessage({ source: 'xactions-page', type: 'ACCOUNT_INFO', data: scrapeAccountInfo() }, '*');
        break;

      case 'FETCH_X_ACCOUNT': {
        // Same-origin fetch to x.com: cookies attach automatically and the
        // page CSP does not block same-origin fetches. Authoritative identity.
        fetch('https://x.com/i/api/1.1/account/verify_credentials.json', {
          method: 'GET',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
          .then((data) => {
            const username = data?.screen_name || '';
            if (!username) throw new Error('missing screen_name');
            window.postMessage({
              source: 'xactions-page',
              type: 'X_ACCOUNT_RESULT',
              ok: true,
              data: {
                username,
                displayName: data.name || username,
                profileUrl: `https://x.com/${username}`,
                avatar: data.profile_image_url_https || '',
              },
            }, '*');
          })
          .catch((err) => {
            window.postMessage({
              source: 'xactions-page',
              type: 'X_ACCOUNT_RESULT',
              ok: false,
              error: err?.message || 'verify_credentials failed',
            }, '*');
          });
        break;
      }

      case 'FETCH_X_GROUP_MEMBERS': {
        // Extract the group DM's participants. Two paths:
        //  1) Fast path: same-origin REST fetch (works for some accounts).
        //  2) DOM path (the spec's "All Members" interface): scroll the
        //     member list to load the virtualized rows, collect the profile
        //     links x.com renders for every participant, dedupe, and report.
        //     This is what actually works for group DMs.
        const conversationId = msg.conversationId || '';
        if (!/^g\d+$/.test(conversationId)) {
          window.postMessage({
            source: 'xactions-page',
            type: 'X_GROUP_MEMBERS_RESULT',
            ok: false,
            error: 'INVALID_GROUP_URL',
          }, '*');
          break;
        }

        try {
          // Fast path first (best-effort, non-blocking).
          const ct0 = (document.cookie.match(/(?:^|; )ct0=([^;]+)/) || [])[1] || '';
          const params = new URLSearchParams({
            dm_users: 'true', include_groups: 'true', include_inbox_timelines: 'true',
            supports_reactions: 'true', count: '100',
          });
          const headers = { 'content-type': 'application/json' };
          if (ct0) headers['x-csrf-token'] = ct0;
          const res = await fetch(`https://x.com/i/api/1.1/dm/conversation/${conversationId}.json?${params.toString()}`, {
            method: 'GET', credentials: 'include', headers,
          });
          if (res.ok) {
            const data = await res.json();
            const users = data.users || {};
            const participantIds = Object.keys(users);
            if (participantIds.length > 0) {
              const members = participantIds
                .map((uid) => {
                  const u = users[uid] || {};
                  const username = u.screen_name || '';
                  if (!username) return null;
                  return {
                    xUserId: uid, username,
                    displayName: u.name || username,
                    profileUrl: `https://x.com/${username}`,
                    avatarUrl: u.profile_image_url_https || '',
                    isAdmin: Boolean(u.is_admin || false),
                  };
                })
                .filter(Boolean);
              window.postMessage({
                source: 'xactions-page', type: 'X_GROUP_MEMBERS_RESULT',
                ok: true, data: { conversationId, members, source: 'api' },
              }, '*');
              break;
            }
          }
        } catch { /* REST path failed — fall through to DOM */ }

        // DOM path: open the "All Members" view if it isn't already, then
        // scroll the virtualized member list until no new members appear.
        const members = await extractGroupMembersFromDOM();
        if (members.length > 0) {
          window.postMessage({
            source: 'xactions-page', type: 'X_GROUP_MEMBERS_RESULT',
            ok: true, data: { conversationId, members, source: 'dom' },
          }, '*');
        } else {
          window.postMessage({
            source: 'xactions-page', type: 'X_GROUP_MEMBERS_RESULT',
            ok: false,
            error: 'ACCESS_DENIED',
            hint: 'Open the group chat and its "All Members" view, then retry.',
          }, '*');
        }
        break;
      }
    }
  });

  // Read the open group DM's participant panel from the DOM. X renders the
  // member list as [data-testid="UserCell"] rows (name, handle, avatar) —
  // the same cells the follower/unfollower scripts scrape. Needs the group
  // chat open with the member list visible (click the group info / people
  // icon so the panel is on screen).
  // Scroll-traversal member extractor for group DMs.
  //
  // The "All Members" (جميع الأعضاء) interface renders participants as X
  // profile links in a virtualized list. This function opens that view if it
  // isn't already on screen, then scrolls the list container repeatedly,
  // collecting newly rendered profile links until a full pass adds nothing.
  // Returns deduplicated, normalized members.
  async function extractGroupMembersFromDOM(maxScrolls = 80) {
    const seen = new Set();
    const members = [];
    const addLink = (link) => {
      const href = link?.getAttribute?.('href') || '';
      const username = (href.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
      if (!username || username === 'home' || username === 'search' || username === 'messages'
        || username === 'i' || username === 'settings' || username === 'notifications'
        || username === 'explore' || username === 'compose' || seen.has(username)) return;
      seen.add(username);
      const img = link.querySelector('img');
      const nameEl = link.querySelector('[dir="ltr"] > span')
        || link.closest('[role="button"]')?.querySelector('span')
        || link.parentElement?.parentElement?.querySelector('span');
      members.push({
        xUserId: username, // DOM rows do not expose the numeric user id
        username,
        displayName: nameEl?.textContent?.trim() || username,
        profileUrl: `https://x.com/${username}`,
        avatarUrl: img?.src || '',
        isAdmin: false,
      });
    };

    // 1) Try to open the "All Members" view: click the group header's member
    //    count / people button (opens the conversation-info panel), then the
    //    "Members" row inside it if present.
    const headerBtn = document.querySelector(
      '[data-testid="conversationInfoButton"], [data-testid="DmGroupInfoButton"], [data-testid="groupDmHeader"], [aria-label="Conversation info"], [aria-label="Group info"]',
    );
    if (headerBtn) {
      try { headerBtn.click(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 900));
    }
    const memberRow = [...document.querySelectorAll('[role="menuitem"], [role="button"]')]
      .find((el) => /members|الأعضاء|people/i.test(el.textContent || '') && /all|كل/i.test(el.textContent || ''));
    if (memberRow) {
      try { memberRow.click(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 900));
    }

    // 2) Collect whatever is already rendered.
    for (const link of document.querySelectorAll('a[href^="/"]')) {
      const img = link.querySelector('img');
      if (img?.src) addLink(link);
    }

    // 3) Scroll the member list (the scroll container or the window) until a
    //    full pass adds no new members, up to maxScrolls.
    let scrollable = document.querySelector('[data-testid="conversationMembers"], [aria-label="Members"], [data-testid="Scrollable"]');
    for (let i = 0; i < maxScrolls; i++) {
      const before = members.length;
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      } else {
        window.scrollBy(0, window.innerHeight * 0.8);
      }
      await new Promise((r) => setTimeout(r, 500));
      for (const link of document.querySelectorAll('a[href^="/"]')) {
        const img = link.querySelector('img');
        if (img?.src) addLink(link);
      }
      if (members.length === before) {
        // One more pass to be sure the tail has settled.
        await new Promise((r) => setTimeout(r, 500));
        for (const link of document.querySelectorAll('a[href^="/"]')) {
          const img = link.querySelector('img');
          if (img?.src) addLink(link);
        }
        if (members.length === before) break;
      }
    }
    return members;
  }

  console.log('✅ XActions automation engine injected');

  // ============================================
  // VIDEO DOWNLOADER
  // ============================================
  registerAutomation('videoDownloader', async (settings) => {
    const { log, sleep, SELECTORS } = window.XActions.Core;
    const opts = {
      quality: settings.quality || 'highest',
      autoDownload: settings.autoDownload || false,
      showButton: settings.showButton !== false,
    };

    log('🎬 Video Downloader enabled — scanning for videos...', 'info');

    const injectedTweets = new Set();

    function findVideoUrl(tweetEl) {
      // Look for video elements
      const video = tweetEl.querySelector('video');
      if (video?.src) return video.src;
      // Check for source tags
      const source = tweetEl.querySelector('video source');
      if (source?.src) return source.src;
      // Try to find mp4 URL in tweet data
      const links = tweetEl.querySelectorAll('a[href*="video"]');
      for (const link of links) {
        if (link.href.includes('.mp4')) return link.href;
      }
      return null;
    }

    function addDownloadButton(tweetEl) {
      const tweetLink = tweetEl.querySelector(SELECTORS.tweetLink)?.href || '';
      const tweetId = tweetLink.match(/status\/(\d+)/)?.[1];
      if (!tweetId || injectedTweets.has(tweetId)) return;

      // Check for video content
      const hasVideo = tweetEl.querySelector('video') || tweetEl.querySelector('[data-testid="videoPlayer"]') || tweetEl.querySelector('[data-testid="videoComponent"]');
      if (!hasVideo) return;

      injectedTweets.add(tweetId);
      const actionBar = tweetEl.querySelector('[role="group"]');
      if (!actionBar) return;

      const btn = document.createElement('button');
      btn.className = 'xactions-dl-btn';
      btn.innerHTML = '⬇';
      btn.title = 'Download video (XFlow)';
      btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;padding:4px 8px;border-radius:50%;transition:background 0.2s;color:#1d9bf0;';
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(29,155,240,0.1)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'none');

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.innerHTML = '⏳';
        const videoUrl = findVideoUrl(tweetEl);
        if (videoUrl) {
          const a = document.createElement('a');
          a.href = videoUrl;
          a.download = `xactions_video_${tweetId}.mp4`;
          a.click();
          btn.innerHTML = '✅';
          window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'videoDownloader', action: `⬇ Downloaded video from tweet ${tweetId}` }, '*');
          log(`⬇ Downloaded video from tweet ${tweetId}`, 'success');
        } else {
          // Fallback: open tweet in new tab for manual download
          btn.innerHTML = '🔗';
          btn.title = 'Could not extract video URL — try right-click > Save Video';
          log(`⚠️ Could not extract video URL for tweet ${tweetId}`, 'warning');
        }
        setTimeout(() => { btn.innerHTML = '⬇'; btn.title = 'Download video (XFlow)'; }, 3000);
      });

      actionBar.appendChild(btn);
    }

    if (opts.showButton) {
      // Initial scan
      document.querySelectorAll(SELECTORS.tweet).forEach(addDownloadButton);

      // Watch for new tweets
      const observer = new MutationObserver(() => {
        document.querySelectorAll(SELECTORS.tweet).forEach(addDownloadButton);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Store observer so we can disconnect on stop
      window.__xactions_videoObserver = observer;

      // Keep running until stopped
      while (!automationStopFlags['videoDownloader']) {
        await sleep(5000);
      }
      observer.disconnect();
      window.__xactions_videoObserver = null;
    }

    log('🎬 Video Downloader disabled', 'info');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'videoDownloader', summary: 'Video downloader stopped' }, '*');
  });

  // ============================================
  // UNFOLLOWER DETECTOR
  // ============================================
  registerAutomation('unfollowerDetector', async (settings) => {
    const { log, sleep, scrollBy, waitForElements, SELECTORS, storage } = window.XActions.Core;
    const opts = {
      notifications: settings.notifications !== false,
      keepHistory: settings.keepHistory !== false,
    };

    log('🔔 Unfollower Detector scanning...', 'info');

    // Get current path to determine username
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username || pathParts[2] !== 'followers') {
      log('⚠️ Navigate to your followers page first (x.com/YOUR_USERNAME/followers)', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'unfollowerDetector', error: 'Navigate to your followers page (x.com/YOUR_USERNAME/followers)' }, '*');
      return;
    }

    const currentFollowers = new Set();
    let scrollAttempts = 0;
    let lastCount = 0;
    let noNewCount = 0;

    // Scroll through followers page and collect
    while (scrollAttempts < 100 && noNewCount < 5 && !automationStopFlags['unfollowerDetector']) {
      const cells = document.querySelectorAll(SELECTORS.userCell);
      cells.forEach(cell => {
        const userLink = cell.querySelector('a[href^="/"]');
        const handle = userLink?.getAttribute('href')?.replace('/', '');
        if (handle) currentFollowers.add(handle.toLowerCase());
      });

      if (currentFollowers.size === lastCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
        lastCount = currentFollowers.size;
      }

      scrollBy(800);
      scrollAttempts++;
      await sleep(1000);
    }

    log(`📋 Found ${currentFollowers.size} current followers`, 'info');

    // Compare with previous snapshot
    const previousFollowers = new Set(storage.get('follower_snapshot') || []);
    const unfollowers = [];

    if (previousFollowers.size > 0) {
      for (const prev of previousFollowers) {
        if (!currentFollowers.has(prev)) {
          unfollowers.push(prev);
        }
      }
      const newFollowers = [];
      for (const curr of currentFollowers) {
        if (!previousFollowers.has(curr)) {
          newFollowers.push(curr);
        }
      }

      if (unfollowers.length > 0) {
        log(`🚨 ${unfollowers.length} unfollower(s): ${unfollowers.map(u => '@' + u).join(', ')}`, 'warning');
        window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'unfollowerDetector', action: `🚨 Detected ${unfollowers.length} unfollower(s): ${unfollowers.map(u => '@' + u).join(', ')}` }, '*');
      } else {
        log('✅ No unfollowers detected since last scan', 'success');
      }
      if (newFollowers.length > 0) {
        log(`🎉 ${newFollowers.length} new follower(s): ${newFollowers.map(u => '@' + u).join(', ')}`, 'success');
      }

      // Save unfollower history
      if (opts.keepHistory && unfollowers.length > 0) {
        const history = storage.get('unfollower_history') || [];
        history.unshift({ date: Date.now(), unfollowers, newFollowers });
        if (history.length > 50) history.length = 50;
        storage.set('unfollower_history', history);
      }
    } else {
      log('📸 First scan — saving follower snapshot for future comparison', 'info');
    }

    // Save current snapshot
    storage.set('follower_snapshot', Array.from(currentFollowers));
    storage.set('last_follower_scan', Date.now());

    log(`✅ Unfollower scan complete! ${currentFollowers.size} followers recorded`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'unfollowerDetector', summary: `${unfollowers.length} unfollower(s), ${currentFollowers.size} total followers` }, '*');
  });

  // ============================================
  // BEST TIME TO POST
  // ============================================
  registerAutomation('bestTimeToPost', async (settings) => {
    const { log, sleep, scrollBy, SELECTORS, storage } = window.XActions.Core;
    const opts = {
      tweetCount: settings.tweetCount || 50,
      timezone: settings.timezone || 'local',
    };

    log(`📊 Best Time to Post — analyzing ${opts.tweetCount} tweets...`, 'info');

    const tweetData = [];
    let scrollAttempts = 0;
    let noNewCount = 0;
    let lastCount = 0;
    const seenTweets = new Set();

    while (tweetData.length < opts.tweetCount && scrollAttempts < 80 && noNewCount < 5 && !automationStopFlags['bestTimeToPost']) {
      const tweets = document.querySelectorAll(SELECTORS.tweet);

      for (const tweet of tweets) {
        if (tweetData.length >= opts.tweetCount) break;
        const link = tweet.querySelector(SELECTORS.tweetLink)?.href || '';
        const tweetId = link.match(/status\/(\d+)/)?.[1];
        if (!tweetId || seenTweets.has(tweetId)) continue;
        seenTweets.add(tweetId);

        // Extract engagement data
        const text = tweet.querySelector(SELECTORS.tweetText)?.textContent || '';
        const timeEl = tweet.querySelector('time');
        const datetime = timeEl?.getAttribute('datetime');
        if (!datetime) continue;

        // Count likes, retweets, replies from aria-labels
        const groups = tweet.querySelectorAll('[role="group"] button');
        let likes = 0, retweets = 0, replies = 0;
        groups.forEach(btn => {
          const label = btn.getAttribute('aria-label') || '';
          const likeMatch = label.match(/(\d+)\s*[Ll]ike/);
          const rtMatch = label.match(/(\d+)\s*[Rr]e(?:post|tweet)/);
          const replyMatch = label.match(/(\d+)\s*repl/i);
          if (likeMatch) likes = parseInt(likeMatch[1]);
          if (rtMatch) retweets = parseInt(rtMatch[1]);
          if (replyMatch) replies = parseInt(replyMatch[1]);
        });

        const date = new Date(datetime);
        tweetData.push({
          tweetId,
          datetime,
          hour: date.getHours(),
          day: date.getDay(),
          dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
          likes,
          retweets,
          replies,
          engagement: likes + retweets + replies,
          text: text.substring(0, 80),
        });

        window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'bestTimeToPost', action: `📊 Analyzed tweet ${tweetData.length}/${opts.tweetCount}` }, '*');
      }

      if (tweetData.length === lastCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
        lastCount = tweetData.length;
      }

      scrollBy(800);
      scrollAttempts++;
      await sleep(1000);
    }

    // Compute best times
    const hourStats = {};
    const dayStats = {};
    for (let h = 0; h < 24; h++) hourStats[h] = { total: 0, count: 0 };
    for (let d = 0; d < 7; d++) dayStats[d] = { total: 0, count: 0 };

    for (const t of tweetData) {
      hourStats[t.hour].total += t.engagement;
      hourStats[t.hour].count++;
      dayStats[t.day].total += t.engagement;
      dayStats[t.day].count++;
    }

    const bestHours = Object.entries(hourStats)
      .filter(([, v]) => v.count > 0)
      .map(([h, v]) => ({ hour: parseInt(h), avg: v.total / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);

    const bestDays = Object.entries(dayStats)
      .filter(([, v]) => v.count > 0)
      .map(([d, v]) => ({ day: parseInt(d), dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d], avg: v.total / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);

    // Save results
    const results = { tweetData, bestHours, bestDays, analyzedAt: Date.now(), tweetCount: tweetData.length };
    storage.set('best_time_results', results);

    if (bestHours.length > 0) {
      const top3 = bestHours.slice(0, 3).map(h => `${h.hour}:00 (avg ${h.avg.toFixed(1)} eng)`).join(', ');
      log(`🏆 Best hours: ${top3}`, 'success');
    }
    if (bestDays.length > 0) {
      const topDay = bestDays[0];
      log(`📅 Best day: ${topDay.dayName} (avg ${topDay.avg.toFixed(1)} engagement)`, 'success');
    }

    log(`✅ Analyzed ${tweetData.length} tweets!`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'bestTimeToPost', summary: `${tweetData.length} tweets analyzed` }, '*');
  });

  // ============================================
  // THREAD READER
  // ============================================
  registerAutomation('threadReader', async (settings) => {
    const { log, sleep, SELECTORS } = window.XActions.Core;
    const opts = {
      showUnrollBtn: settings.showUnrollBtn !== false,
      autoDetect: settings.autoDetect !== false,
      maxTweets: settings.maxTweets || 50,
    };

    log('🧵 Thread Reader enabled — watching for threads...', 'info');

    const processedThreads = new Set();

    function isThread(tweetEl) {
      // Thread indicators: "Show this thread" link, self-reply chain, thread line
      const showThread = tweetEl.querySelector('a[href*="/status/"]')?.textContent?.includes('Show this thread');
      const threadLine = tweetEl.querySelector('[data-testid="tweet-thread-line"]') || tweetEl.parentElement?.querySelector('[style*="border-left"]');
      return showThread || threadLine;
    }

    function addUnrollButton(tweetEl) {
      const tweetLink = tweetEl.querySelector(SELECTORS.tweetLink)?.href || '';
      const tweetId = tweetLink.match(/status\/(\d+)/)?.[1];
      if (!tweetId || processedThreads.has(tweetId)) return;
      if (!isThread(tweetEl)) return;

      processedThreads.add(tweetId);

      const actionBar = tweetEl.querySelector('[role="group"]');
      if (!actionBar) return;

      const btn = document.createElement('button');
      btn.className = 'xactions-unroll-btn';
      btn.innerHTML = '🧵';
      btn.title = 'Unroll thread (XFlow)';
      btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;padding:4px 8px;border-radius:50%;transition:background 0.2s;color:#1d9bf0;';
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(29,155,240,0.1)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'none');

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.innerHTML = '⏳';

        // Collect thread tweets by navigating to the tweet
        const threadTweets = [];
        const currentTweets = document.querySelectorAll(SELECTORS.tweet);
        currentTweets.forEach(t => {
          const text = t.querySelector(SELECTORS.tweetText)?.textContent || '';
          if (text) threadTweets.push(text);
        });

        if (threadTweets.length > 0) {
          // Create overlay with unrolled thread
          const overlay = document.createElement('div');
          overlay.id = 'xactions-thread-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;overflow-y:auto;padding:20px;';

          const container = document.createElement('div');
          container.style.cssText = 'max-width:600px;margin:0 auto;background:#16181c;border-radius:16px;padding:20px;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;';

          const header = document.createElement('div');
          header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #2f3336;';
          header.innerHTML = `<span style="font-size:18px;font-weight:700;">🧵 Thread (${threadTweets.length} tweets)</span>`;

          const closeBtn = document.createElement('button');
          closeBtn.textContent = '✕';
          closeBtn.style.cssText = 'background:none;border:none;color:#71767b;font-size:20px;cursor:pointer;padding:4px 8px;border-radius:50%;';
          closeBtn.addEventListener('click', () => overlay.remove());
          header.appendChild(closeBtn);
          container.appendChild(header);

          threadTweets.slice(0, opts.maxTweets).forEach((text, i) => {
            const p = document.createElement('div');
            p.style.cssText = 'padding:12px 0;border-bottom:1px solid #2f3336;font-size:15px;line-height:1.5;';
            p.innerHTML = `<span style="color:#71767b;font-size:12px;">${i + 1}/${threadTweets.length}</span><br>${text}`;
            container.appendChild(p);
          });

          // Copy all button
          const copyBtn = document.createElement('button');
          copyBtn.textContent = '📋 Copy Thread';
          copyBtn.style.cssText = 'display:block;margin:16px auto 0;background:#1d9bf0;color:white;border:none;padding:10px 24px;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;';
          copyBtn.addEventListener('click', () => {
            const fullText = threadTweets.map((t, i) => `${i + 1}. ${t}`).join('\n\n');
            navigator.clipboard.writeText(fullText);
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy Thread'; }, 2000);
          });
          container.appendChild(copyBtn);

          overlay.appendChild(container);
          overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
          document.body.appendChild(overlay);

          btn.innerHTML = '🧵';
          window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'threadReader', action: `🧵 Unrolled thread with ${threadTweets.length} tweets` }, '*');
          log(`🧵 Unrolled thread: ${threadTweets.length} tweets`, 'success');
        } else {
          btn.innerHTML = '🧵';
          log('⚠️ Could not collect thread tweets', 'warning');
        }
      });

      actionBar.appendChild(btn);
    }

    if (opts.showUnrollBtn) {
      document.querySelectorAll(SELECTORS.tweet).forEach(addUnrollButton);

      const observer = new MutationObserver(() => {
        document.querySelectorAll(SELECTORS.tweet).forEach(addUnrollButton);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__xactions_threadObserver = observer;

      while (!automationStopFlags['threadReader']) {
        await sleep(5000);
      }
      observer.disconnect();
      window.__xactions_threadObserver = null;
    }

    log('🧵 Thread Reader disabled', 'info');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'threadReader', summary: 'Thread reader stopped' }, '*');
  });

  // ============================================
  // QUICK STATS
  // ============================================
  registerAutomation('quickStats', async (settings) => {
    const { log, sleep, scrollBy, SELECTORS, storage } = window.XActions.Core;
    const opts = {
      showOverlay: settings.showOverlay !== false,
      trackDaily: settings.trackDaily !== false,
      sampleSize: settings.sampleSize || 20,
    };

    log('⚡ Quick Stats — calculating engagement rate...', 'info');

    // Collect engagement data from visible tweets
    const tweetStats = [];
    let scrollAttempts = 0;
    let noNewCount = 0;
    let lastCount = 0;
    const seenIds = new Set();

    while (tweetStats.length < opts.sampleSize && scrollAttempts < 40 && noNewCount < 3 && !automationStopFlags['quickStats']) {
      const tweets = document.querySelectorAll(SELECTORS.tweet);

      for (const tweet of tweets) {
        if (tweetStats.length >= opts.sampleSize) break;
        const link = tweet.querySelector(SELECTORS.tweetLink)?.href || '';
        const tweetId = link.match(/status\/(\d+)/)?.[1];
        if (!tweetId || seenIds.has(tweetId)) continue;
        seenIds.add(tweetId);

        const groups = tweet.querySelectorAll('[role="group"] button');
        let likes = 0, retweets = 0, replies = 0, views = 0;
        groups.forEach(btn => {
          const label = btn.getAttribute('aria-label') || '';
          const likeMatch = label.match(/(\d+)\s*[Ll]ike/);
          const rtMatch = label.match(/(\d+)\s*[Rr]e(?:post|tweet)/);
          const replyMatch = label.match(/(\d+)\s*repl/i);
          const viewMatch = label.match(/(\d+)\s*[Vv]iew/);
          if (likeMatch) likes = parseInt(likeMatch[1]);
          if (rtMatch) retweets = parseInt(rtMatch[1]);
          if (replyMatch) replies = parseInt(replyMatch[1]);
          if (viewMatch) views = parseInt(viewMatch[1]);
        });

        tweetStats.push({ tweetId, likes, retweets, replies, views, engagement: likes + retweets + replies });
      }

      if (tweetStats.length === lastCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
        lastCount = tweetStats.length;
      }

      scrollBy(600);
      scrollAttempts++;
      await sleep(800);
    }

    if (tweetStats.length === 0) {
      log('⚠️ No tweets found to analyze', 'warning');
      window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_ERROR', automationId: 'quickStats', error: 'No tweets found' }, '*');
      return;
    }

    // Calculate stats
    const totalEngagement = tweetStats.reduce((sum, t) => sum + t.engagement, 0);
    const totalViews = tweetStats.reduce((sum, t) => sum + t.views, 0);
    const avgEngagement = totalEngagement / tweetStats.length;
    const engagementRate = totalViews > 0 ? ((totalEngagement / totalViews) * 100).toFixed(2) : 'N/A';
    const avgLikes = (tweetStats.reduce((s, t) => s + t.likes, 0) / tweetStats.length).toFixed(1);
    const avgRetweets = (tweetStats.reduce((s, t) => s + t.retweets, 0) / tweetStats.length).toFixed(1);
    const avgReplies = (tweetStats.reduce((s, t) => s + t.replies, 0) / tweetStats.length).toFixed(1);

    const results = {
      tweetCount: tweetStats.length,
      totalEngagement,
      totalViews,
      avgEngagement: avgEngagement.toFixed(1),
      engagementRate,
      avgLikes,
      avgRetweets,
      avgReplies,
      analyzedAt: Date.now(),
    };

    storage.set('quick_stats', results);

    // Track daily
    if (opts.trackDaily) {
      const dailyHistory = storage.get('daily_stats') || [];
      dailyHistory.unshift({ ...results, date: new Date().toISOString().slice(0, 10) });
      if (dailyHistory.length > 90) dailyHistory.length = 90;
      storage.set('daily_stats', dailyHistory);
    }

    // Show overlay on page
    if (opts.showOverlay) {
      // Remove existing overlay
      document.querySelector('#xactions-stats-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'xactions-stats-overlay';
      overlay.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#16181c;border:1px solid #2f3336;border-radius:16px;padding:16px;z-index:99998;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;min-width:220px;box-shadow:0 4px 12px rgba(0,0,0,0.5);';
      overlay.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-weight:700;font-size:14px;">⚡ Quick Stats</span>
          <button id="xactions-close-stats" style="background:none;border:none;color:#71767b;cursor:pointer;font-size:16px;">✕</button>
        </div>
        <div style="font-size:12px;color:#71767b;margin-bottom:8px;">${tweetStats.length} tweets analyzed</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:#000;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#1d9bf0;">${engagementRate}%</div>
            <div style="font-size:10px;color:#71767b;">Eng. Rate</div>
          </div>
          <div style="background:#000;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#00ba7c;">${avgEngagement.toFixed(0)}</div>
            <div style="font-size:10px;color:#71767b;">Avg Eng.</div>
          </div>
          <div style="background:#000;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:14px;font-weight:700;">❤️ ${avgLikes}</div>
            <div style="font-size:10px;color:#71767b;">Avg Likes</div>
          </div>
          <div style="background:#000;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:14px;font-weight:700;">🔁 ${avgRetweets}</div>
            <div style="font-size:10px;color:#71767b;">Avg RTs</div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#xactions-close-stats').addEventListener('click', () => overlay.remove());
    }

    window.postMessage({ source: 'xactions-page', type: 'ACTION_PERFORMED', automationId: 'quickStats', action: `⚡ Engagement rate: ${engagementRate}%, avg: ${avgEngagement.toFixed(1)} per tweet` }, '*');
    log(`⚡ Engagement rate: ${engagementRate}% | Avg: ${avgEngagement.toFixed(1)} | Likes: ${avgLikes} | RTs: ${avgRetweets} | Replies: ${avgReplies}`, 'success');
    window.postMessage({ source: 'xactions-page', type: 'AUTOMATION_COMPLETE', automationId: 'quickStats', summary: `${engagementRate}% engagement rate (${tweetStats.length} tweets)` }, '*');
  });

})();
