# Reasoning Ledger — Architecture

> Companion to [`REASONING-LEDGER-PLAN.md`](./REASONING-LEDGER-PLAN.md). Describes the
> technical design of the reasoning ledger as a **sibling package on the Calane
> (`@llm-pipe/core`) kernel**. Spec stage — no code yet.

## 1. Shape: a sibling on `@llm-pipe/core`

The ledger is a **separate package that imports Calane's core** as a library. Calane stays a
pure execution kernel (its binding non-goals untouched); the ambient-capture/memory identity —
including the Claude Code hook bridge — lives entirely in the sibling.

```
Callers
  ( MCP client | OpenAI tool caller | REST client | Claude Code hooks )
        │
        ▼
  reasoning-ledger gateways      (thin; mirror Calane's compact-surface pattern)
        │  every gateway calls only ↓
        ▼
  LedgerService                  (the one core: business logic, validation, guards)
        ├─► LedgerRepository  (interface) ─ SqliteRepository (v1) | PostgresRepository (later)
        ├─► Ranker            (interface) ─ SimpleRanker (v1)      | SemanticRanker (later)
        └─► TelemetrySink     (OPTIONAL mirror; OTel sink, service.name = reasoning-ledger)

  imports from @llm-pipe/core:
    ResultStore pattern · TelemetrySinkInterface · TypeBox + Ajv · redactSecrets ·
    bundle/signing/federation patterns · MCP/REST/openai compact-surface scaffolding
```

A single core operation is reachable as an MCP tool, an MCP resource, an OpenAI/REST route,
and a hook-bridge write — one validation definition, one implementation, no logic duplication.

## 2. Two-plane discipline (binding contract)

The central risk is conflating two planes with different lifecycles and consumers:

| | **Observability plane** | **Ledger / memory plane** |
|---|---|---|
| Data | spans / events | introspective entries |
| Flow | `TelemetrySink` → OTLP → Langfuse/Datadog | `record` → store → `recall` |
| Truth | append-only, vendor-side, **no-op by default** | **authoritative, never lossy** |
| Lifecycle | retention-bounded | persistent |
| Consumer | humans debugging | the next agent instance |

**Invariants:**
1. **Store-first.** Persistence is mandatory; the observability layer is an *optional mirror*,
   never the source of truth. (Telemetry is no-op by default — introspection riding only
   telemetry would silently vanish when no backend is connected.)
2. **Redact at the mirror boundary.** Anything crossing into a vendor goes through the same
   redaction posture as Calane's `redactSecrets`.
3. **Align mirrored events to OTel GenAI semconv** so Langfuse/Datadog render reasoning, not
   opaque blobs.
4. **Distinct sources in Claude Code.** Claude Code's native OTel and the ledger are separate
   `service.name`s — never double-counted.

This is *why* Option 3 (sibling) was chosen: the ledger emits its own spans under its own
`service.name`, so observability backends see two clearly-separated services instead of
polluted Calane traces; and per-integration you can choose whether the ledger **writes to** or
**reads from** each backend.

## 3. Data model (SQLite; maps to Postgres `jsonb` + pgvector later)

One unified **`entries`** envelope holds every kind (6 introspective + 2 spine). Kind-specific
fields live in a TypeBox/Ajv-validated JSON `payload` column (→ `jsonb` later). Retrieval-facing
fields are real columns so they can be indexed.

### Scope/identity
- `projects(id, slug UNIQUE, label, created_at)`
- `sessions(id, project_id, external_id, agent, task, started_at, ended_at)` — `external_id`
  is the host/Claude Code `session_id`, the **join key** that lands hook-spine and self-report
  in the same session.

### Envelope
- `entries(id ulid, project_id, session_id, source['self_report'|'hook_spine'], kind,
  created_at, occurred_at, title, body, confidence REAL, salience INT, payload JSON,
  tool_name, ref_entry_id, outcome, embedding BLOB /* NULL in v1 */)`
- `tags(id, name UNIQUE)` + `entry_tags(entry_id, tag_id)` — primary v1 relevance lever
- `entries_fts` (FTS5 over `title, body`) — v1 text match (→ tsvector/GIN, then pgvector)

Stores the canonical entry JSON verbatim + denormalized projections for indexed querying —
the exact pattern Calane's SQLite store already proves.

### EntryKind (8) and payload shapes
`surprise`, `dead_end`, `confidence`, `abandoned_branch`, `reconstruction`, `friction`, plus
spine `spine_tool`, `spine_lifecycle`.

1. **surprise** `{ expected, actual, magnitude 1|2|3, trigger? }`
2. **dead_end** `{ approach, reason, signal, recoverable }`
3. **confidence** `{ decision, options_considered?, chosen }` (+ `confidence` column 0..1)
4. **abandoned_branch** `{ branch, progress_pct?, why_abandoned, could_revisit }`
5. **reconstruction** `{ what_was_lost, cost 1|2|3, how_recovered }` (+ `ref_entry_id`
   back-link to the earlier entry that, had it been read, would have avoided the cost)
6. **friction** `{ where, kind, intensity 1|2|3 }`

