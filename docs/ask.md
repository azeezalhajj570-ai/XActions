# Ask XActions

> Ask how to do anything with XActions in plain language and get a sourced answer. Live at [xactions.app/ask](https://xactions.app/ask). Free, no account, no API key.

Ask XActions is a conversational assistant for the toolkit. It searches the documentation, the 49 agent skills, the browser scripts, the marketing pages, and the GitHub repository, then streams an answer that cites its sources with clickable `[1]` `[2]` markers. Ask "how do I unfollow all users" and it tells you the exact script, where to paste it, and what safety features it has, with links to the pages it read.

## Using it

Open [xactions.app/ask](https://xactions.app/ask), type a question, press Enter. Or deep-link a question:

```
https://xactions.app/ask?q=how+do+i+unfollow+everyone
```

- **History** (top right) lists past conversations. They live in your browser's `localStorage`; nothing is stored on the server, which is what the **Private** badge means.
- **Auto / model picker** (in the composer) chooses who answers. `Auto` walks the free lanes below. Pick a provider and paste your own key to make it answer first; the key stays in your browser and is sent only with your question.
- Every answer has **Copy** and **Retry**, code blocks have a copy button, and source chips open the doc, script page, or GitHub file that backed the answer.
- Keyboard: `Enter` sends, `Shift+Enter` adds a line, `/` focuses the box, `Esc` stops a streaming answer, `Ctrl/Cmd+Shift+O` starts a new conversation.

## How it works

```
question ──► BM25 search over dashboard/data/ask-index.json  ─┐
         └─► GitHub search (issues, PRs; code with a token) ──┴─► numbered sources
                                                                        │
                       system prompt + sources + question ──► free LLM chain ──► streamed answer
```

1. **Index.** `npm run ask:index` (`scripts/build-ask-index.mjs`) chunks `docs/**/*.md`, `skills/*/SKILL.md`, `tutorials/**/*.md`, the top-level README/CHANGELOG, the header comments of every browser script in `src/` and `scripts/`, and the text of the dashboard pages (FAQ, pricing, features, ...). Each chunk carries the live URL it came from: the rendered docs page when one exists (via `dashboard/docs/_pages-manifest.json`), the `/scripts/<slug>` page for a script, or the GitHub blob URL. The result is `dashboard/data/ask-index.json`, served at `/data/ask-index.json`. `npm run docs:check` fails when the committed index is stale.
2. **Retrieval.** `src/ask/engine.js` builds a BM25 searcher over the chunks at startup (about 20 ms per query), with a small synonym map bridging how people ask ("all", "twitter", "retweet") to how the docs are written ("everyone", "X", "repost"). Titles are boosted, results are capped per document, and a live GitHub issues/PR search is merged in so recent bug reports show up too.
3. **Answer.** The sources and the question go to the first lane that accepts the request in `src/ask/lanes.js`; the reply streams back as Server-Sent Events.

## Free LLM lanes

Every lane is an OpenAI-compatible chat endpoint reached with `fetch`, so the same file runs in Node, in the Cloudflare Worker, and in the browser. Lanes are tried in order; a `402`, `429`, `5xx`, or network error moves on to the next one.

| Order | Lane | Needs | Model |
|---|---|---|---|
| 1 | Your key (BYOK, from the model picker) | user-supplied | provider default |
| 2 | Groq | `GROQ_API_KEY` | llama-3.3-70b-versatile |
| 3 | Cerebras | `CEREBRAS_API_KEY` | llama-3.3-70b |
| 4 | OpenRouter free tier | `OPENROUTER_API_KEY` | first live `:free` model (read from `/models`, never hardcoded) |
| 5 | xAI | `XAI_API_KEY` | grok-4.1-fast |
| 6 | Google AI Studio | `GEMINI_API_KEY` | gemini-2.5-flash-lite |
| 7 | Mistral | `MISTRAL_API_KEY` | mistral-small-latest |
| 8 | Cloudflare Workers AI | `CLOUDFLARE_AI_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | llama-3.3-70b-instruct-fp8-fast |
| 9 | LLM7 | nothing | gemini-3.1-flash-lite |
| 10 | Pollinations | nothing | openai-fast |
| 11 | OVH AI Endpoints (anonymous) | nothing | Meta-Llama-3.3-70B |

Lanes 9 to 11 need no key, so a deployment with an empty environment still answers. Add any of the keyed free tiers to get a stronger model and a separate quota pool. `GITHUB_TOKEN` is optional and only raises the GitHub search rate limit and enables code search.

## API

### `POST /api/ask`

```json
{
  "question": "how do I unfollow everyone?",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "byok": { "provider": "groq", "apiKey": "gsk_..." }
}
```

`history` (optional) is the prior turns of the conversation, last six are used. `byok` (optional) makes that provider lead the chain; providers: `groq`, `openrouter`, `xai`, `openai`, `gemini`, `mistral`, `cerebras`.

The response is `text/event-stream`. Each `data:` line is one JSON event:

```
data: {"type":"sources","sources":[{"n":1,"title":"Unfollow Everyone","url":"https://...","kind":"doc","path":"docs/examples/unfollow-everyone.md"}]}
data: {"type":"lane","lane":"llm7"}
data: {"type":"delta","text":"To unfollow everyone"}
data: {"type":"delta","text":" on X, paste"}
data: {"type":"done","lane":"llm7","model":"gemini-3.1-flash-lite","partial":false,"sources":[...]}
```

An `error` event carries `message` when every lane failed. From a terminal:

```bash
curl -N https://xactions.app/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"how do I unfollow everyone?"}'
```

### `GET /api/ask/health`

Index size and digest, the lanes configured on this deployment, and the suggested questions.

## Where it runs

- **Cloudflare Worker** (`worker/index.js`): `/api/ask` is answered at the edge. The index is read from the static assets bundle and the lanes are called with `fetch`, so no origin server is needed.
- **Express** (`api/routes/ask.js`): mounted at `/api/ask` in both `api/server.js` and the Vercel `api/serverless.js`.
- **Browser fallback** (`dashboard/js/ask.js`): if `POST /api/ask` does not answer with an event stream (for example a static-only deploy, which is what xactions.app serves until the Worker is deployed), the page downloads `/data/ask-index.json` (about 650 KB gzipped, fetched only on this path and then cached), runs the same engine from `/js/ask/engine.js`, and calls the keyless lanes directly. A toast says so and the answer is labelled "in-browser".

## Development

```bash
npm run ask:index          # rebuild dashboard/data/ask-index.json and mirror src/ask/ into dashboard/js/ask/
npm run ask:index:check    # exit 1 if the committed index or the browser mirror is stale (part of npm run docs:check)
npx vitest run tests/ask   # retrieval on the real index, chain construction, one live keyless completion
```

Rebuild the index whenever you change docs, skills, tutorials, a script header, or a dashboard page. Related: [MCP setup](mcp-setup.md), [Browser scripts](browser-scripts.md), [REST API](rest-api.md).
