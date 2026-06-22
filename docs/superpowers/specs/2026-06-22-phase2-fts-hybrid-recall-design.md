# Phase 2 — FTS5 full-text search + hybrid recall ranking

> Status: **approved design**, pre-implementation. Date: 2026-06-22.
> Scope agreed in brainstorming: **FTS5 + hybrid ranking only.** Deferred: normalized
> projects/sessions/tags tables, recall carryover preface, MCP resources, semantic/pgvector.

## 1. Context & problem

Recall is the whole point of the ledger (the future-instance loop), and today it's weak. The
v1 `query()` matches `text` with a single SQL `LIKE %text%` substring test over `title/body`,
and `SimpleRanker` is identity (pure recency). During the first live dogfood, recalling
`text: "hooks restart mcp"` returned **0 results** even though a clearly relevant entry existed
— because that phrase is not a contiguous substring of any entry. A future instance using a
natural-language query gets a false-empty and may wrongly conclude nothing was logged.

Phase 2 turns recall from "exact substring or nothing" into real, forgiving relevance ranking.

## 2. Goals / success criteria

- Multi-word, tokenized, stemmed search (FTS5) replacing substring `LIKE`.
- **Forgiving by default, strict on demand:** a multi-word query where no entry matches every
  word still returns the best-available entries (default); a strict mode returns only true
  matches (may be empty).
- The concrete regression that must pass: recalling `"hooks restart mcp"` returns the
  "Claude Code hooks hot-reload…" entry.
- Ranking logic is pure and unit-tested; the future `SemanticRanker` slots into the same seam.
- Existing recall behavior (recency, source/kind filters, limit clamp) stays green.

### Out of scope (deferred)
Normalized `projects`/`sessions`/`tags` tables, recall carryover preface, MCP resources,
Postgres + pgvector / semantic ranking.

## 3. Approach decision

**Use the existing `Ranker` seam** (chosen over all-in-SQL ranking). The repo runs FTS to fetch
*candidates* carrying their `bm25` text score; a pure `HybridRanker` blends signals in
TypeScript. Rationale: SQL stays simple, the scoring logic is unit-testable in isolation, and
the Phase 6 `SemanticRanker` drops into the same interface. (All-in-SQL was rejected: ranking
math buried in SQL, hard to test, no path for the semantic ranker.)

## 4. Design