Spine payloads: `spine_tool { phase, tool, args_digest (hashed), duration_ms, ok, error,
retry_of, files }`; `spine_lifecycle { event, reason?, cwd? }`.

### Anti-self-reinforcement / staleness (first-class)
Every entry carries `confidence` + an `outcome`/verification status + `created_at`. **Recall
decays old entries and re-tests** — it never lets a lesson assert "X always fails" permanently;
a surfaced lesson always shows its age and confidence so the consuming instance can discount it.

## 4. Reuse map — what is borrowed vs genuinely new

**Reused from Calane (do not rebuild):**
- SQLite store pattern (canonical JSON + denormalized projections) — `ResultStoreInterface`.
- `TelemetrySinkInterface` + the OTel sink (the optional mirror).
- TypeBox + Ajv schema validation (project rule: no Zod).
- `redactSecrets` (redaction at the mirror boundary).
- Bundle/signing/federation patterns (export, cross-instance sharing).
- The compact MCP/REST/`openai.json` surface pattern (≤30 tools, coarse-grained).
- The "pattern, not feature" ethos.

**Genuinely new (the whitespace):**
1. The introspective **entry schema** as a first-class artifact.
2. **Ambient capture** — `record_reasoning` tool **+ the Claude Code hook bridge** (push).
   *Biggest real gap; Calane is pull-only.*
3. **`recall_reasoning`** — relevance retrieval (tag/text/recency now, semantic later).
4. **Anti-self-reinforcement + staleness** guards.
5. Optional **reflection pipeline** (Calane-native): an ordinary `@llm-pipe` pipeline whose
   input is a session transcript / run JSON and whose schema-validated output is structured
   introspection — versioned, hash-traceable, bundle-exportable for free.

## 5. Storage abstraction (the swap seam)

```ts
interface LedgerRepository {            // async, so a Postgres impl is a pure drop-in
  ensureProject(slug, label?)
  startSession(input) / endSession(id, endedAt)
  insertEntry(entry) / insertEntries(entries[])
  attachTags(entryId, tags[])
  getEntry(id) / getSessionTimeline(sessionId)
  query(q: LedgerQuery): QueryResult   // repo scope-filters → candidates; Ranker scores+orders
}

interface Ranker {                      // the semantic drop-in seam
  rank(q: LedgerQuery, candidates: Entry[]): RankedEntry[]
}
```
`LedgerQuery` carries `rank: "recency" | "match" | "hybrid"` (with room for `"semantic"`), so
adding embeddings later is a constructor swap, not an interface change.

## 6. Capture & recall paths

**Self-report (everywhere):**
- `record_reasoning` — unified write, discriminated by `kind`. Store-first; optional OTLP
  mirror as a GenAI-semconv span event.
- `session_start` / `session_end`.

**Hook bridge (Claude Code only) — the push path Calane lacks:**
- `rlx-hook` reads the hook JSON on stdin → spine entries via `LedgerService`, **always exits
  0** (never blocks the agent; errors logged to file).
- `SessionStart` → session row + lifecycle; `PreToolUse` → `spine_tool phase=pre` (hashed args
  digest); `PostToolUse` → `phase=post` (duration via matching the open `pre` row, `ok`/error,
  files, retry link); `Stop` / `SessionEnd` → lifecycle. Pre/post correlation uses the DB
  itself (stateless hook).
- `hooks install` **prints** the `.claude/settings.json` snippet (never writes it).
- Purely additive: outside Claude Code the ledger simply contains only self-report entries.

**Recall (read) — the next-instance loop:**
- `recall_reasoning { task, project?, limit }` → ranked lessons + a short synthesized
  *carryover preface*, with decay/staleness applied.
- `ledger_query` (general), `ledger_get`, `session_timeline` (interleaved spine + self-report).

## 7. Tool surface (coarse-grained, Calane-style)

Keep it small (Calane caps ~8, asserts ≤30). The same operations back MCP, REST, and
`openai-tools.json` (derived from the TypeBox schemas — one source of truth):

| Tool | Purpose |
|---|---|
| `record_reasoning` | unified self-report write (discriminated by `kind`) |
| `recall_reasoning` | task-relevant lessons + carryover preface (the consumption loop) |
| `session_start` / `session_end` | session lifecycle + `external_id` join |
| `ledger_query` | general filtered/ranked query |
| `ledger_get` | full entry by id |
| `session_timeline` | one session's interleaved entries |

MCP resources (browse face): `ledger://projects`, `ledger://project/{slug}/recent`,
`ledger://session/{id}/timeline`, `ledger://entry/{id}`, `session://current`.

## 8. Future package layout (informational)

```
src/
  domain/        entry-kinds.ts (TypeBox), envelope.ts, query.ts
  repo/          ledger-repository.ts, ranker.ts, sqlite/{schema.sql,sqlite-repository.ts}
  service/       ledger-service.ts, simple-ranker.ts
  mcp/           server.ts, tools.ts, resources.ts
  http/          server.ts, routes.ts, openai-tools.ts
  hooks/         cli.ts, map-event.ts, install.ts
  telemetry/     otel-sink.ts (optional mirror)
```
