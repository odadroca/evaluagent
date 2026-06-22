# Phase 2 — FTS5 + Hybrid Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace substring `LIKE` recall with FTS5 full-text search + a hybrid relevance ranker, so multi-word/natural-language recall returns the best-available entries instead of false-empties.

**Architecture:** Keep the existing `Ranker` seam. `SqliteRepository` gains an FTS5 external-content index and a `search()` that returns scored `Candidate`s (raw bm25); a pure `HybridRanker` blends text + recency + salience + tag overlap and replaces `SimpleRanker`. `LedgerService.recall` routes `recency` through `query()` and `match`/`hybrid` through `search()`, defaulting to `hybrid`. MCP `recall_reasoning` exposes `rank` and `tags`.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3 (FTS5), TypeBox+Ajv (unchanged), vitest 3, MCP SDK. Full spec: `docs/superpowers/specs/2026-06-22-phase2-fts-hybrid-recall-design.md`.

## Global Constraints

- **No Zod** — schemas are TypeBox + Ajv (project rule).
- **TDD** — every change is test-first; tests colocated as `src/**/*.test.ts`; run with `npx vitest run <file>`.
- **ESM import specifiers end in `.js`** (NodeNext), even for `.ts` sources.
- **Node engine:** `^20.19.0 || >=22.12.0` (already set; do not regress).
- `npm run build` (tsc) and `npx tsc --noEmit` must stay clean; `npm audit` must stay at 0.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on branch `feat/phase2-fts-hybrid-recall` (already created).

## File Structure

- **Modify** `src/domain/entry.ts` — extend `RankMode`; add `tags?` to `LedgerQuery`; add `Candidate`.
- **Modify** `src/repo/ranker.ts` — `Ranker.rank` consumes `Candidate[]`.
- **Create** `src/service/hybrid-ranker.ts` — `HybridRanker` (all 3 modes, injectable clock).
- **Delete** `src/service/simple-ranker.ts` — replaced by `HybridRanker`.
- **Modify** `src/repo/ledger-repository.ts` — add `search(q): Promise<Candidate[]>` to the interface.
- **Modify** `src/repo/sqlite/sqlite-repository.ts` — FTS5 table+triggers+backfill; `search()`; term builder.
- **Modify** `src/service/ledger-service.ts` — use `HybridRanker`; route recall; default `hybrid`; pass `tags`.
- **Modify** `src/mcp/tools.ts` + `src/mcp/server.ts` — `recall_reasoning` gains `rank` + `tags`.
- **Modify** `src/index.ts` — export `hybrid-ranker`; drop `simple-ranker` export.
- **Tests:** `src/service/hybrid-ranker.test.ts` (new); extend `src/repo/sqlite/sqlite-repository.test.ts`, `src/service/ledger-service.test.ts`, `src/mcp/server.test.ts`.

---

### Task 1: Candidate type, RankMode/tags, and HybridRanker (replaces SimpleRanker)

A pure, DB-free ranker. After this task `SimpleRanker` is gone and `HybridRanker` is the service's ranker, but recall still defaults to `recency` (behavior unchanged until Task 4).

**Files:**
- Modify: `src/domain/entry.ts`
- Modify: `src/repo/ranker.ts`
- Create: `src/service/hybrid-ranker.ts`
- Test: `src/service/hybrid-ranker.test.ts`
- Delete: `src/service/simple-ranker.ts`
- Modify: `src/service/ledger-service.ts` (swap ranker + wrap query results)
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `Candidate = { entry: LedgerEntry; textScore: number | null }` (textScore = raw bm25, lower=better, null for non-FTS); `RankMode = "recency" | "match" | "hybrid"`; `LedgerQuery.tags?: string[]`; `Ranker.rank(q: LedgerQuery, candidates: Candidate[]): LedgerEntry[]`; `class HybridRanker implements Ranker` with constructor `(now: () => number = () => Date.now())`.
- Consumes: existing `LedgerEntry`, `clampLimit`, `RECALL_MAX_LIMIT`.

