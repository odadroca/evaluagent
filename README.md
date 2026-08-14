# evaluagent — Agent reasoning ledger

Capture the introspective texture of an LLM agent's reasoning — surprises, dead-ends,
confidence calls, abandoned branches, expensive reconstructions, friction — so a human can
analyze patterns over time **and a future agent instance can recall the relevant lessons**.

Design background lives in [`docs/REASONING-LEDGER-PLAN.md`](./docs/REASONING-LEDGER-PLAN.md)
and [`docs/REASONING-LEDGER-ARCHITECTURE.md`](./docs/REASONING-LEDGER-ARCHITECTURE.md).

## Status — Phases 1–2 + read/measure bundle

A working slice, end-to-end:

- **Record / recall over MCP**, backed by **SQLite**, hybrid-ranked (FTS5 full-text + recency + salience + tag overlap).
- **Recall-event logging**: every `recall_reasoning` call writes its effective query and the
  returned entry ids/ranks to a `recall_events` table (separate from `entries`, non-fatal on
  failure) — the join key for measuring whether recall changes later behavior.
- **Real session identity**: a `sessions` table keyed by `external_id` (the host session id). The
  `SessionStart` hook opens the row; the MCP server — which cannot see the host session — resolves
  the open session for its project and stamps that, so self-reports, recall events and the tool-call
  spine all share one id. A per-process `proc-<ulid>` proxy remains as the fallback when no session
  is open.
- **`projects` table** with unique slugs, backfilled on open from existing data.
- **Supersede links**: `record_reasoning` accepts `ref_entry_id` (validated to exist) pointing at
  the entry a new conclusion supersedes/corrects; recall marks the old entry `superseded_by`.
- TypeBox + Ajv validation of the six introspective entry kinds.
- **Claude Code hook bridge**: a `evaluagent-hook` binary turns hook events into an automatic
  behavioral spine (tool calls + lifecycle), stored alongside self-report entries. Tool args
  are **hashed, never stored raw**. `recall_reasoning` defaults to self-report so spine noise
  never drowns the lessons.
- **Pre/post correlation** (across separate hook processes, via the shared DB): each
  `PostToolUse` links to its `PreToolUse` (`ref_entry_id`) with a wall-clock `duration_ms`, and
  a repeated identical call is flagged `retry_of`.
- Swappable storage (`LedgerRepository`) and ranking (`Ranker`) seams, so Postgres + pgvector /
  semantic ranking drop in later without touching the service or gateways.

