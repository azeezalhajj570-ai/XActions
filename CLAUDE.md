# XActions — instructions for Claude

**Read [AGENTS.md](AGENTS.md).** It is the single source of truth for how to work in this
repository, and it is kept current.

This file used to be a near-copy of AGENTS.md and GEMINI.md. The three drifted, as copies
do: they simultaneously claimed 26, 31, 32 and 49 agent skills, and a coding agent that
read the wrong one wasted a session on a stale map of the repository. There is now one
document, and these are pointers to it.

AGENTS.md covers, in order:

- **Which lane to use** — shell out to the `xactions` CLI, or load the MCP server. Getting
  this wrong costs you the whole context window, so it is answered first.
- **The CLI lane** — commands, `--compact`, `--json`, and what each returns.
- **The MCP lane** — 151 tools, tool groups, and the draft-approval gate.
- **Straight to the file** — a table from common request to the exact file that answers it.
- **Skills** — 49 of them, and how to install them into Claude Code.
- **Where things live** — the directory map and the three runtime contexts.
- **Things that will bite you** — the mistakes that have actually cost people time here.

## Claude Code specifics

Install the skills into this machine so they are available in every session:

```bash
xactions skills install --all --global   # writes ~/.claude/skills/<id>/
xactions skills list                     # what is installed, and from where
```

Add the MCP server to Claude Code:

```bash
claude mcp add xactions -- npx -y xactions-mcp
```

Hold every write for human approval before you let an agent near a real account:

```bash
XACTIONS_MCP_REQUIRE_APPROVAL=1 npx xactions-mcp
```

Everything else is in [AGENTS.md](AGENTS.md).
