# evaluagent — working notes

> Durable lessons promoted from the reasoning ledger (consolidation pass). Loaded into every
> Claude Code session in this repo, so they don't depend on an on-demand `recall`.

## Claude Code setup: hot-reload vs restart

- **Hooks / `.claude/settings*.json` hot-reload mid-session** — *but only if* a settings file
  already existed under `.claude/` when the session started (Claude Code begins watching
  `.claude/` then). Editing hooks usually needs **no** restart.
- **MCP servers do NOT hot-load.** A `claude mcp add` (any scope) is picked up only by a fresh
  process — restart with **`claude -c`** to keep the conversation. `/mcp` and re-adding won't
  expose a newly-added server to the running session.
- Rule of thumb: after adding/changing the **MCP server**, restart; after editing **hooks**,
  usually don't.

## This repo's MCP server / hooks

- Server: `node <repo>/dist/bin/ledger.js serve`. Always `npm run build` before relying on it
  (config points at `dist/`, not `src/`).
- Hook bridge: `node <repo>/dist/bin/ledger-hook.js`, wired via `.claude/settings.local.json`;
  needs `EVALUAGENT_PROJECT` to match the MCP scope or it defaults to the cwd basename and
  splits entries across project tags.
- Conventions: TDD (`npx vitest run`), TypeBox + Ajv (no Zod), ESM `.js` import specifiers.