Not yet built (see the plan's phasing): the REST / OpenAI-function surface, the optional OTel mirror,
and the anti-self-reinforcement / staleness guards.

## Quickstart

```bash
npm install
npm test          # 173 tests
npm run build     # compiles to dist/
```

## Run as an MCP server (stdio)

```bash
node dist/bin/ledger.js serve
```

Register it with any MCP client (e.g. Claude Desktop / Claude Code):

```jsonc
{
  "mcpServers": {
    "evaluagent": {
      "command": "node",
      "args": ["/abs/path/to/evaluagent/dist/bin/ledger.js", "serve"],
      "env": {
        "EVALUAGENT_DB_PATH": "/abs/path/to/ledger.db",
        "EVALUAGENT_PROJECT": "my-project"
      }
    }
  }
}
```

| Env var | Default | Purpose |
|---|---|---|
| `EVALUAGENT_DB_PATH` (or `RLX_DB_PATH`) | `~/.evaluagent/ledger.db` | SQLite file (`:memory:` for ephemeral) |
| `EVALUAGENT_PROJECT` (or `RLX_PROJECT`) | current dir name | default project scope for entries |

### Registering in Claude Code

```bash
npm run build   # the config points at dist/
claude mcp add evaluagent --scope local -e EVALUAGENT_PROJECT=evaluagent -- \
  node /abs/path/to/evaluagent/dist/bin/ledger.js serve
```

> **Restart required.** Claude Code binds MCP servers at process **startup**. A server added
> with `claude mcp add` mid-session is **not** hot-loaded and will **not** appear in the
> in-session `/mcp` dialog — even after reconnecting there. Fully **restart Claude Code** to
> load it. Verify independently with `claude mcp get evaluagent` (should say `✔ Connected`).
> After changing server code, re-run `npm run build` before restarting.

## Capture the behavioral spine automatically (Claude Code)

Print a ready-to-merge hooks snippet and add it to `.claude/settings.json`:

```bash
node dist/bin/ledger.js hooks-install
```

It wires `SessionStart`, `PreToolUse`, `PostToolUse`, **`PostToolUseFailure`** (so failed tool
calls are captured, not just successes), `Stop`, and `SessionEnd` to `evaluagent-hook`, which
writes spine entries (source `hook_spine`) into the same ledger. The snippet uses **exec-form
`args`** so a binary path containing spaces is passed unsplit. The hook **always exits 0** so it
can never break the agent, and tool inputs are stored only as a hashed digest. Outside Claude
Code the bridge is simply absent and the ledger holds self-report entries only.

## Tools

- **`record_reasoning`** `{ kind, title, body, payload, project?, confidence?, salience?, tags?, session_id?, occurred_at?, ref_entry_id? }`
  — store one introspective entry. `kind` ∈ `surprise | dead_end | confidence | abandoned_branch | reconstruction | friction`; `payload` is validated per kind. Set `ref_entry_id` when the entry supersedes/corrects an earlier one (must reference an existing entry).
- **`recall_reasoning`** `{ project?, kinds?, text?, source?, rank?, tags?, limit? }` — relevant entries ranked by hybrid (FTS5 full-text + recency + salience + tag overlap; default, best-available), `match` (strict FTS, may be empty), or `recency` (newest first; `text`, if given, filters via the same tokenized FTS match, and the candidate pool keeps the newest matches). Defaults to `source: "self_report"` (the lessons); pass `"hook_spine"` to read the automatic spine. `tags` boosts by overlap. `limit` is clamped to 1..100.
  The response carries `scope: { project, projects_total }` (the effective project filter vs how many projects exist in the store) and, per entry, `project` and `superseded_by` (ids of later entries that reference it — treat a superseded entry as potentially stale). Every call is logged to `recall_events`.
- **`ledger_get`** `{ entry_id }` — one entry by id, **from any project**. Deliberately not scoped: an
  id is globally unique, and a caller usually holds one precisely because the entry lives somewhere
  recall cannot see. Returns the full entry plus `superseded_by`; errors on an unknown id rather than
  returning an empty success.
- **`list_projects`** `{}` — every project with `entries` and `last_written`, busiest first. The
  browse face for `scope.projects_total`, which otherwise only tells you how much you cannot see.
- **`ledger_query`** `{ project?, kinds?, source?, since?, until?, limit? }` — filtered, non-ranked
  read for **analysis** (counts, time ranges, kind mixes); omit `project` to span all. Use
  `recall_reasoning` for the most relevant lessons, this for a defined slice. **Not logged to
  `recall_events`**, so analysis traffic cannot distort the measurement of whether recall changes
  behaviour.
- **`session_timeline`** `{ session_id, limit? }` — one session's self-reports and spine interleaved,
  oldest first. Entries written before 2026-08-14 predate the `sessions` table, so a timeline over
  that era shows one source only.
- **`rename_project`** `{ from, to, merge? }` — rename everywhere, or merge into an existing project.
  Merging is destructive and requires `merge: true`; moved entries are stamped `was:<old-slug>`.

## Layout

```
src/
  domain/    entry kinds (TypeBox schemas) + entry/query types
  repo/      LedgerRepository + Ranker seams; sqlite/ implementation
  service/   LedgerService (validation, defaulting) + HybridRanker
  mcp/       MCP server + tool definitions
  bin/       ledger.ts  (the `serve` CLI)
```

Built in TypeScript with TypeBox + Ajv, `better-sqlite3`, and the official MCP SDK — adopting
the conventions of the sibling [Calane / `@llm-pipe/core`](https://github.com/odadroca/Calane)
kernel (it will be imported directly for the telemetry/redaction reuse in a later phase).