- [ ] **Step 1: Extend domain types**

In `src/domain/entry.ts`, change `RankMode` and add `tags` + `Candidate`:

```ts
/** v1 ranking modes. */
export type RankMode = "recency" | "match" | "hybrid";

export interface LedgerQuery {
  project: string;
  kinds?: AnyKind[];
  /** Free-text match (FTS5 in v2). */
  text?: string;
  /** Restrict to self-report vs hook-spine entries. */
  source?: EntrySource;
  /** Tag filter/boost input (lowercased overlap with entry tags). */
  tags?: string[];
  limit?: number;
  rank?: RankMode;
}

/** A retrieval candidate: the entry plus its raw FTS bm25 (lower=better; null if not an FTS hit). */
export interface Candidate {
  entry: LedgerEntry;
  textScore: number | null;
}
```

- [ ] **Step 2: Update the Ranker interface**

Replace `src/repo/ranker.ts` body:

```ts
import type { Candidate, LedgerEntry, LedgerQuery } from "../domain/entry.js";

/**
 * Scoring/ordering seam. The repository scope-filters into a Candidate set; the
 * Ranker orders it. HybridRanker handles recency/match/hybrid; SemanticRanker
 * (Phase 6) drops into the same interface.
 */
export interface Ranker {
  rank(q: LedgerQuery, candidates: Candidate[]): LedgerEntry[];
}
```

- [ ] **Step 3: Write the failing HybridRanker test**

Create `src/service/hybrid-ranker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HybridRanker } from "./hybrid-ranker.js";
import type { Candidate, LedgerEntry } from "../domain/entry.js";

const NOW = Date.parse("2026-06-22T00:00:00.000Z");
const ranker = new HybridRanker(() => NOW);

let seq = 0;
function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `01_${String(seq).padStart(4, "0")}`,
    kind: "surprise",
    project: "evaluagent",
    title: "t",
    body: "b",
    payload: {},
    confidence: null,
    salience: 0,
    tags: [],
    sessionId: null,
    occurredAt: null,
    createdAt: "2026-06-22T00:00:00.000Z",
    source: "self_report",
    toolName: null,
    refEntryId: null,
    ...over,
  };
}
const cand = (e: LedgerEntry, textScore: number | null): Candidate => ({ entry: e, textScore });

describe("HybridRanker", () => {
  it("recency mode orders by id descending and ignores text", () => {
    const a = entry({ id: "01_0001" });
    const b = entry({ id: "01_0002" });
    const out = ranker.rank({ project: "p", rank: "recency" }, [cand(a, -5), cand(b, null)]);
    expect(out.map((e) => e.id)).toEqual(["01_0002", "01_0001"]);
  });

  it("match mode keeps only FTS matches, best bm25 first", () => {
    const a = entry({ title: "weak" });
    const b = entry({ title: "strong" });
    const c = entry({ title: "nomatch" });
    // bm25 lower = better, so b (-9) ranks above a (-1); c (null) dropped.
    const out = ranker.rank({ project: "p", rank: "match" }, [cand(a, -1), cand(b, -9), cand(c, null)]);
    expect(out.map((e) => e.title)).toEqual(["strong", "weak"]);
  });

  it("hybrid surfaces a strong text match above a recent non-match", () => {
    const recentNoMatch = entry({ title: "recent", createdAt: "2026-06-22T00:00:00.000Z" });
    const oldStrongMatch = entry({ title: "match", createdAt: "2026-06-01T00:00:00.000Z" });
    const out = ranker.rank({ project: "p", rank: "hybrid", text: "x" }, [
      cand(recentNoMatch, null),
      cand(oldStrongMatch, -9),
    ]);
    expect(out[0]!.title).toBe("match");
  });

  it("hybrid still returns recent entries when nothing matches (best-available)", () => {
    const a = entry({ id: "01_0001", createdAt: "2026-06-10T00:00:00.000Z" });
    const b = entry({ id: "01_0002", createdAt: "2026-06-21T00:00:00.000Z" });
    const out = ranker.rank({ project: "p", rank: "hybrid", text: "zzz" }, [cand(a, null), cand(b, null)]);
    expect(out.map((e) => e.id)).toEqual(["01_0002", "01_0001"]); // recency wins, no false-empty
  });

  it("hybrid boosts tag overlap", () => {
    const tagged = entry({ id: "01_0001", tags: ["fts", "search"] });
    const plain = entry({ id: "01_0002", tags: [] }); // newer id
    const out = ranker.rank({ project: "p", rank: "hybrid", tags: ["FTS"] }, [
      cand(plain, null),
      cand(tagged, null),
    ]);
    expect(out[0]!.id).toBe("01_0001"); // tag overlap beats the newer plain entry
  });

  it("respects the limit", () => {
    const cands = [entry(), entry(), entry()].map((e) => cand(e, null));
    expect(ranker.rank({ project: "p", rank: "hybrid", limit: 2 }, cands)).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/service/hybrid-ranker.test.ts`
