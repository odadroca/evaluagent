# Read/Measure Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ledger's value loop observable and fix known read-path defects: recall-event logging, process-scoped session stamping, supersede-link surfacing, the recency+text false-empty, and scope visibility in recall responses.

**Architecture:** All changes ride the existing seams: `SqliteRepository` (storage), `LedgerService` (rules), `server.ts` (MCP mapping), `bin/ledger.ts` (wiring). Recall events get their own table (not `entries`) so the reasoning corpus and its FTS index stay clean. `LedgerService.recall` changes its return type from `LedgerEntry[]` to a `RecallResult` envelope carrying scope metadata and referrer links.

**Tech Stack:** TypeScript ESM (`.js` import specifiers), better-sqlite3, ulid, MCP SDK low-level Server, vitest.

## Global Constraints

- ESM: every relative import ends in `.js` (even from `.ts` files).
- No Zod. MCP `inputSchema` is plain JSON Schema; it is advertisement only — the MCP SDK does NOT enforce it, so every rule must be validated server-side in `LedgerService` (ledger lesson 01KVSWPC6B).
- Untrusted numerics: coerce with `Number(...)` + `Number.isFinite`, never bare `?? 0` (ledger lesson 01KVSWQ7TZ).
- TDD: write the failing test first; run targeted tests while iterating (`npx vitest run <file>`), full suite before each commit (`npx vitest run`).
- Tests are colocated: `src/**/<name>.test.ts`, importing from `./<name>.js`.
- Recall-event logging must be non-fatal: a logging failure warns on stderr and never fails the recall itself.
- The MCP server does not hot-reload and the config points at `dist/` — after the final task run `npm run build`; the user restarts with `claude -c`.
- HOLD exit is scoped to THIS bundle: no ranking-weight changes, no delete/fade tools.

---

### Task 1: Process-scoped session stamping

`session_id` is NULL on ~85% of self-reports because the MCP caller rarely knows its session id. Fix structurally: the serve process generates one `proc-<ulid>` id at boot and the service stamps it on every write that lacks an explicit session id. One server process ≈ one Claude Code session, so this is a usable session proxy.

**Files:**
- Modify: `src/service/ledger-service.ts`
- Modify: `src/bin/ledger.ts`
- Test: `src/service/ledger-service.test.ts`

**Interfaces:**
- Produces: `LedgerServiceOptions.defaultSessionId?: string` — fallback stamped onto `record`/`recordSpine` writes (and recall events in Task 3) when the input carries no session id.

- [ ] **Step 1: Write the failing tests** (append to `src/service/ledger-service.test.ts`)

```ts
describe("defaultSessionId stamping", () => {
  it("stamps record() writes that carry no sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.record({
      kind: "friction",
      title: "t",
      body: "b",
      payload: { where: "x", kind: "tooling", intensity: 1 },
    });
    expect(entry.sessionId).toBe("proc-TEST");
  });

  it("does not override an explicit sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.record({
      kind: "friction",
      title: "t",
      body: "b",
      payload: { where: "x", kind: "tooling", intensity: 1 },
      sessionId: "real-session",
    });
    expect(entry.sessionId).toBe("real-session");
  });

  it("stamps recordSpine() writes that carry no sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.recordSpine({ kind: "spine_lifecycle", title: "t", body: "b" });
    expect(entry.sessionId).toBe("proc-TEST");
  });
});
```

If the existing test file lacks these imports, match its existing import style (it already imports `LedgerService` from `./ledger-service.js` and `SqliteRepository` from `../repo/sqlite/sqlite-repository.js`). The friction payload shape must satisfy `validatePayload("friction", ...)` — if the test fails on payload validation, check `src/domain/entry-kinds.ts` for the exact required fields and adjust the payload literal, not the validation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: FAIL — `defaultSessionId` not a known option / `sessionId` is null.

- [ ] **Step 3: Implement**

In `src/service/ledger-service.ts`:

```ts
export interface LedgerServiceOptions {
  repo: LedgerRepository;
  ranker?: Ranker;
  defaultProject?: string;
  /** Stamped on writes that carry no explicit session id (e.g. a per-process proxy id). */
  defaultSessionId?: string;
}
```

Add the field and constructor line:

```ts
  private readonly defaultSessionId?: string;
  // in constructor:
  this.defaultSessionId = opts.defaultSessionId;
```

In `record()`, change the `insertEntry` call's session line:

```ts
      sessionId: input.sessionId ?? this.defaultSessionId ?? null,
```

In `recordSpine()`, the spine correlation match must keep using the effective id. At the top of `recordSpine`, after resolving `proj`:

```ts
    const sessionId = write.sessionId ?? this.defaultSessionId ?? null;
```

Then use `sessionId` in the `match` object (replacing `write.sessionId ?? null`) and in the final `insertEntry` (`sessionId,` replacing `sessionId: write.sessionId ?? null,`).

In `src/bin/ledger.ts`, add the import and stamp:

```ts
import { ulid } from "ulid";
```

In `serve()`:

```ts
  const service = new LedgerService({
    repo,
    defaultProject: project,
    defaultSessionId: `proc-${ulid()}`,
  });
```

- [ ] **Step 4: Run targeted tests, then the full suite**