### 4.1 FTS storage + sync
- New FTS5 virtual table, **external-content** keyed on `entries.rowid`:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, body,
    content='entries', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 1'
  );
  ```
  `porter` gives stemming ("running" matches "run"); `unicode61 remove_diacritics` is
  accent-insensitive.
- Keep in sync with triggers on `entries` (entries are effectively append-only, but include
  all three for safety):
  - AFTER INSERT → `INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body)`
  - AFTER DELETE → `INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body)`
  - AFTER UPDATE → delete-then-insert
- **Migration / backfill (idempotent):** create the table + triggers on open; if the FTS index
  is empty while `entries` is not, run `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`
  to repopulate from the content table. Existing rows (spine + lessons) become searchable
  immediately. Slots into the existing `migrateColumns()` pattern as a sibling step.

### 4.2 Query-term handling
Split the caller's `text` into whitespace tokens, **quote each token** (prevents FTS5 syntax
injection from punctuation), and join with **`OR`** so any term can match:
`"hooks restart mcp"` → `"hooks" OR "restart" OR "mcp"`. Empty/blank `text` → no FTS predicate.

### 4.3 Repo candidate-fetch, by mode
New method `search(q): Promise<Candidate[]>` where `Candidate = { entry: LedgerEntry; textScore: number | null }`.
Scope filters (`project`, `source`, `kinds`) apply in every mode.
- **`match`** (strict): only rows matching the FTS query.
  ```sql
  SELECT e.*, bm25(entries_fts) AS bm25 FROM entries_fts
  JOIN entries e ON e.rowid = entries_fts.rowid
  WHERE entries_fts MATCH ? AND <scope> ORDER BY bm25 LIMIT :pool
  ```
  May be empty. (Strict = "only entries that matched", OR-semantics — not AND.)
- **`hybrid`** (default): union of (FTS matches, with bm25) and (recent N, `textScore=null`),
  scope-filtered, de-duped, capped to a candidate **pool (~200)**. Guarantees a non-empty pool
  whenever any entries exist → "best-available, never false-empty."
- **`recency`**: unchanged — existing `query()` path (`id DESC`), `textScore=null`.

`query()` stays for the recency/no-text path; `search()` is the FTS-aware path the service uses
for `match`/`hybrid`.

### 4.4 `HybridRanker` (pure, injectable `now`)
Implements `Ranker`. Per candidate computes, all normalized to [0,1]:
- **text**: min-max normalize `-bm25` across the matched candidates (best match → 1, worst → 0);
  `0` for non-FTS candidates; if exactly one candidate matches (max == min), its text = 1.
  (Min-max avoids bm25 absolute-scale issues and is deterministic.)
- **recency**: `exp(-ageDays / HALF_LIFE_DAYS)` (default half-life 14d); `now` is injected for
  deterministic tests.
- **salience**: `salience / 3`.
- **tag**: `|queryTags ∩ entryTags| / |queryTags|` when `tags` provided, else `0`.

Blend (tunable consts):
- `hybrid`: `0.5*text + 0.25*recency + 0.15*salience + 0.10*tag`, desc.
- `match`: `text` only, drop non-matches, salience as tiebreak, desc.
- `recency`: `created_at`/`id` desc (identity over the recency candidates).

Returns the top `limit`. Optionally attaches a `matched[]` of which signals fired (cheap
explainability; nice-to-have).

### 4.5 Surface changes
- `domain/entry.ts`: `RankMode = "recency" | "match" | "hybrid"`; `LedgerQuery` gains
  `tags?: string[]` (filter/boost input).
- `LedgerRepository`: add `search(q): Promise<Candidate[]>` (+ `Candidate` type).
- `service/ledger-service.ts`: `recall` defaults `rank` to `"hybrid"`; routes `match`/`hybrid`
  through `repo.search()` + `HybridRanker`, `recency` through `repo.query()`; passes `tags`,
  keeps `clampLimit`, source default `self_report`.
- `mcp/tools.ts` + `server.ts`: `recall_reasoning` gains `rank` (enum `recency|match|hybrid`,
  default hybrid) and `tags` (string[]); existing params unchanged.
- `SimpleRanker` is **replaced by `HybridRanker`**, which handles all three modes (recency
  included). Remove `SimpleRanker`; the service injects `HybridRanker` everywhere.

## 5. Edge cases & decisions
- **Empty/blank `text`** → no FTS predicate. `hybrid` ranks the recent pool by recency +
  salience (text term contributes 0); `match` with no `text` **behaves like `recency`** (nothing
  to match strictly); `recency` is unaffected.
- **FTS special characters** in terms → quoting each token neutralizes them.
- **De-dup** in hybrid union (an FTS match that's also recent appears once, keeping its bm25).
- **Candidate pool cap (~200)** bounds in-app sort cost; the final `limit` is clamped 1..100.
- **bm25 sign**: SQLite `bm25()` is "lower = better"; we normalize `-bm25`.

## 6. Testing (TDD)
- **`HybridRanker` (pure):** ordering for each mode; min-max text normalization; recency decay
  with injected `now`; salience and tag-overlap contributions; weight blend; top-`limit` cut.
- **Repo FTS (`:memory:`):** multi-term OR match; **stemming** ("running" finds "run");
  scope isolation (project/source/kind); `match` can be empty while `hybrid` returns recent;
  migration **backfill** makes pre-existing rows searchable; FTS stays in sync on insert.
- **Service `recall`:** default `hybrid` returns best-available on a no-full-match query;
  `match` can be empty; `rank`/`tags` plumbed; recency path unchanged; limit clamped.
- **MCP `recall_reasoning`:** `rank`/`tags` plumbed; **regression: `"hooks restart mcp"`
  returns the hooks entry**.
- **Regression:** all existing Phase 1/3 recall tests stay green.

## 7. Migration / backward compatibility
- FTS table + triggers + backfill created idempotently on repo open (existing DBs upgrade in
  place; the live ledger's current entries become searchable). No `entries` column changes.
- `tags` already stored (JSON column) — tag-overlap reads it; no storage change.
- Recall's default changes from recency to hybrid; callers passing `rank: "recency"` keep old
  behavior.

## 8. Verification (done = )
- The dogfood query `"hooks restart mcp"` returns the hooks lesson.
- Stemmed/multi-term queries return relevant entries ranked sensibly.
- `npx vitest run` green (new + existing); `tsc --noEmit` + `npm run build` clean; `npm audit` 0.

## 9. Future (unblocked, not now)
`SemanticRanker` (Phase 6) implements the same `Ranker` interface and consumes the same
`Candidate` pool with an added embedding-similarity signal — no change to service/MCP. The
`tags`/`rank` surface added here is forward-compatible.