Expected: FAIL — `Failed to load url ./hybrid-ranker.js` (module missing).

- [ ] **Step 5: Implement HybridRanker**

Create `src/service/hybrid-ranker.ts`:

```ts
import type { Ranker } from "../repo/ranker.js";
import type { Candidate, LedgerEntry, LedgerQuery, RankMode } from "../domain/entry.js";
import { clampLimit, RECALL_MAX_LIMIT } from "../domain/limits.js";

const WEIGHTS = { text: 0.5, recency: 0.25, salience: 0.15, tag: 0.1 };
const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

/** id DESC = most-recent-first (ulids are time-sortable). */
function byIdDesc(a: Candidate, b: Candidate): number {
  return a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0;
}

export class HybridRanker implements Ranker {
  constructor(private readonly now: () => number = () => Date.now()) {}

  rank(q: LedgerQuery, candidates: Candidate[]): LedgerEntry[] {
    const mode: RankMode = q.rank ?? "hybrid";
    const limit = clampLimit(q.limit, RECALL_MAX_LIMIT);

    if (mode === "recency") {
      return [...candidates].sort(byIdDesc).slice(0, limit).map((c) => c.entry);
    }

    // Normalize text from raw bm25 (lower=better) via min-max over matches → [0,1], higher=better.
    const matched = candidates.filter((c) => c.textScore !== null);
    const vals = matched.map((c) => -(c.textScore as number));
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 0;
    const textOf = (c: Candidate): number => {
      if (c.textScore === null) return 0;
      if (matched.length === 1 || max === min) return 1;
      return (-(c.textScore) - min) / (max - min);
    };

    if (mode === "match") {
      return matched
        .map((c) => ({ c, text: textOf(c) }))
        .sort((a, b) => b.text - a.text || b.c.entry.salience - a.c.entry.salience || byIdDesc(a.c, b.c))
        .slice(0, limit)
        .map((x) => x.c.entry);
    }

    // hybrid
    const nowMs = this.now();
    const qTags = (q.tags ?? []).map((t) => t.toLowerCase());
    const scoreOf = (c: Candidate): number => {
      const text = textOf(c);
      const ageDays = Math.max(0, (nowMs - Date.parse(c.entry.createdAt)) / DAY_MS);
      const recency = Math.exp(-ageDays / HALF_LIFE_DAYS);
      const salience = (c.entry.salience ?? 0) / 3;
      const tag =
        qTags.length === 0
          ? 0
          : c.entry.tags.filter((t) => qTags.includes(t.toLowerCase())).length / qTags.length;
      return WEIGHTS.text * text + WEIGHTS.recency * recency + WEIGHTS.salience * salience + WEIGHTS.tag * tag;
    };
    return [...candidates]
      .map((c) => ({ c, s: scoreOf(c) }))
      .sort((a, b) => b.s - a.s || byIdDesc(a.c, b.c))
      .slice(0, limit)
      .map((x) => x.c.entry);
  }
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run src/service/hybrid-ranker.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Swap the service ranker and delete SimpleRanker**

In `src/service/ledger-service.ts`:
- Replace the import `import { SimpleRanker } from "./simple-ranker.js";` with `import { HybridRanker } from "./hybrid-ranker.js";`.
- In the constructor, change `this.ranker = opts.ranker ?? new SimpleRanker();` to `this.ranker = opts.ranker ?? new HybridRanker();`.
- In `recall`, the candidates are currently `await this.repo.query(query)` (a `LedgerEntry[]`). Wrap them so the new `Ranker` signature is satisfied (full routing comes in Task 4):

```ts
    const candidates = (await this.repo.query(query)).map((entry) => ({ entry, textScore: null }));
    return this.ranker.rank(query, candidates);