Run: `npx vitest run src/service/ledger-service.test.ts` → PASS, then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/service/ledger-service.ts src/bin/ledger.ts src/service/ledger-service.test.ts
git commit -m "feat(session): stamp a per-process proc-<ulid> session id on writes lacking one"
```

---

### Task 2: `recall_events` table + repository methods

A separate table (not `entries`) so recall telemetry never pollutes the reasoning corpus, its FTS index, or spine reads.

**Files:**
- Create: `src/domain/recall-event.ts`
- Modify: `src/repo/ledger-repository.ts`
- Modify: `src/repo/sqlite/sqlite-repository.ts`
- Test: `src/repo/sqlite/sqlite-repository.test.ts`

**Interfaces:**
- Produces:
  - `NewRecallEvent { project: string; sessionId?: string | null; query: RecallEventQuery; returned: RecallEventHit[] }`
  - `RecallEventQuery { text?: string; rank: string; source: string; kinds?: string[]; tags?: string[]; limit: number }`
  - `RecallEventHit { entry_id: string; rank: number }`
  - `RecallEvent extends NewRecallEvent { id: string; createdAt: string; resultCount: number; sessionId: string | null }`
  - `LedgerRepository.insertRecallEvent(e: NewRecallEvent): Promise<RecallEvent>`
  - `LedgerRepository.listRecallEvents(project: string, limit?: number): Promise<RecallEvent[]>` (newest first)

- [ ] **Step 1: Write the failing tests** (append to `src/repo/sqlite/sqlite-repository.test.ts`)

```ts
describe("recall events", () => {
  it("inserts and lists recall events newest-first with round-tripped JSON", async () => {
    const repo = new SqliteRepository(":memory:");
    const first = await repo.insertRecallEvent({
      project: "p",
      sessionId: "proc-A",
      query: { text: "hooks restart", rank: "hybrid", source: "self_report", limit: 10 },
      returned: [{ entry_id: "01AAA", rank: 1 }, { entry_id: "01BBB", rank: 2 }],
    });
    await repo.insertRecallEvent({
      project: "p",
      query: { rank: "recency", source: "self_report", limit: 5 },
      returned: [],
    });

    expect(first.id).toBeTruthy();
    expect(first.resultCount).toBe(2);

    const events = await repo.listRecallEvents("p");
    expect(events).toHaveLength(2);
    expect(events[0].query.rank).toBe("recency"); // newest first
    expect(events[0].sessionId).toBeNull();
    expect(events[1].returned).toEqual([{ entry_id: "01AAA", rank: 1 }, { entry_id: "01BBB", rank: 2 }]);
    expect(events[1].query.text).toBe("hooks restart");
  });

  it("scopes listRecallEvents by project", async () => {
    const repo = new SqliteRepository(":memory:");
    await repo.insertRecallEvent({ project: "a", query: { rank: "hybrid", source: "self_report", limit: 10 }, returned: [] });
    expect(await repo.listRecallEvents("b")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts`
Expected: FAIL — `insertRecallEvent is not a function`.

- [ ] **Step 3: Implement**

Create `src/domain/recall-event.ts`:

```ts
/** The recall query as logged — enough to replay/analyze, no results duplicated. */
export interface RecallEventQuery {
  text?: string;
  rank: string;
  source: string;
  kinds?: string[];
  tags?: string[];
  limit: number;
}

/** One returned entry with its 1-based rank in the response. */
export interface RecallEventHit {
  entry_id: string;
  rank: number;
}

/** Input to log one recall invocation. Identity/time are assigned by the repository. */
export interface NewRecallEvent {
  project: string;
  sessionId?: string | null;
  query: RecallEventQuery;
  returned: RecallEventHit[];
}

/** A stored recall event. */
export interface RecallEvent {
  id: string;
  project: string;
  sessionId: string | null;
  query: RecallEventQuery;
  returned: RecallEventHit[];
  resultCount: number;
  createdAt: string;
}
```

In `src/repo/ledger-repository.ts` add to the imports and interface:

```ts
import type { NewRecallEvent, RecallEvent } from "../domain/recall-event.js";
// interface additions:
  /** Log one recall invocation (query + returned ids/ranks) for T2/T3 measurement. */
  insertRecallEvent(e: NewRecallEvent): Promise<RecallEvent>;
  /** Recall events for a project, newest first. */
  listRecallEvents(project: string, limit?: number): Promise<RecallEvent[]>;
```

In `src/repo/sqlite/sqlite-repository.ts`:

Add to imports: `import type { NewRecallEvent, RecallEvent } from "../../domain/recall-event.js";`

Append to the `DDL` constant (inside the same template string):

```sql
CREATE TABLE IF NOT EXISTS recall_events (
  id           TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  session_id   TEXT,
  created_at   TEXT NOT NULL,
  query        TEXT NOT NULL DEFAULT '{}',
  returned     TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recall_events_project ON recall_events(project, id DESC);
```

(`CREATE TABLE IF NOT EXISTS` inside the existing `DDL` exec makes this migration-free for pre-existing DBs — same pattern the entries table uses.)

Add the row type and methods to the class:

```ts
interface RecallEventRow {
  id: string;
  project: string;
  session_id: string | null;
  created_at: string;
  query: string;
  returned: string;
  result_count: number;
}

function toRecallEvent(row: RecallEventRow): RecallEvent {
  return {
    id: row.id,
    project: row.project,
    sessionId: row.session_id,
    createdAt: row.created_at,
    query: JSON.parse(row.query),
    returned: JSON.parse(row.returned),
    resultCount: row.result_count,
  };
}
```

```ts
  async insertRecallEvent(e: NewRecallEvent): Promise<RecallEvent> {
    const row: RecallEventRow = {
      id: ulid(),
      project: e.project,
      session_id: e.sessionId ?? null,
      created_at: new Date().toISOString(),
      query: JSON.stringify(e.query),
      returned: JSON.stringify(e.returned),
      result_count: e.returned.length,
    };
    this.db
      .prepare(
        `INSERT INTO recall_events (id, project, session_id, created_at, query, returned, result_count)
         VALUES (@id, @project, @session_id, @created_at, @query, @returned, @result_count)`,
      )
      .run(row);
    return toRecallEvent(row);
  }

  async listRecallEvents(project: string, limit = 100): Promise<RecallEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM recall_events WHERE project = ? ORDER BY id DESC LIMIT ?")
      .all(project, clampLimit(limit, 1000)) as RecallEventRow[];
    return rows.map(toRecallEvent);
  }
```

Check `clampLimit`'s signature in `src/domain/limits.ts` — it is used elsewhere as `clampLimit(q.limit)` and `clampLimit(input.limit, RECALL_MAX_LIMIT)`. If the second parameter is the max, `clampLimit(limit, 1000)` is right; if not, mirror the existing call convention.

- [ ] **Step 4: Run targeted tests, then the full suite**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts` → PASS, then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/recall-event.ts src/repo/ledger-repository.ts src/repo/sqlite/sqlite-repository.ts src/repo/sqlite/sqlite-repository.test.ts
git commit -m "feat(measure): recall_events table + repository insert/list"
```

---

### Task 3: Log every recall in `LedgerService.recall` (non-fatal)

**Files:**
- Modify: `src/service/ledger-service.ts`
- Test: `src/service/ledger-service.test.ts`

**Interfaces:**
- Consumes: `insertRecallEvent` (Task 2), `defaultSessionId` (Task 1).
- Produces: every `recall()` call writes one recall event: effective query (project resolved, defaults applied), returned entry ids with 1-based ranks, session id. A failed event insert warns on stderr and does not fail the recall.

- [ ] **Step 1: Write the failing tests** (append to `src/service/ledger-service.test.ts`)

```ts
describe("recall-event logging", () => {
  it("logs the effective query and returned ids with ranks", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-T" });
    const a = await service.record({ kind: "friction", title: "hooks restart pain", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.recall({ text: "hooks", limit: 5 });

    const events = await repo.listRecallEvents("p");
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("proc-T");
    expect(events[0].query).toEqual({ text: "hooks", rank: "hybrid", source: "self_report", limit: 5 });
    expect(events[0].returned[0]).toEqual({ entry_id: a.id, rank: 1 });
    expect(events[0].resultCount).toBeGreaterThanOrEqual(1);
  });

  it("a failing event insert does not fail the recall", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    await service.record({ kind: "friction", title: "t", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const boom = vi.spyOn(repo, "insertRecallEvent").mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const entries = (await service.recall({})).entries;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(boom).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

Note: the second test reads `.entries` off the recall result — that shape lands in Task 5. If Task 5 has not run yet, write it as `const entries = await service.recall({});` and Task 5's implementer updates it. If `vi` is not imported in this test file, add it to the vitest import line.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: FAIL — no recall event logged.

- [ ] **Step 3: Implement**

In `LedgerService.recall`, after `const ranked = this.ranker.rank(query, candidates);` (rename the current return expression to a local), insert:

```ts
    const ranked = this.ranker.rank(query, candidates);

    try {
      await this.repo.insertRecallEvent({
        project,
        sessionId: this.defaultSessionId ?? null,
        query: {
          ...(query.text !== undefined ? { text: query.text } : {}),
          rank,
          source,
          ...(query.kinds && query.kinds.length > 0 ? { kinds: query.kinds } : {}),
          ...(query.tags && query.tags.length > 0 ? { tags: query.tags } : {}),
          limit,
        },
        returned: ranked.map((e, i) => ({ entry_id: e.id, rank: i + 1 })),
      });
    } catch (err) {
      // Telemetry must never break recall — the lesson store is the product, the log is the meter.
      process.stderr.write(`recall-event logging failed: ${(err as Error).message}\n`);
    }

    return ranked;
```

- [ ] **Step 4: Run targeted tests, then the full suite**

Run: `npx vitest run src/service/ledger-service.test.ts` → PASS, then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/service/ledger-service.ts src/service/ledger-service.test.ts
git commit -m "feat(measure): log every recall invocation (query + returned ranks), non-fatal"
```

---

### Task 4: `ref_entry_id` on record — accept, validate, advertise

Supersede links today exist only in body prose (the #6353 rot arc). Let writers set `ref_entry_id` via MCP, validated server-side (the inputSchema is not enforcement).

**Files:**
- Modify: `src/service/ledger-service.ts` (RecordInput + validation)
- Modify: `src/mcp/server.ts` (pass-through)
- Modify: `src/mcp/tools.ts` (schema + description)
- Test: `src/service/ledger-service.test.ts`

**Interfaces:**
- Produces: `RecordInput.refEntryId?: string | null`; recording with a `refEntryId` that matches no stored entry throws `LedgerValidationError`. MCP arg name: `ref_entry_id`.

- [ ] **Step 1: Write the failing tests** (append to `src/service/ledger-service.test.ts`)

```ts
describe("ref_entry_id on record", () => {
  it("stores a valid reference to an earlier entry", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const prior = await service.record({ kind: "friction", title: "t1", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const next = await service.record({
      kind: "friction", title: "t2", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 },
      refEntryId: prior.id,
    });
    expect(next.refEntryId).toBe(prior.id);
  });

  it("rejects a reference to a non-existent entry", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    await expect(
      service.record({
        kind: "friction", title: "t", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 },
        refEntryId: "01NOPE",
      }),
    ).rejects.toThrow(/ref_entry_id/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: FAIL — `refEntryId` ignored (first test) / no rejection (second test).

- [ ] **Step 3: Implement**

`RecordInput` gains:

```ts
  /** Earlier entry this one supersedes/corrects/refines. Must exist. */
  refEntryId?: string | null;
```

In `record()`, after the salience check and before the project resolution:

```ts
    if (input.refEntryId != null) {
      const ref = await this.repo.getEntry(input.refEntryId);
      if (!ref) {
        throw new LedgerValidationError(`ref_entry_id does not match any stored entry: ${input.refEntryId}`);
      }
    }
```

And in the `insertEntry` call add:

```ts
      refEntryId: input.refEntryId ?? null,
```

In `src/mcp/server.ts` `recordReasoning`, add to the `service.record({...})` argument object:

```ts
    refEntryId: args.ref_entry_id as string | undefined,
```

In `src/mcp/tools.ts`, `record_reasoning.inputSchema.properties` gains:

```ts
        ref_entry_id: {
          type: "string",
          description:
            "entry_id of an earlier entry this one SUPERSEDES, corrects, or refines. Set it whenever a conclusion overturns a stored one — recall surfaces the link so stale entries are visibly outdated.",
        },
```

- [ ] **Step 4: Run targeted tests, then the full suite**

Run: `npx vitest run src/service/ledger-service.test.ts` → PASS, then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/service/ledger-service.ts src/mcp/server.ts src/mcp/tools.ts src/service/ledger-service.test.ts
git commit -m "feat(links): accept + validate ref_entry_id on record_reasoning"
```

---### Task 5: `RecallResult` envelope — scope visibility + `superseded_by`

The June scoping incident (default project hid ~94% of the corpus) and the prose-only supersede links both fix at the read surface: recall returns an envelope with effective scope, total-project count, and per-entry referrer links.

**Files:**
- Modify: `src/domain/entry.ts` (RecallResult type)
- Modify: `src/repo/ledger-repository.ts` + `src/repo/sqlite/sqlite-repository.ts` (`countProjects`, `findReferrers`)
- Modify: `src/service/ledger-service.ts` (recall returns RecallResult)
- Modify: `src/mcp/server.ts` (response mapping)
- Test: `src/repo/sqlite/sqlite-repository.test.ts`, `src/service/ledger-service.test.ts`, `src/mcp/server.test.ts`

**Interfaces:**
- Produces:
  - `RecallResult { entries: LedgerEntry[]; scope: { project: string; projectsTotal: number }; referrers: Record<string, string[]> }`
  - `LedgerRepository.countProjects(): Promise<number>` — distinct projects among self_report entries.
  - `LedgerRepository.findReferrers(ids: string[]): Promise<Record<string, string[]>>` — map of entry id → ids of LATER self_report entries whose `ref_entry_id` points at it (spine post→pre refs excluded).
  - MCP recall response gains `scope: { project, projects_total }`; each entry gains `project` and `superseded_by` (possibly empty array).
- Consumes: `LedgerService.recall` internals unchanged from Task 3 (the event-logging block stays; `returned` now maps over `result.entries`).

- [ ] **Step 1: Write the failing repository tests** (append to `src/repo/sqlite/sqlite-repository.test.ts`)

```ts
describe("countProjects and findReferrers", () => {
  it("counts distinct self_report projects only", async () => {
    const repo = new SqliteRepository(":memory:");
    await repo.insertEntry({ kind: "friction", project: "a", title: "t", body: "b", payload: {} });
    await repo.insertEntry({ kind: "friction", project: "b", title: "t", body: "b", payload: {} });
    await repo.insertEntry({ kind: "spine_tool", project: "c", title: "t", body: "b", payload: {}, source: "hook_spine" });
    expect(await repo.countProjects()).toBe(2);
  });

  it("maps referenced ids to self_report referrers, excluding spine refs", async () => {
    const repo = new SqliteRepository(":memory:");
    const old = await repo.insertEntry({ kind: "friction", project: "a", title: "t", body: "b", payload: {} });
    const fix = await repo.insertEntry({ kind: "friction", project: "a", title: "t2", body: "b", payload: {}, refEntryId: old.id });
    await repo.insertEntry({ kind: "spine_tool", project: "a", title: "post", body: "b", payload: {}, source: "hook_spine", refEntryId: old.id });
    const map = await repo.findReferrers([old.id, fix.id]);
    expect(map[old.id]).toEqual([fix.id]);
    expect(map[fix.id]).toBeUndefined();
    expect(await repo.findReferrers([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run repo tests to verify they fail, then implement the repo methods**

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts` → FAIL.

In `src/repo/ledger-repository.ts` add to the interface:

```ts
  /** Distinct projects among self_report entries (scope-visibility metadata). */
  countProjects(): Promise<number>;
  /** Map of entry id → ids of self_report entries whose ref_entry_id points at it. */
  findReferrers(ids: string[]): Promise<Record<string, string[]>>;
```

In `src/repo/sqlite/sqlite-repository.ts`:

```ts
  async countProjects(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT project) c FROM entries WHERE source = 'self_report'")
      .get() as { c: number };
    return row.c;
  }

  async findReferrers(ids: string[]): Promise<Record<string, string[]>> {
    if (ids.length === 0) return {};
    const rows = this.db
      .prepare(
        `SELECT id, ref_entry_id FROM entries
         WHERE source = 'self_report' AND ref_entry_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY id`,
      )
      .all(...ids) as Array<{ id: string; ref_entry_id: string }>;
    const map: Record<string, string[]> = {};
    for (const r of rows) (map[r.ref_entry_id] ??= []).push(r.id);
    return map;
  }
```

Run: `npx vitest run src/repo/sqlite/sqlite-repository.test.ts` → PASS.

- [ ] **Step 3: Write the failing service test** (append to `src/service/ledger-service.test.ts`)

```ts
describe("RecallResult envelope", () => {
  it("returns entries with scope metadata and referrer links", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const old = await service.record({ kind: "friction", title: "old", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.record({ kind: "friction", title: "new", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 }, refEntryId: old.id });

    const result = await service.recall({});
    expect(result.scope.project).toBe("p");
    expect(result.scope.projectsTotal).toBe(1);
    expect(result.entries.length).toBe(2);
    expect(result.referrers[old.id]).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Implement the service change**

`src/domain/entry.ts` gains (after `Candidate`):

```ts
/** Recall response envelope: entries + scope metadata + supersede links. */
export interface RecallResult {
  entries: LedgerEntry[];
  /** Effective project filter and how many projects exist in the whole store. */
  scope: { project: string; projectsTotal: number };
  /** entry id → ids of later self_report entries that reference (supersede/correct) it. */
  referrers: Record<string, string[]>;
}
```

`LedgerService.recall` return type becomes `Promise<RecallResult>` (import `RecallResult` from `../domain/entry.js`). After the ranked list and the event-logging block:

```ts
    const [projectsTotal, referrers] = await Promise.all([
      this.repo.countProjects(),
      this.repo.findReferrers(ranked.map((e) => e.id)),
    ]);

    return { entries: ranked, scope: { project, projectsTotal }, referrers };
```

(The Task 3 event-logging block keeps mapping over `ranked` — no change.)

Update any existing service/server tests that treated `recall()`'s return as an array: they now read `.entries` (search the two test files for `service.recall(` and adjust destructuring only — assertions stay the same).

- [ ] **Step 5: Update the MCP mapping + its test**

In `src/mcp/server.ts` `recallReasoning`:

```ts
  const result = await service.recall({
    project: args.project as string | undefined,
    kinds: args.kinds as EntryKind[] | undefined,
    text: args.text as string | undefined,
    source: args.source as EntrySource | undefined,
    rank: args.rank as RankMode | undefined,
    tags: args.tags as string[] | undefined,
    limit: args.limit as number | undefined,
  });
  return ok({
    count: result.entries.length,
    scope: { project: result.scope.project, projects_total: result.scope.projectsTotal },
    entries: result.entries.map((e) => ({
      entry_id: e.id,
      kind: e.kind,
      project: e.project,
      title: e.title,
      body: e.body,
      tags: e.tags,
      confidence: e.confidence,
      salience: e.salience,
      created_at: e.createdAt,
      payload: e.payload,
      superseded_by: result.referrers[e.id] ?? [],
    })),
  });
```

Append to `src/mcp/server.test.ts` (match the file's existing harness for calling tools — it already exercises `recall_reasoning`; follow the same call pattern):

```ts
it("recall response carries scope and superseded_by", async () => {
  // Using the file's existing setup pattern: record one entry, then a second with ref_entry_id
  // pointing at it, then call recall_reasoning and inspect structuredContent.
  // Assert: scope.project === default project; scope.projects_total === 1;
  // the older entry's superseded_by contains the newer entry's id; the newer one's is [].
});
```

Write this test concretely against the harness found in the file (it constructs the server with an in-memory service and invokes `CallToolRequestSchema` handlers); the assertion list above is the required behavior.

In `src/mcp/tools.ts`, extend `recall_reasoning.description` (append one sentence):

```
Responses include the effective project scope (`scope.projects_total` shows how many projects exist beyond it) and per-entry `superseded_by` links — treat a superseded entry as potentially stale and read its successor.
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/entry.ts src/repo/ledger-repository.ts src/repo/sqlite/sqlite-repository.ts src/service/ledger-service.ts src/mcp/server.ts src/mcp/tools.ts src/repo/sqlite/sqlite-repository.test.ts src/service/ledger-service.test.ts src/mcp/server.test.ts
git commit -m "feat(recall): RecallResult envelope with scope metadata + superseded_by links"
```

---

### Task 6: Fix recency+text false-empty (tokenized FTS instead of whole-phrase LIKE)

`rank=recency` with multi-word `text` routes through `query()`'s single `LIKE '%<whole phrase>%'` and silently returns nothing (ledger lesson 01KY223HH7). Route it through the same tokenized FTS match as `match` mode, then recency-sort.

**Files:**
- Modify: `src/service/ledger-service.ts`
- Test: `src/service/ledger-service.test.ts`

**Interfaces:**
- Consumes: `repo.search` with `rank: "match"` returns FTS-matching candidates only (no recent-pool padding); `HybridRanker.rank` with `rank: "recency"` sorts candidates by id DESC.
- Produces: `recall({ rank: "recency", text: "<multi word>" })` returns entries matching ANY term, newest first.

- [ ] **Step 1: Write the failing test** (append to `src/service/ledger-service.test.ts`)

```ts
describe("recency + text", () => {
  it("multi-word text under rank=recency returns tokenized matches newest-first", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const a = await service.record({ kind: "friction", title: "hooks hot-reload works", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const b = await service.record({ kind: "friction", title: "mcp needs restart", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.record({ kind: "friction", title: "unrelated", body: "nothing here", payload: { where: "x", kind: "tooling", intensity: 1 } });

    const result = await service.recall({ rank: "recency", text: "hooks restart mcp" });
    expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]); // both match, newest first
  });

  it("recency without text still returns everything newest-first", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const a = await service.record({ kind: "friction", title: "one", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const b = await service.record({ kind: "friction", title: "two", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const result = await service.recall({ rank: "recency" });
    expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]);
  });
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npx vitest run src/service/ledger-service.test.ts`
Expected: FAIL — recency+multi-word-text returns `[]` (the whole-phrase LIKE bug, reproduced).

- [ ] **Step 3: Implement**

In `LedgerService.recall`, replace the candidates expression:

```ts
    const candidates =
      rank === "recency"
        ? query.text
          ? // Tokenized FTS (same interpretation as match/hybrid) — the whole-phrase LIKE
            // in query() silently false-empties on multi-word text.
            await this.repo.search({ ...query, rank: "match" })
          : (await this.repo.query(query)).map((entry) => ({ entry, textScore: null }))
        : await this.repo.search(query);
```

(`this.ranker.rank(query, ...)` still receives `rank: "recency"` from `query`, so ordering is id DESC.)

In `src/mcp/tools.ts`, update the `rank` description's recency clause to:

```
recency = newest first (text, if given, filters via the same tokenized FTS match);
```

- [ ] **Step 4: Run targeted tests, then the full suite**

Run: `npx vitest run src/service/ledger-service.test.ts` → PASS, then `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/service/ledger-service.ts src/mcp/tools.ts src/service/ledger-service.test.ts
git commit -m "fix(recall): recency+text uses tokenized FTS, killing the whole-phrase LIKE false-empty"
```

---

### Task 7: Docs, build, and handoff

**Files:**
- Modify: `CLAUDE.md` (repo)
- Modify: `README.md` (only if it documents the recall response shape — check; skip otherwise)

- [ ] **Step 1: Update repo CLAUDE.md**

Append under "## This repo's MCP server / hooks":

```markdown
## Measurement conventions (post-HOLD read/measure bundle, 2026-08-02)

- Every `recall_reasoning` call is logged to the `recall_events` table (query + returned
  ids/ranks + proc-session id). This is the T2/T3 join key — analysis reads it via direct
  SQL (`~/.evaluagent/ledger.db`).
- Writes without an explicit session id get a `proc-<ulid>` per-server-process stamp.
- When a conclusion overturns a stored entry, set `ref_entry_id` on the new entry; recall
  surfaces `superseded_by` on the old one. Treat superseded entries as stale.
- When a ledger lesson is promoted into a CLAUDE.md, tag the entry `promoted-to-claude-md`
  (attribution: separates "carried by CLAUDE.md" from "carried by recall").
```

- [ ] **Step 2: Full verification + build**

Run: `npx vitest run` → all green.
Run: `npm run build` → dist refreshed (the MCP config points at `dist/`, not `src/`).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: measurement conventions for the read/measure bundle"
```

- [ ] **Step 4: Handoff note (not a code step)**

The running MCP server still serves the old build — the user must restart with `claude -c` for the bundle to go live. Recall events start accruing from that restart; schedule the next evaluation ~2–4 weeks out to read the first real T2 data.

---

## Self-Review

- **Spec coverage:** recall-event logging (T2/T3 keystone) → Tasks 2–3; session NULL fix → Task 1; supersede surfacing → Tasks 4–5; scope visibility → Task 5; recency+text fix → Task 6; CLAUDE.md-confound tag convention → Task 7. Deliberately excluded (out of scope per HOLD-exit terms): ranking-weight changes, delete/fade tools, user-scope spine rollout.
- **Type consistency:** `RecallResult.referrers` (service) maps to `superseded_by` (MCP surface); `NewRecallEvent.returned` uses `entry_id`/`rank` keys end-to-end; `defaultSessionId` threads Task 1 → Task 3.
- **Known soft spot:** Task 5's server test is specified by behavior rather than verbatim code because it must reuse `server.test.ts`'s existing harness — the implementer writes it against that pattern.
