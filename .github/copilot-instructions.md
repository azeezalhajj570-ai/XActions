# XActions — instructions for Copilot

**Read [AGENTS.md](../AGENTS.md).** It is the single source of truth for how to work in
this repository, and it is kept current.

This file used to be a near-copy of AGENTS.md, CLAUDE.md and GEMINI.md. The four drifted,
as copies do: they simultaneously claimed 26, 31, 32 and 49 agent skills, and an agent
that read the wrong one worked from a stale map of the repository. There is now one
document, and these are pointers to it.

The things worth knowing before you suggest a change here:

- **Three runtime contexts, and code correct in one is broken in another.** Browser
  console scripts have no Node APIs. The library, CLI and MCP server are Node >= 18 ESM.
  The API server is Express with Prisma and Redis. AGENTS.md has the table.
- **X's DOM changes constantly.** Prefer `data-testid` selectors; the current set is in
  [`docs/agents/selectors.md`](../docs/agents/selectors.md).
- **Never remove the delays between actions.** Every automation path paces itself on
  purpose. Removing that is how a user's account gets suspended.
- **An empty result is an error, not a zero.** Read paths throw rather than reporting
  "0 results", because a silent zero looks exactly like an account with nothing on it.
- **One licence: Apache-2.0.** `npm run check:licenses` enforces it.
- **Tests are `npm test` (Vitest).** New behaviour needs a test; the suite runs offline.

Everything else is in [AGENTS.md](../AGENTS.md).