```

Delete `src/service/simple-ranker.ts`.

In `src/index.ts`, replace `export * from "./service/simple-ranker.js";` with `export * from "./service/hybrid-ranker.js";`.

- [ ] **Step 8: Run the full suite (nothing regressed)**

Run: `npx vitest run`
Expected: PASS — recall tests still green (default still `recency`; `query()` already orders/limits, and the wrapped recency ranking is idempotent).

- [ ] **Step 9: Commit**

```bash
git add src/domain/entry.ts src/repo/ranker.ts src/service/hybrid-ranker.ts src/service/hybrid-ranker.test.ts src/service/ledger-service.ts src/index.ts
git rm src/service/simple-ranker.ts
git commit -m "feat(recall): add HybridRanker + Candidate type, replace SimpleRanker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: FTS5 index, triggers, and backfill

Add the FTS5 external-content index to `SqliteRepository`, kept in sync by triggers, with an idempotent backfill so pre-existing rows become searchable. No `search()` yet — this task only proves the index exists and stays in sync.

**Files:**
- Modify: `src/repo/sqlite/sqlite-repository.ts`
- Test: `src/repo/sqlite/sqlite-repository.test.ts`

**Interfaces:**
- Produces: an `entries_fts` FTS5 table over `(title, body)` synced to `entries`, populated on open.
- Consumes: existing `entries` table + `SqliteRepository` constructor.

- [ ] **Step 1: Write the failing test**

Append to `src/repo/sqlite/sqlite-repository.test.ts`:

```ts
describe("SqliteRepository FTS index", () => {
  // Helper reaching into the raw db to assert FTS rows match.
  function ftsHits(r: SqliteRepository, match: string): number {
    // @ts-expect-error access private db for a white-box index assertion
    const db = r.db as import("better-sqlite3").Database;
    return (db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH ?").get(match) as { c: number }).c;
  }

  it("indexes inserted entries for full-text + stemmed match", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "the server is running", body: "vite dev" }));
    expect(ftsHits(r, '"running"')).toBe(1);
    expect(ftsHits(r, '"run"')).toBe(1); // porter stemming
    expect(ftsHits(r, '"absent"')).toBe(0);
  });

  it("backfills pre-existing rows on open (rebuild)", async () => {
    const path = `${tmpdir()}/evg-fts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`;
    // Seed an entry, then drop the FTS index to simulate an old DB without FTS.
    const first = new SqliteRepository(path);
    await first.insertEntry(newEntry({ title: "backfilled lesson", body: "x" }));
    // @ts-expect-error white-box
    (first.db as import("better-sqlite3").Database).exec("DROP TABLE entries_fts");
    await first.close();

    const reopened = new SqliteRepository(path); // constructor must rebuild FTS
    // @ts-expect-error white-box
    const db = reopened.db as import("better-sqlite3").Database;
    const hits = (db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH ?").get('"backfilled"') as { c: number }).c;
    expect(hits).toBe(1);
    await reopened.close();
  });
});
```

Add the imports at the top of the test file if missing:

```ts
import { tmpdir } from "node:os";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts`
Expected: FAIL — `no such table: entries_fts`.

- [ ] **Step 3: Add FTS DDL + triggers + backfill**

In `src/repo/sqlite/sqlite-repository.ts`, after the existing `COLUMN_MIGRATIONS` const add:

```ts
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body,
  content='entries', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;
```

In the constructor, after `this.migrateColumns();` add `this.migrateFts();`, and add the method:

```ts
  /** Create the FTS index + triggers and backfill pre-existing rows (idempotent). */
  private migrateFts(): void {
    this.db.exec(FTS_DDL);
    const fts = this.db.prepare("SELECT count(*) c FROM entries_fts").get() as { c: number };
    const ent = this.db.prepare("SELECT count(*) c FROM entries").get() as { c: number };
    if (fts.c === 0 && ent.c > 0) {
      this.db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
    }
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts`
Expected: PASS (all prior tests + the 2 new FTS tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo/sqlite/sqlite-repository.ts src/repo/sqlite/sqlite-repository.test.ts
git commit -m "feat(repo): FTS5 external-content index with triggers + backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Repository `search()` (match + hybrid candidates)

Add the FTS-aware candidate fetch returning scored `Candidate`s. OR-joins query terms (forgiving), scope-filters, and for `hybrid` unions FTS matches with the recent pool.

**Files:**
- Modify: `src/repo/ledger-repository.ts` (interface)
- Modify: `src/repo/sqlite/sqlite-repository.ts` (impl + term builder)
- Test: `src/repo/sqlite/sqlite-repository.test.ts`

**Interfaces:**
- Produces: `LedgerRepository.search(q: LedgerQuery): Promise<Candidate[]>`. `match` → only FTS hits (textScore = bm25). `hybrid` (and any non-`match`/non-`recency`) → FTS hits ∪ recent pool (recent get textScore null), de-duped, capped at 200.
- Consumes: `Candidate` (Task 1), `entries_fts` (Task 2).

- [ ] **Step 1: Add `search` to the interface**

In `src/repo/ledger-repository.ts`, import `Candidate` and add the method:

```ts
import type { Candidate, LedgerEntry, LedgerQuery, NewEntry } from "../domain/entry.js";

export interface LedgerRepository {
  insertEntry(entry: NewEntry): Promise<LedgerEntry>;
  getEntry(id: string): Promise<LedgerEntry | null>;
  query(q: LedgerQuery): Promise<LedgerEntry[]>;
  /** FTS-aware candidate fetch for match/hybrid ranking. */
  search(q: LedgerQuery): Promise<Candidate[]>;
  findOpenPre(match: SpineMatch): Promise<LedgerEntry | null>;
  findLatestPost(match: SpineMatch): Promise<LedgerEntry | null>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

Append to `src/repo/sqlite/sqlite-repository.test.ts`:

```ts
describe("SqliteRepository.search", () => {
  it("match: OR-joins terms so any term hits, scored by bm25", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "hooks hot-reload", body: "claude code mcp add" }));
    await r.insertEntry(newEntry({ title: "unrelated", body: "nothing here" }));
    const out = await r.search({ project: "evaluagent", rank: "match", text: "hooks restart mcp" });
    expect(out.map((c) => c.entry.title)).toEqual(["hooks hot-reload"]);
    expect(typeof out[0]!.textScore).toBe("number");
  });

  it("match: returns empty when no term matches", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "alpha", body: "beta" }));
    expect(await r.search({ project: "evaluagent", rank: "match", text: "zzz" })).toHaveLength(0);
  });

  it("hybrid: unions FTS matches with the recent pool (never empty when entries exist)", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "alpha", body: "beta" }));
    const out = await r.search({ project: "evaluagent", rank: "hybrid", text: "zzz" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.textScore === null)).toBe(true); // no FTS hit → recency pool only
  });

  it("scopes by project and source", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ project: "evaluagent", title: "mine hooks" }));
    await r.insertEntry(newEntry({ project: "other", title: "theirs hooks" }));
    const out = await r.search({ project: "evaluagent", rank: "match", text: "hooks" });
    expect(out.map((c) => c.entry.title)).toEqual(["mine hooks"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts`
Expected: FAIL — `search is not a function` / type error at runtime.

- [ ] **Step 4: Implement `search` + the term builder**

In `src/repo/sqlite/sqlite-repository.ts`:

Update the type import to include `Candidate`:

```ts
import type { AnyKind, Candidate, EntrySource, LedgerEntry, LedgerQuery, NewEntry } from "../../domain/entry.js";
```

Add the term builder near the top (after `toEntry`):

```ts
/** Build a forgiving FTS5 MATCH expression: quote each term, OR them. Null if no text. */
function buildMatchExpr(text: string | undefined): string | null {
  if (!text) return null;
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.length > 0 ? terms.join(" OR ") : null;
}

const SEARCH_POOL = 200;
```

Add the method (e.g., after `query`):

```ts
  async search(q: LedgerQuery): Promise<Candidate[]> {
    const scope = ["e.project = ?"];
    const scopeParams: unknown[] = [q.project];
    if (q.kinds && q.kinds.length > 0) {
      scope.push(`e.kind IN (${q.kinds.map(() => "?").join(", ")})`);
      scopeParams.push(...q.kinds);
    }
    if (q.source) {
      scope.push("e.source = ?");
      scopeParams.push(q.source);
    }
    const scopeSql = scope.join(" AND ");

    const matchExpr = buildMatchExpr(q.text);
    const ftsRows = matchExpr
      ? (this.db
          .prepare(
            `SELECT e.*, bm25(entries_fts) AS bm25
             FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
             WHERE entries_fts MATCH ? AND ${scopeSql}
             ORDER BY bm25 LIMIT ?`,
          )
          .all(matchExpr, ...scopeParams, SEARCH_POOL) as Array<Row & { bm25: number }>)
      : [];

    const candidates: Candidate[] = ftsRows.map((r) => ({ entry: toEntry(r), textScore: r.bm25 }));

    if ((q.rank ?? "hybrid") === "match") return candidates;

    // hybrid: pad with the recent pool (so recall is never a false-empty)
    const seen = new Set(ftsRows.map((r) => r.id));
    const recent = this.db
      .prepare(`SELECT e.* FROM entries e WHERE ${scopeSql} ORDER BY e.id DESC LIMIT ?`)
      .all(...scopeParams, SEARCH_POOL) as Row[];
    for (const r of recent) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        candidates.push({ entry: toEntry(r), textScore: null });
      }
    }
    return candidates;
  }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts`
Expected: PASS (all prior + 4 new search tests).

- [ ] **Step 6: Commit**

```bash
git add src/repo/ledger-repository.ts src/repo/sqlite/sqlite-repository.ts src/repo/sqlite/sqlite-repository.test.ts
git commit -m "feat(repo): add FTS-aware search() (match + hybrid candidates)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire `recall` to FTS + hybrid default

