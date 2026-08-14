# evaluagent — working notes (Codex)

> Durable lessons promoted from the reasoning ledger. Loaded into every Codex session in this
> repo, so they don't depend on an on-demand `recall`.
>
> Codex counterpart of `CLAUDE.md`. The two harnesses differ in more than naming — read this
> file, not that one. Claims here trace to `.codex/config.toml`, `src/hooks/install.ts`, and
> `package.json`; do not copy statements across from the Claude Code notes.

## Codex setup in this repo

- **Configuration lives in `.codex/config.toml`.** It registers the MCP server as
  `node C:/GITHUB/Evaluagent/dist/bin/ledger.js serve` under `[mcp_servers.evaluagent]`, and sets
  `EVALUAGENT_PROJECT = "evaluagent"` in both `[shell_environment_policy.set]` and
  `[mcp_servers.evaluagent.env]`.
- **That path is absolute**, so the file is machine-specific — it works on this checkout and
  nowhere else without editing. It is also currently untracked.
- **Always `npm run build` before relying on the server** — the config points at `dist/`, not
  `src/`. Editing `src/` alone changes nothing the running server sees.

## There is no hook bridge under Codex

The behavioral spine is **Claude Code only**. `buildHooksSnippet` (`src/hooks/install.ts`) emits a
`.claude/settings.json` snippet wiring `SessionStart` / `PreToolUse` / `PostToolUse` /
`PostToolUseFailure` / `Stop` / `SessionEnd`; `src/` contains no Codex references at all.

Since 2026-08-13 those hooks are wired at Claude Code's **user scope**, so the spine captures across
all that harness's projects — and none of Codex's. The asymmetry is now wider, not narrower.

Consequence for a Codex session: **your tool calls are not being captured.** The ledger will hold
only what you write deliberately via `record_reasoning` (`source: self_report`) — no `hook_spine`
rows, no pre/post correlation, no `duration_ms`. Anything you want a future instance to know must
be recorded explicitly.

## `EVALUAGENT_PROJECT` must match the MCP scope

If it doesn't, entries default to the **cwd basename** and split across project tags — the same
lesson lands under two names and recall from one never sees the other.

This is not hypothetical. The live ledger holds both `SAP-move` and `.SAP-move` as distinct
projects, recalled seconds apart within a single session; the query against one of them returned
zero results while the sibling held entries. Check the scope before trusting an empty recall.

## Recall scope

`recall_reasoning` defaults its project filter to the configured project, and defaults `source` to
`self_report`. The response carries `scope: { project, projects_total }` — if `projects_total` is
large and you are surveying across projects, the default scope is hiding almost everything. For
cross-project or aggregate questions, read the SQLite store directly
(`~/.evaluagent/ledger.db`, tables `entries` and `recall_events`) rather than trusting the scoped
tool output.

## Conventions

- TDD: `npx vitest run` (173 tests).
- TypeBox + Ajv for validation — **no Zod**.
- ESM with `.js` import specifiers.
- `npm run typecheck` currently reports 9 pre-existing errors, all inside `*.test.ts`;
  `tsconfig.build.json` excludes tests, so `npm run build` is clean. Don't treat those 9 as
  regressions you introduced.

## TODO

- Codex's reload semantics for `.codex/config.toml` (whether an MCP change needs a fresh session)
  are **not verified** from this repo. Do not assume the Claude Code rule transfers. Verify before
  writing it down here.
