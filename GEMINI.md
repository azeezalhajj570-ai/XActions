# XActions — instructions for Gemini

**Read [AGENTS.md](AGENTS.md).** It is the single source of truth for how to work in this
repository, and it is kept current.

This file used to be a near-copy of AGENTS.md and CLAUDE.md. The three drifted, as copies
do: they simultaneously claimed 26, 31, 32 and 49 agent skills, and a coding agent that
read the wrong one wasted a session on a stale map of the repository. There is now one
document, and these are pointers to it.

AGENTS.md covers, in order:

- **Which lane to use** — shell out to the `xactions` CLI, or load the MCP server. Getting
  this wrong costs you the whole context window, so it is answered first.
- **The CLI lane** — commands, `--compact`, `--json`, and what each returns.
- **The MCP lane** — 151 tools, tool groups, and the draft-approval gate.
- **Straight to the file** — a table from common request to the exact file that answers it.
- **Skills** — 49 of them, and how to install them.
- **Where things live** — the directory map and the three runtime contexts.
- **Things that will bite you** — the mistakes that have actually cost people time here.

## Gemini specifics

The CLI lane is usually the right one here: one shell call, no tool list to load.

```bash
npx xactions profile nasa --compact     # no account, no browser
npx xactions tweets nasa --limit 50 --json
```

The skills are plain Markdown and readable directly from [`skills/`](skills/); the
installer writes them into a specific host's directory, and its targets today are
`claude`, `project`, `cursor`, `codex` and `windsurf`:

```bash
xactions skills list                          # every skill and what it covers
xactions skills show follower-monitoring      # read one without installing it
xactions skills install --all --target project  # ./.claude/skills/ in this repo
```

Everything else is in [AGENTS.md](AGENTS.md).
