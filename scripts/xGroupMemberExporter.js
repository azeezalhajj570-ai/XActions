// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
// scripts/xGroupMemberExporter.js
// Browser console script to extract ALL participants from an X Group DM and
// export them as CSV or JSON.
//
// Usage:
//   1. Open the group chat in the browser:  https://x.com/i/chat/g<id>
//   2. Open the group's "All Members" (جميع الأعضاء) view
//      (click the group header info button -> Members / All Members).
//   3. Paste this script in the DevTools console on x.com and press Enter.
//   4. The script scrolls the virtualized member list until every member is
//      loaded, then offers a CSV or JSON download.
//
// Configuration (edit before pasting if you want):
//   CONFIG.format  = 'csv' | 'json' | 'both'
//   CONFIG.maxScrolls = max scroll passes (80 default, enough for 500+)
//
// by nich (@nichxbt)

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CONFIG = {
    format: 'both',      // 'csv' | 'json' | 'both'
    maxScrolls: 80,      // scroll passes before giving up
    scrollPauseMs: 500,  // pause between scroll passes (let rows render)
  };

  const download = (filename, text, type) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const collect = (seen, members) => {
    let added = 0;
    document.querySelectorAll('a[href^="/"]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      const username = (href.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
      if (!username || username === 'home' || username === 'search' || username === 'messages'
        || username === 'i' || username === 'settings' || username === 'notifications'
        || username === 'explore' || username === 'compose') return;
      if (seen.has(username)) return;
      const img = link.querySelector('img');
      if (!img?.src) return; // only avatar links are member rows
      seen.add(username);
      const nameEl = link.querySelector('[dir="ltr"] > span')
        || link.closest('[role="button"]')?.querySelector('span')
        || link.parentElement?.parentElement?.querySelector('span');
      members.push({
        username,
        display_name: nameEl?.textContent?.trim() || username,
        profile_url: `https://x.com/${username}`,
        avatar_url: img.src || '',
      });
      added++;
    });
    return added;
  };

  const toCSV = (members) => {
    const header = 'username,display_name,profile_url,avatar_url';
    const rows = members.map((m) => [
      m.username, m.display_name, m.profile_url, m.avatar_url,
    ].map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    return [header, ...rows].join('\n');
  };

  const run = async () => {
    console.log('👥 XFlow X Group DM Member Exporter');
    console.log('===================================');

    // Try to open the All Members view if it isn't already visible.
    const headerBtn = document.querySelector(
      '[data-testid="conversationInfoButton"], [data-testid="DmGroupInfoButton"], [aria-label="Conversation info"], [aria-label="Group info"]',
    );
    if (headerBtn) {
      headerBtn.click();
      await sleep(900);
      const memberRow = [...document.querySelectorAll('[role="menuitem"], [role="button"]')]
        .find((el) => /members|الأعضاء|people/i.test(el.textContent || '') && /all|كل/i.test(el.textContent || ''));
      if (memberRow) { memberRow.click(); await sleep(900); }
    }

    const seen = new Set();
    const members = [];
    let added = collect(seen, members);
    console.log(`🔍 ${members.length} members visible — scrolling to load the rest...`);

    // Scroll the member list until a full pass adds nothing new.
    let scrollable = document.querySelector('[data-testid="conversationMembers"], [aria-label="Members"], [data-testid="Scrollable"]');
    for (let i = 0; i < CONFIG.maxScrolls; i++) {
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      else window.scrollBy(0, window.innerHeight * 0.8);
      await sleep(CONFIG.scrollPauseMs);
      added = collect(seen, members);
      if (added === 0) {
        // One more pass to let the tail settle before declaring done.
        await sleep(CONFIG.scrollPauseMs);
        added = collect(seen, members);
        if (added === 0) break;
      }
    }

    console.log(`\n✅ Found ${members.length} unique members:`);
    members.forEach((m, i) => console.log(`${String(i + 1).padStart(3)}. @${m.username}  ${m.display_name}`));

    if (members.length === 0) {
      console.warn('⚠️ No members found. Make sure you are on the group chat with the "All Members" view open.');
      return;
    }

    if (CONFIG.format === 'csv' || CONFIG.format === 'both') {
      download('x-group-members.csv', toCSV(members), 'text/csv');
      console.log('📄 Downloaded x-group-members.csv');
    }
    if (CONFIG.format === 'json' || CONFIG.format === 'both') {
      download('x-group-members.json', JSON.stringify(members, null, 2), 'application/json');
      console.log('📄 Downloaded x-group-members.json');
    }
  };

  run().catch((err) => console.error('❌ X Group Member Exporter failed:', err));
})();
