# Engage a whole profile: like, repost, and reply to every post

> Sweep an account's entire timeline in one go, from the browser console or the terminal, with replies written by you or by an LLM from a one-line brief.

Doing this by hand on a profile with a hundred posts takes twenty minutes of
clicking. This does the same thing while you make coffee, at a pace X does not
mind, and it remembers what it already did so you can stop and pick up later.

Two surfaces, one behaviour:

| Surface | File | Best when |
|---------|------|-----------|
| Browser console | [`scripts/engageProfile.js`](../scripts/engageProfile.js) | You are already logged into x.com in a tab. Nothing to install. A floating panel drives it. |
| CLI | `xactions engage <username>` ([`src/cli/commands/engage.js`](../src/cli/commands/engage.js)) | You want any LLM provider, a cron, JSON output, or no browser at all. |

Both like, repost, and reply per post, skip what they already did, pace
themselves like a fast human, and back off when X pushes back.

---

## Browser console

1. Open `https://x.com/USERNAME` (or `/USERNAME/with_replies` to include their replies).
2. Open DevTools (<kbd>F12</kbd>), Console tab.
3. Paste [`scripts/engageProfile.js`](../scripts/engageProfile.js). A panel appears bottom-right.
4. Tick the actions you want. Leave **Dry run** on. Click **▶ Start**.
5. Read the log. When it looks right, untick **Dry run** and start again.

The panel controls everything the `CONFIG` block at the top of the script does.
<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> starts and stops, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pauses.
`window.XEngage` exposes `start()`, `pause()`, `stop()`, `undo()`, `export()`, `config`, and `state` for the console.

### What "every post" means

The script walks the profile top to bottom, reading each post as it scrolls
into view, and stops after six scrolls that surface nothing new. Per post it
decides:

| Post | Default | Change with |
|------|---------|-------------|
| The account's own posts | engaged | |
| Posts it reposted from others | skipped | "Include posts it reposted from others" |
| Its replies | skipped (they are not on the Posts tab anyway) | open `/with_replies`, or tick "Include the account's replies" |
| Promoted posts | skipped | never engaged |
| Posts you already liked or reposted | that action is skipped | untick "Skip posts already engaged" |
| Posts done in an earlier run | skipped | **Reset progress** |

Progress lives in `localStorage` under `xactions_engage_<handle>`, so a
reload, a crash, or closing the tab does not lose it. Dry runs do not write
to it.

### Pacing

| Preset | Between posts | Between actions on one post |
|--------|---------------|-----------------------------|
| Stealth | 45 to 90 s | 2.5 to 5 s |
| Safe (default) | 15 to 35 s | 1.8 to 3.5 s |
| Moderate | 7 to 15 s | 1.2 to 2.5 s |
| Fast | 3 to 7 s | 0.9 to 1.8 s |

On top of the preset it rests for 90 seconds every 20 posts, and after three
failed actions in a row it backs off for five minutes. Every action is
verified against the DOM (the like button must turn into an unlike button, the
composer must close) and any toast that reads like a throttle stops the run
early rather than burning through the limit. Expect a 100-post sweep on Safe
to take 40 to 60 minutes. That is the point: the twenty-minute manual version
is exactly the pattern X flags.

### Replies: templates

One template per line in the panel. `{author}` becomes `@handle`, `{name}`
the display name. The same template is never used twice in a row.

### Replies: AI

Switch **Source** to AI and write the brief, for example:

> Reply as a thoughtful builder who genuinely follows this account. Be specific to the post, add one idea or one honest question, keep it under two sentences, no hype words.

The model gets your brief, the post text, the quoted post if any, a note when
there is media it cannot see, and your last five replies so it varies its
phrasing. The reply is sanitised (no fences, quotes, labels, or hashtags) and
regenerated once if it opens with boilerplate like "Great post". **Test on the
first post** shows what it would write without posting anything.

Which provider you can use from the console is decided by x.com, not by us:

- **xAI (Grok)**: works straight from the console. x.com's Content-Security-Policy
  allows `connect-src https://*.x.ai`, so `fetch` to `api.x.ai` goes through.
  Get a key at [console.x.ai](https://console.x.ai). Default model `grok-3-mini`.
- **OpenRouter, OpenAI, Anthropic, Ollama, anything else**: the same CSP blocks
  them from the page. Two ways around it:
  1. Install the [XActions browser extension](../extension/) and pick
     **XActions extension (any provider)** in the panel. The page hands the
     request to the extension's service worker, which is not bound by the
     page's CSP, and gets the text back.
  2. Use the CLI below, which has no CSP at all.

"Remember key in this browser" stores the key in `localStorage` on x.com.
Leave it unticked on a shared machine.

If the model fails on a post, the script falls back to a template (tick
"Fall back to templates if the model fails"), otherwise it skips the reply and
still does the like and repost.

### Undo and export

**↩** unlikes and un-reposts everything from the current session. Replies are
left in place, since deleting posts is a different kind of action; the export
lists every reply with its URL so you can find them. **⬇ Export log** downloads
a JSON record of the run: config (key redacted), counts, and per-post results.

---

## CLI

```bash
xactions connect                     # once: log in through a real browser
xactions engage nasa --like --repost --dry-run
xactions engage nasa --like --repost --comment --prompt "supportive, specific, one honest question, no hype"
```

Runs on the HTTP client: no Chromium, no DOM. Any provider works because there
is no page CSP in the way.

### Options

| Flag | What it does |
|------|--------------|
| `--like` / `--repost` / `--comment` | Which actions to take. At least one is required. |
| `-l, --limit <n>` | Posts to engage this run (default 100). Reads further back than this to fill the quota after filtering. |
| `--replies` | Include the account's replies. |
| `--reposts` | Include posts it reposted from others. |
| `--since <date>` | Only posts on or after this date. |
| `--template <text>` | A reply template, repeatable. `{author}` and `{name}` are filled in. |
| `--templates-file <path>` | One template per line; `#` lines are comments. |
| `--prompt <brief>` | Turns on AI replies. The brief is the whole instruction. |
| `--persona <text>` | Optional first line of the system prompt, e.g. "You are @you, a founder building X". |
| `--provider <name>` | `openrouter` (default), `openai`, `xai`, `anthropic`, `ollama`, `custom`. |
| `--model <name>` | Provider default if omitted: `google/gemini-2.5-flash`, `gpt-4o-mini`, `grok-3-mini`, `claude-3-5-haiku-latest`, `llama3.1`. |
| `--api-key <key>` | Or set `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`. Ollama needs none. |
| `--base-url <url>` | For `--provider custom`: a full OpenAI-compatible chat-completions URL. |
| `--delay <s>` / `--jitter <s>` | Seconds between posts (default 20 ± 10). |
| `--dry-run` | Print everything, including the generated replies, post nothing. |
| `--reset` | Forget saved progress for this profile first. |
| `--no-resume` | Neither read nor write saved progress for this run. |
| `--json` | Machine-readable report on stdout, nothing else. |

When both `--prompt` and templates are given, the model is used and a template
is the fallback if it fails. Rate limits from X pause the run for the time X
asks (five minutes when it does not say), then continue.

Progress is saved to `~/.xactions/engage/<handle>.json`. A second run on the
same profile skips posts that are fully done and finishes the ones that had an
action fail.

### As a cron

```bash
# Every morning: like and reply to whatever @nasa posted since yesterday
0 9 * * * XAI_API_KEY=xai-... xactions engage nasa --like --comment --provider xai \
  --prompt "curious, specific, one question" --since "$(date -d yesterday +%F)" --json >> ~/engage.log
```

---

## API

The same comment generator is exposed for other tools and agents:

```http
POST /api/ai/writer/comment
Content-Type: application/json

{
  "tweet": { "text": "We cut p99 latency from 900ms to 40ms", "author": "nasa" },
  "prompt": "engineer who is curious about the how, one question, no hype",
  "provider": "openrouter",
  "history": ["Nice detail on the retry budget."]
}
```

```json
{
  "success": true,
  "data": { "comment": "What moved on the hot path to get 900 down to 40? Caching or a rewrite?", "model": "google/gemini-2.5-flash", "attempts": 1, "provider": "openrouter" },
  "operation": "ai:generate-comment"
}
```

No voice profile is needed, unlike `/api/ai/writer/reply`. `history` is the
list of replies already posted so the model varies its phrasing.

From Node:

```js
import { createCommentGenerator } from 'xactions/ai';

const gen = createCommentGenerator({ prompt: 'dry wit, one sentence', provider: 'xai' });
const { text } = await gen.generate({ text: 'Shipping v2 today', author: 'nasa' });
```

---

## Staying out of trouble

- **Dry run first, every time.** Both surfaces default to it.
- **Safe preset or slower** for accounts under a year old or under a thousand followers.
- **Stop when actions start failing.** The script does this for you after three failures; when it happens, wait an hour.
- **Replies are public and permanent.** Read a dry run's generated replies before letting a model post as you. A bad brief produces a hundred bad replies.
- **One profile per session.** Sweeping several accounts back to back multiplies the write count X sees.

Related: [Engagement Booster](engagement-booster.md) for the filtered,
score-driven version across timelines and search, [browser scripts](browser-scripts.md)
for the catalog, [CLI reference](cli-reference.md).
