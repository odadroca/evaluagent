# evaluagent — Agent reasoning ledger

Capture the introspective texture of an LLM agent's reasoning — surprises, dead-ends,
confidence calls, abandoned branches, expensive reconstructions, friction — so a human can
analyze patterns over time **and a future agent instance can recall the relevant lessons**.

Design background lives in [`docs/REASONING-LEDGER-PLAN.md`](./docs/REASONING-LEDGER-PLAN.md)
and [`docs/REASONING-LEDGER-ARCHITECTURE.md`](./docs/REASONING-LEDGER-ARCHITECTURE.md).

## Status — Phases 1 + 3

A working slice, end-to-end:

- **Record / recall over MCP**, backed by **SQLite**, recency-ranked.
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

Not yet built (see the plan's phasing): tags + FTS + hybrid ranking, the REST / OpenAI-function
surface, the optional OTel mirror, and the anti-self-reinforcement / staleness guards.

## Quickstart

```bash
npm install
npm test          # 33 tests
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

## Capture the behavioral spine automatically (Claude Code)

Print a ready-to-merge hooks snippet and add it to `.claude/settings.json`:

```bash
node dist/bin/ledger.js hooks-install
```

It wires `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd` to
`evaluagent-hook`, which writes spine entries (source `hook_spine`) into the same ledger. The
hook **always exits 0** so it can never break the agent, and tool inputs are stored only as a
hashed digest. Outside Claude Code the bridge is simply absent and the ledger holds self-report
entries only.

## Tools

- **`record_reasoning`** `{ kind, title, body, payload, project?, confidence?, salience?, tags?, session_id?, occurred_at? }`
  — store one introspective entry. `kind` ∈ `surprise | dead_end | confidence | abandoned_branch | reconstruction | friction`; `payload` is validated per kind.
- **`recall_reasoning`** `{ project?, kinds?, text?, limit? }` — recency-ranked relevant entries (the next-instance loop).

## Layout

```
src/
  domain/    entry kinds (TypeBox schemas) + entry/query types
  repo/      LedgerRepository + Ranker seams; sqlite/ implementation
  service/   LedgerService (validation, defaulting) + SimpleRanker
  mcp/       MCP server + tool definitions
  bin/       ledger.ts  (the `serve` CLI)
```

Built in TypeScript with TypeBox + Ajv, `better-sqlite3`, and the official MCP SDK — adopting
the conventions of the sibling [Calane / `@llm-pipe/core`](https://github.com/odadroca/Calane)
kernel (it will be imported directly for the telemetry/redaction reuse in a later phase).