Route `recall` through `search()`+`HybridRanker` for `match`/`hybrid` and `query()` for `recency`, default `hybrid`, pass `tags`, inject the clock.

**Files:**
- Modify: `src/service/ledger-service.ts`
- Test: `src/service/ledger-service.test.ts`

**Interfaces:**
- Consumes: `repo.search()` (Task 3), `HybridRanker` (Task 1).
- Produces: `recall(input)` where `input.rank` defaults to `"hybrid"`; `input.tags` flows through; `recency` path unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/service/ledger-service.test.ts`:

```ts
describe("LedgerService.recall (FTS + hybrid)", () => {
  it("hybrid (default) returns a relevant entry for a multi-word query that lacks a full match", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({
      kind: "surprise",
      title: "Claude Code hooks hot-reload, but mcp add does not",
      body: "writing hooks into settings took effect with no restart",
      payload: { expected: "restart needed", actual: "hot reload", magnitude: 2 },
    });
    await s.record({ ...surprise, title: "totally unrelated", body: "nothing relevant" });
    const out = await s.recall({ text: "hooks restart mcp" });
    expect(out[0]!.title).toContain("hooks hot-reload");
  });

  it("match mode can be empty", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "alpha", body: "beta" });
    expect(await s.recall({ rank: "match", text: "zzzzz" })).toHaveLength(0);
  });

  it("recency mode preserves insertion order (unchanged behavior)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "first" });
    await s.record({ ...surprise, title: "second" });
    expect((await s.recall({ rank: "recency" })).map((e) => e.title)).toEqual(["second", "first"]);
  });
});
```

(`surprise` is the existing fixture object already defined at the top of this test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: FAIL — hybrid test fails (current recall ignores `text` via wrapped recency, so `out[0]` is "unrelated" / order-based), proving the routing isn't there yet.

- [ ] **Step 3: Implement the routing**

In `src/service/ledger-service.ts`, ensure `RankMode` is imported and rewrite `recall`:

```ts
import type { EntrySource, LedgerEntry, LedgerQuery, RankMode } from "../domain/entry.js";
```

```ts
  async recall(input: RecallInput): Promise<LedgerEntry[]> {
    const project = input.project ?? this.defaultProject;
    if (!project) {
      throw new LedgerValidationError("project is required (no defaultProject configured)");
    }
    const source: EntrySource = input.source ?? "self_report";
    const rank: RankMode = input.rank ?? "hybrid";
    const limit = clampLimit(input.limit, RECALL_MAX_LIMIT);
    const query: LedgerQuery = { ...input, project, source, rank, limit };

    const candidates =
      rank === "recency"
        ? (await this.repo.query(query)).map((entry) => ({ entry, textScore: null }))
        : await this.repo.search(query);

    return this.ranker.rank(query, candidates);
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: PASS (existing recall tests + 3 new). Note: the older "recall excludes spine by default" / "limit" tests still pass — they don't pass `rank`, now default `hybrid`, but with no `text` the hybrid pool = recent self_report entries ranked by recency+salience, preserving those assertions (equal salience → recency order).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add src/service/ledger-service.ts src/service/ledger-service.test.ts
git commit -m "feat(recall): route recall through FTS search + HybridRanker, default hybrid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Expose `rank` + `tags` on the `recall_reasoning` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `recall` (Task 4).
- Produces: `recall_reasoning` accepts `rank` (`recency|match|hybrid`, default hybrid) and `tags` (string[]).

- [ ] **Step 1: Write the failing regression test**

Append to `src/mcp/server.test.ts`:

```ts
  it("recall_reasoning resolves the multi-word query that the dogfood missed", async () => {
    const client = await connectedClient();
    await service.record({
      kind: "surprise",
      title: "Claude Code hooks hot-reload, but mcp add does not",
      body: "writing hooks into settings took effect with no restart",
      payload: { expected: "restart", actual: "hot reload", magnitude: 2 },
    });
    const res = await client.callTool({
      name: "recall_reasoning",
      arguments: { text: "hooks restart mcp", rank: "match" },
    });
    const out = JSON.parse(textOf(res));
    expect(out.count).toBe(1);
    expect(out.entries[0].title).toContain("hooks hot-reload");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/mcp/server.test.ts`
Expected: FAIL — `rank` isn't forwarded, so the call defaults to hybrid (returns ≥1 but possibly padded) — adjust expectation only if needed; primary failure is that `match` isn't honored. (If hybrid happens to return 1, harden by adding a second unrelated `record` before the assertion so `match` strictness is what makes count === 1.)

To make the failure unambiguous, the test above should first insert an unrelated entry:

```ts
    await service.record({ ...{ kind: "surprise", title: "noise", body: "irrelevant",
      payload: { expected: "a", actual: "b", magnitude: 1 } } });
```

- [ ] **Step 3: Add the tool params**

In `src/mcp/tools.ts`, inside `recall_reasoning`'s `inputSchema.properties`, add alongside the existing `source` (keep `ENTRY_KINDS` import as-is):

```ts
        rank: {
          type: "string",
          enum: ["recency", "match", "hybrid"],
          description:
            "recency = newest first; match = strict FTS matches only (can be empty); hybrid = best-available, blends text + recency + salience + tags (default).",
        },
        tags: { type: "array", items: { type: "string" }, description: "Filter/boost by tag overlap." },
```

- [ ] **Step 4: Forward them in the server**

In `src/mcp/server.ts`, add the import and pass the params through `recallReasoning`:

```ts
import type { EntryKind } from "../domain/entry-kinds.js";
import type { EntrySource, RankMode } from "../domain/entry.js";
```

```ts
  const entries = await service.recall({
    project: args.project as string | undefined,
    kinds: args.kinds as EntryKind[] | undefined,
    text: args.text as string | undefined,
    source: args.source as EntrySource | undefined,
    rank: args.rank as RankMode | undefined,
    tags: args.tags as string[] | undefined,
    limit: args.limit as number | undefined,
  });
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/mcp/server.test.ts`
Expected: PASS (existing 5 + new regression).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts src/mcp/server.test.ts
git commit -m "feat(mcp): expose rank + tags on recall_reasoning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification + rebuild

**Files:** none (verification only); rebuild `dist/` so the live MCP server/hook use the new code.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors). If `simple-ranker` is referenced anywhere, remove the reference.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: PASS — all files green.

