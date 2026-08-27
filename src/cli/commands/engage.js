// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * `xactions engage <username>`: like, repost, and reply to every post on a
 * profile from the terminal, with comments from templates or from an LLM
 * given a one-line brief.
 *
 * This is the no-browser twin of `scripts/engageProfile.js`. It runs on the
 * HTTP client, so there is no Chromium, no DOM, and no Content-Security-Policy
 * in the way of the model call: any provider works. Progress is saved per
 * profile under ~/.xactions/engage/, so a second run skips what the first one
 * already did.
 *
 * @author nich (@nichxbt) - https://github.com/nirholas
 * @license Apache-2.0
 */
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';

import { createCommentGenerator, DEFAULT_MODELS } from '../../ai/commentGenerator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pick the posts a run should touch.
 *
 * @param {Array<object>} tweets - Tweet models from the client
 * @param {object} opts
 * @param {boolean} [opts.includeReplies=false]
 * @param {boolean} [opts.includeReposts=false]
 * @param {Date|null} [opts.since=null]
 * @param {number} [opts.limit=Infinity]
 * @param {Record<string, object>} [opts.done={}] - Prior state, keyed by tweet id
 * @param {{like:boolean, repost:boolean, comment:boolean}} opts.actions
 * @returns {{ selected: object[], skipped: Array<{ id: string, why: string }> }}
 */
export function selectTweets(tweets, opts) {
  const { includeReplies = false, includeReposts = false, since = null, limit = Infinity, done = {}, actions } = opts;
  const selected = [];
  const skipped = [];
  for (const tweet of tweets) {
    if (selected.length >= limit) break;
    if (!tweet?.id) continue;
    if (tweet.isRetweet && !includeReposts) { skipped.push({ id: tweet.id, why: 'repost' }); continue; }
    if (tweet.isReply && !includeReplies) { skipped.push({ id: tweet.id, why: 'reply' }); continue; }
    if (since && tweet.timeParsed && new Date(tweet.timeParsed) < since) { skipped.push({ id: tweet.id, why: 'older than --since' }); continue; }
    const record = done[tweet.id];
    if (record) {
      const remaining = (actions.like && !record.liked) || (actions.repost && !record.reposted) || (actions.comment && !record.commented);
      if (!remaining) { skipped.push({ id: tweet.id, why: 'already done' }); continue; }
    }
    if (!tweet.text && !(tweet.photos?.length || tweet.videos?.length)) { skipped.push({ id: tweet.id, why: 'empty' }); continue; }
    selected.push(tweet);
  }
  return { selected, skipped };
}

/**
 * Parse reply templates from repeated flags and an optional file.
 * One template per line; blank lines and `#` comments are ignored.
 *
 * @param {string[]} [fromFlags=[]]
 * @param {string} [fileContents='']
 * @returns {string[]}
 */
export function parseTemplates(fromFlags = [], fileContents = '') {
  const lines = fileContents.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return [...fromFlags.map((t) => t.trim()).filter(Boolean), ...lines];
}

/**
 * Choose the next template, never the same one twice in a row, and fill in
 * the placeholders.
 *
 * @param {string[]} templates
 * @param {{ username?: string, name?: string }} tweet
 * @param {number} lastIndex
 * @param {() => number} [random=Math.random]
 * @returns {{ text: string, index: number }}
 */
export function pickTemplate(templates, tweet, lastIndex, random = Math.random) {
  if (templates.length === 0) return { text: '', index: -1 };
  let index = 0;
  if (templates.length > 1) {
    do { index = Math.floor(random() * templates.length); } while (index === lastIndex);
  }
  const text = templates[index]
    .replace(/\{author\}/g, `@${tweet.username || ''}`)
    .replace(/\{name\}/g, tweet.name || (tweet.username ? `@${tweet.username}` : ''));
  return { text, index };
}

/**
 * Where the per-profile progress file lives.
 * @param {string} configDir
 * @param {string} username
 */
export function statePath(configDir, username) {
  return path.join(configDir, 'engage', `${username.toLowerCase().replace(/[^a-z0-9_]/g, '')}.json`);
}

async function loadState(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return { done: {} };
  }
}

async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

/** Milliseconds to wait before the next post: base plus symmetric jitter. */
function nextDelay(baseSeconds, jitterSeconds) {
  const spread = (Math.random() * 2 - 1) * jitterSeconds;
  return Math.max(1000, Math.round((baseSeconds + spread) * 1000));
}

function isRateLimit(err) {
  return err?.name === 'RateLimitError' || /rate limit|too many requests|429/i.test(err?.message || '');
}

/**
 * Register the command.
 *
 * @param {import('commander').Command} program
 * @param {object} deps
 * @param {() => Promise<import('../../client/index.js').Scraper>} deps.createHttpScraper
 * @param {() => Promise<object>} deps.loadConfig
 * @param {string} deps.configDir
 */
export function registerEngageCommand(program, { createHttpScraper, loadConfig, configDir }) {
  program
    .command('engage <username>')
    .description('Like, repost, and reply to every post on a profile, with template or AI-written comments')
    .option('--like', 'Like each post')
    .option('--repost', 'Repost each post')
    .option('--comment', 'Reply to each post')
    .option('-l, --limit <number>', 'Maximum posts to engage this run', '100')
    .option('--replies', "Include the account's replies, not just its posts")
    .option('--reposts', 'Include posts the account reposted from others')
    .option('--since <date>', 'Only posts on or after this date (ISO, e.g. 2026-08-01)')
    .option('--prompt <brief>', 'AI mode: how the replies should sound. Turns on AI comments.')
    .option('--persona <text>', 'AI mode: who is writing, e.g. "You are @you, a founder building X"')
    .option('--template <text>', 'Reply template ({author}, {name} are filled in). Repeatable.', (v, all) => [...(all || []), v], [])
    .option('--templates-file <path>', 'File with one reply template per line')
    .option('--provider <name>', 'LLM provider: openrouter, openai, xai, anthropic, ollama, custom', 'openrouter')
    .option('--model <name>', 'LLM model (provider default if omitted)')
    .option('--api-key <key>', 'LLM API key (or set OPENROUTER_API_KEY / OPENAI_API_KEY / XAI_API_KEY / ANTHROPIC_API_KEY)')
    .option('--base-url <url>', 'Custom OpenAI-compatible chat-completions URL (provider custom)')
    .option('--delay <seconds>', 'Seconds to wait between posts', '20')
    .option('--jitter <seconds>', 'Random spread added to --delay', '10')
    .option('--dry-run', 'Show what would happen, including generated comments, without posting')
    .option('--reset', 'Forget saved progress for this profile before starting')
    .option('--no-resume', 'Ignore saved progress for this run (do not read or write it)')
    .option('--json', 'Print the run report as JSON on stdout')
    .addHelpText('after', `
Examples:
  $ xactions engage nasa --like --repost --dry-run
  $ xactions engage nasa --like --comment --template "Solid work on this, {name}." --template "Curious what changed your mind here?"
  $ xactions engage nasa --like --repost --comment --prompt "supportive, specific, one honest question, no hype"
  $ XAI_API_KEY=xai-... xactions engage nasa --comment --provider xai --prompt "dry wit, one sentence"
  $ xactions engage nasa --comment --provider ollama --model llama3.1 --prompt "thoughtful engineer" --limit 20

Needs a logged-in session for anything but --dry-run reads: run \`xactions connect\` or \`xactions login\` first.
Progress is saved per profile in ${path.join(configDir, 'engage')} so re-running skips posts already done.
`)
    .action(async (usernameArg, options) => {
      const username = usernameArg.replace(/^@/, '');
      const actions = { like: !!options.like, repost: !!options.repost, comment: !!options.comment };
      const quiet = !!options.json;
      const out = (...args) => { if (!quiet) console.log(...args); };

      if (!actions.like && !actions.repost && !actions.comment) {
        console.error(chalk.red('✗ Pick at least one of --like, --repost, --comment'));
        process.exitCode = 1;
        return;
      }

      const limit = Math.max(1, parseInt(options.limit, 10) || 100);
      const delay = Math.max(0, parseFloat(options.delay) || 0);
      const jitter = Math.max(0, parseFloat(options.jitter) || 0);
      const since = options.since ? new Date(options.since) : null;
      if (since && Number.isNaN(since.getTime())) {
        console.error(chalk.red(`✗ --since "${options.since}" is not a date`));
        process.exitCode = 1;
        return;
      }

      // Comment source
      let templates = [];
      let generator = null;
      if (actions.comment) {
        let fileContents = '';
        if (options.templatesFile) {
          try {
            fileContents = await fs.readFile(options.templatesFile, 'utf-8');
          } catch (err) {
            console.error(chalk.red(`✗ Could not read --templates-file: ${err.message}`));
            process.exitCode = 1;
            return;
          }
        }
        templates = parseTemplates(options.template, fileContents);

        if (options.prompt) {
          const config = await loadConfig();
          try {
            generator = createCommentGenerator({
              prompt: options.prompt,
              persona: options.persona,
              provider: options.provider,
              model: options.model,
              apiKey: options.apiKey || config.openrouter_api_key,
              baseUrl: options.baseUrl,
            });
          } catch (err) {
            console.error(chalk.red(`✗ ${err.message}`));
            process.exitCode = 1;
            return;
          }
        } else if (templates.length === 0) {
          console.error(chalk.red('✗ --comment needs either --prompt (AI) or at least one --template / --templates-file'));
          process.exitCode = 1;
          return;
        }
      }

      const spinner = ora({ text: `Reading @${username}`, isSilent: quiet }).start();
      const report = {
        username,
        dryRun: !!options.dryRun,
        actions,
        commentSource: generator ? `ai:${generator.target.provider}/${generator.target.model}` : (actions.comment ? 'templates' : null),
        startedAt: new Date().toISOString(),
        processed: 0, liked: 0, reposted: 0, commented: 0, failed: 0,
        skipped: [],
        results: [],
      };

      try {
        const scraper = await createHttpScraper();

        if (!options.dryRun) {
          const loggedIn = await scraper.isLoggedIn().catch(() => false);
          if (!loggedIn) {
            throw new Error('Not logged in. Run `xactions connect` (browser login) or `xactions login` (paste cookies) first, or add --dry-run to preview.');
          }
        }

        const file = statePath(configDir, username);
        const useState = options.resume !== false;
        let state = useState ? await loadState(file) : { done: {} };
        if (options.reset && useState) { state = { done: {} }; await saveState(file, state); }
        const priorCount = Object.keys(state.done).length;

        // Read more than the limit so filtered posts (replies, reposts, done) do not starve the run.
        const readLimit = Math.min(3000, limit * 3 + priorCount);
        const stream = options.replies ? scraper.getTweetsAndReplies(username, readLimit) : scraper.getTweets(username, readLimit);
        const fetched = [];
        for await (const tweet of stream) {
          fetched.push(tweet);
          spinner.text = `Reading @${username} (${fetched.length} posts)`;
          const { selected } = selectTweets(fetched, { includeReplies: !!options.replies, includeReposts: !!options.reposts, since, limit, done: state.done, actions });
          if (selected.length >= limit) break;
        }

        if (fetched.length === 0) {
          throw new Error(`No posts returned for @${username}. X served an empty timeline: check the handle, log in with \`xactions login\`, or retry in a minute if you are rate limited.`);
        }

        const { selected, skipped } = selectTweets(fetched, { includeReplies: !!options.replies, includeReposts: !!options.reposts, since, limit, done: state.done, actions });
        report.skipped = skipped;
        spinner.succeed(`@${username}: ${fetched.length} posts read, ${selected.length} to engage, ${skipped.length} skipped${priorCount ? `, ${priorCount} done in earlier runs` : ''}`);

        if (selected.length === 0) {
          out(chalk.yellow('Nothing left to do. Use --reset to start over, or --limit to read further back.'));
          if (quiet) console.log(JSON.stringify(report, null, 2));
          return;
        }

        const label = [actions.like && 'like', actions.repost && 'repost', actions.comment && 'reply'].filter(Boolean).join(' + ');
        out(chalk.gray(`${options.dryRun ? 'DRY RUN, ' : ''}${label}, ${delay}s ±${jitter}s between posts, comments from ${report.commentSource || 'nowhere'}\n`));

        let lastTemplate = -1;
        for (let i = 0; i < selected.length; i++) {
          const tweet = selected[i];
          const record = state.done[tweet.id] || { liked: false, reposted: false, commented: false };
          const preview = (tweet.text || '').replace(/\s+/g, ' ').slice(0, 72);
          const result = { id: tweet.id, url: `https://x.com/${tweet.username || username}/status/${tweet.id}`, text: preview, actions: [], errors: [] };
          out(chalk.bold(`[${i + 1}/${selected.length}] ${tweet.id}`) + chalk.gray(`  ${preview}${(tweet.text || '').length > 72 ? '…' : ''}`));

          const run = async (name, wants, fn) => {
            if (!wants) return;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const detail = await fn();
                result.actions.push(name);
                if (detail?.text) result.comment = detail.text;
                out(`   ${detail?.line || `${options.dryRun ? '[dry] would ' : ''}${name}`}`);
                return;
              } catch (err) {
                if (isRateLimit(err) && attempt === 0) {
                  const waitSec = Math.min(900, Math.max(60, err.retryAfter || 300));
                  out(chalk.yellow(`   ⏳ rate limited on ${name}, waiting ${waitSec}s`));
                  await sleep(waitSec * 1000);
                  continue;
                }
                result.errors.push(`${name}: ${err.message}`);
                out(chalk.yellow(`   ⚠️  ${name} failed: ${err.message}`));
                return;
              }
            }
          };

          await run('like', actions.like && !record.liked, async () => {
            if (options.dryRun) return { line: '[dry] would ❤️ like' };
            await scraper.likeTweet(tweet.id);
            record.liked = true; report.liked++;
            return { line: '❤️ liked' };
          });

          await run('repost', actions.repost && !record.reposted, async () => {
            if (options.dryRun) return { line: '[dry] would 🔁 repost' };
            await scraper.retweet(tweet.id);
            record.reposted = true; report.reposted++;
            return { line: '🔁 reposted' };
          });

          await run('comment', actions.comment && !record.commented, async () => {
            let text = '';
            let source = 'template';
            if (generator) {
              try {
                const gen = await generator.generate({
                  text: tweet.text,
                  author: tweet.username,
                  authorName: tweet.name,
                  quotedText: tweet.quotedStatus?.text,
                  hasMedia: Boolean(tweet.photos?.length || tweet.videos?.length),
                });
                text = gen.text; source = `ai${gen.attempts > 1 ? ', 2nd try' : ''}`;
              } catch (err) {
                if (templates.length === 0) throw err;
                out(chalk.yellow(`   🤖 model failed (${err.message}), using a template`));
              }
            }
            if (!text) {
              const picked = pickTemplate(templates, tweet, lastTemplate);
              lastTemplate = picked.index;
              text = picked.text;
            }
            if (!text) throw new Error('no comment text available');
            if (options.dryRun) return { text, line: `[dry] would 💬 reply (${source}): ${chalk.cyan(`"${text}"`)}` };
            await scraper.sendTweet(text, { replyTo: tweet.id });
            record.commented = true; report.commented++;
            return { text, line: `💬 replied (${source}): ${chalk.cyan(`"${text}"`)}` };
          });

          report.processed++;
          if (result.errors.length) report.failed++;
          report.results.push(result);
          if (!options.dryRun && useState) {
            state.done[tweet.id] = { ...record, at: new Date().toISOString() };
            await saveState(file, state);
          }

          if (i < selected.length - 1) {
            const wait = nextDelay(delay, jitter);
            if (!quiet && wait > 1500) {
              const s = ora({ text: chalk.gray(`next in ${Math.round(wait / 1000)}s`) }).start();
              await sleep(wait);
              s.stop();
            } else {
              await sleep(wait);
            }
          }
        }

        report.finishedAt = new Date().toISOString();
        out('');
        out(chalk.green(`✓ ${report.processed} posts: ❤️ ${report.liked} liked · 🔁 ${report.reposted} reposted · 💬 ${report.commented} replied · ⚠️  ${report.failed} with errors`));
        if (options.dryRun) out(chalk.yellow('  Dry run: nothing was posted. Drop --dry-run to do it for real.'));
        if (useState && !options.dryRun) out(chalk.gray(`  Progress saved to ${file}`));
        if (quiet) console.log(JSON.stringify(report, null, 2));
      } catch (error) {
        spinner.fail('Engage run failed');
        console.error(chalk.red(error.message));
        if (quiet) console.log(JSON.stringify({ ...report, error: error.message }, null, 2));
        process.exitCode = 1;
      }
    });
}

/** Provider defaults, exported so the docs check can list them. */
export const ENGAGE_DEFAULT_MODELS = DEFAULT_MODELS;