- [ ] **Step 3: Build + audit**

Run: `npm run build && npm audit`
Expected: build exit 0; `found 0 vulnerabilities`.

- [ ] **Step 4: Manual recall smoke (optional but recommended)**

Run:
```bash
node --input-type=module -e "
import { SqliteRepository } from './dist/repo/sqlite/sqlite-repository.js';
import { LedgerService } from './dist/service/ledger-service.js';
const repo = new SqliteRepository(':memory:');
const s = new LedgerService({ repo, defaultProject: 'evaluagent' });
await s.record({ kind:'surprise', title:'hooks hot-reload vs mcp add', body:'settings hooks took effect with no restart', payload:{expected:'restart',actual:'hot reload',magnitude:2} });
console.log('hybrid:', (await s.recall({ text:'hooks restart mcp' })).map(e=>e.title));
console.log('match :', (await s.recall({ text:'hooks restart mcp', rank:'match' })).map(e=>e.title));
await repo.close();
"
```
Expected: both print the "hooks hot-reload vs mcp add" title (proving the dogfood query is fixed).

- [ ] **Step 5: Commit (if any build artifacts/notes) and push**

```bash
git push -u origin feat/phase2-fts-hybrid-recall
```

Then open a PR against `main` titled "Phase 2: FTS5 + hybrid recall ranking".

---

## Self-Review

**Spec coverage:**
- FTS5 storage + sync + backfill → Task 2. ✓
- Query-term OR + quoting → Task 3 (`buildMatchExpr`). ✓
- Repo candidate-fetch by mode (`match`/`hybrid`/`recency`) → Task 3 + service routing Task 4. ✓
- `HybridRanker` formula/normalization/weights/modes (incl. single-match=1, min-max, decay, tag overlap) → Task 1. ✓
- Surface changes (`RankMode`, `LedgerQuery.tags`, `search()`, recall default hybrid, MCP `rank`/`tags`) → Tasks 1/3/4/5. ✓
- `SimpleRanker` removed → Task 1. ✓
- Edge cases (empty text, FTS specials, de-dup, pool cap, bm25 sign) → Tasks 1/3. ✓
- Regression "hooks restart mcp" → Tasks 4 (service) + 5 (MCP). ✓
- Testing matrix → tests in Tasks 1–5; final verify Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code/test step has concrete content.

**Type consistency:** `Candidate { entry, textScore }`, `Ranker.rank(q, Candidate[]): LedgerEntry[]`, `HybridRanker(now)`, `LedgerRepository.search(q): Promise<Candidate[]>`, `RankMode = recency|match|hybrid`, `LedgerQuery.tags?: string[]` — used consistently across Tasks 1, 3, 4, 5.

**Note for implementer:** the FTS tests reach into the private `db` via `@ts-expect-error` for white-box index assertions; that's intentional and isolated to tests. If `tsc` ever type-checks test files and objects to `@ts-expect-error` being unused, switch to `(r as any).db`.
