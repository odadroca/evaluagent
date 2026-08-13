import Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import type { AnyKind, Candidate, EntrySource, LedgerEntry, LedgerQuery, NewEntry } from "../../domain/entry.js";
import type { NewRecallEvent, RecallEvent } from "../../domain/recall-event.js";
import type { LedgerRepository, NudgeCounts, ProjectSummary, SpineMatch } from "../ledger-repository.js";
import { clampLimit } from "../../domain/limits.js";

// Monotonic so ids are strictly increasing even within the same millisecond —
// ordering by id DESC then yields a deterministic most-recent-first sequence.
const ulid = monotonicFactory();

const DDL = `
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  occurred_at TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  confidence  REAL,
  salience    INTEGER NOT NULL DEFAULT 0,
  tags        TEXT NOT NULL DEFAULT '[]',
  payload     TEXT NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL DEFAULT 'self_report',
  tool_name   TEXT,
  ref_entry_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_project_created ON entries(project, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_project_kind   ON entries(project, kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session        ON entries(session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_entries_project_source ON entries(project, source, id DESC);
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
`;

/**
 * Scope tables from architecture §3, finally built. `sessions.external_id` is the host
 * (Claude Code) session id — the join key that lands hook-spine and self-report in the
 * same session. Its absence is what forced the `proc-<ulid>` stamp and, downstream of
 * that, roughly ten workarounds; see docs/evaluagent-reconciliation-2026-08-13.md.
 */
const SCOPE_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  external_id TEXT,
  agent       TEXT,
  task        TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_external ON sessions(external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(project_id, ended_at, started_at DESC);
`;

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

/** Columns added after the initial schema; added to pre-existing DBs on open. */
const COLUMN_MIGRATIONS: Array<{ name: string; ddl: string }> = [
  { name: "source", ddl: "ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'self_report'" },
  { name: "tool_name", ddl: "ALTER TABLE entries ADD COLUMN tool_name TEXT" },
  { name: "ref_entry_id", ddl: "ALTER TABLE entries ADD COLUMN ref_entry_id TEXT" },
];

// Indexes on migrated columns: must run after migrateColumns() has ensured the
// column exists, since a pre-existing DB won't have it when the base DDL runs.
const REF_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_entries_ref ON entries(ref_entry_id) WHERE ref_entry_id IS NOT NULL;
`;

interface Row {
  id: string;
  project: string;
  session_id: string | null;
  kind: string;
  created_at: string;
  occurred_at: string | null;
  title: string;
  body: string;
  confidence: number | null;
  salience: number;
  tags: string;
  payload: string;
  source: string;
  tool_name: string | null;
  ref_entry_id: string | null;
}

function toEntry(row: Row): LedgerEntry {
  return {
    id: row.id,
    kind: row.kind as AnyKind,
    project: row.project,
    title: row.title,
    body: row.body,
    payload: JSON.parse(row.payload),
    confidence: row.confidence,
    salience: row.salience,
    tags: JSON.parse(row.tags) as string[],
    sessionId: row.session_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    source: row.source as EntrySource,
    toolName: row.tool_name,
    refEntryId: row.ref_entry_id,
  };
}

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

/** How recently a recall in this project counts as "already recalled this session". */
const RECALL_RECENCY_MS = 15 * 60 * 1000;
/** Window for "has this project seen a self-report lately" (journal-nudge suppression). */
const ACTIVITY_WINDOW_MS = 90 * 60 * 1000;
/** Window over which repeated identical tool calls mean "stuck right now". */
const RETRY_WINDOW_MS = 10 * 60 * 1000;

export class SqliteRepository implements LedgerRepository {
  private readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
    this.db.exec(SCOPE_DDL);
    this.migrateColumns();
    this.backfillProjects();
    this.db.exec(REF_INDEX_DDL);
    this.migrateFts();
  }

  /** Create the FTS index + triggers and backfill pre-existing rows (idempotent). */
  private migrateFts(): void {
    const existed = (
      this.db
        .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='entries_fts'")
        .get() as { c: number }
    ).c > 0;
    this.db.exec(FTS_DDL);
    if (!existed) {
      const ent = this.db.prepare("SELECT count(*) c FROM entries").get() as { c: number };
      if (ent.c > 0) {
        this.db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
      }
    }
  }

  /** Add any columns missing from a pre-existing DB (idempotent). */
  private migrateColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const m of COLUMN_MIGRATIONS) {
      if (!existing.has(m.name)) this.db.exec(m.ddl);
    }
  }

  async insertEntry(entry: NewEntry): Promise<LedgerEntry> {
    const row: Row = {
      id: ulid(),
      project: entry.project,
      session_id: entry.sessionId ?? null,
      kind: entry.kind,
      created_at: new Date().toISOString(),
      occurred_at: entry.occurredAt ?? null,
      title: entry.title,
      body: entry.body,
      confidence: entry.confidence ?? null,
      salience: entry.salience ?? 0,
      tags: JSON.stringify(entry.tags ?? []),
      payload: JSON.stringify(entry.payload ?? {}),
      source: entry.source ?? "self_report",
      tool_name: entry.toolName ?? null,
      ref_entry_id: entry.refEntryId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO entries
          (id, project, session_id, kind, created_at, occurred_at, title, body, confidence, salience, tags, payload, source, tool_name, ref_entry_id)
         VALUES
          (@id, @project, @session_id, @kind, @created_at, @occurred_at, @title, @body, @confidence, @salience, @tags, @payload, @source, @tool_name, @ref_entry_id)`,
      )
      .run(row);
    return toEntry(row);
  }

  async getEntry(id: string): Promise<LedgerEntry | null> {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  async query(q: LedgerQuery): Promise<LedgerEntry[]> {
    const clauses = ["project = ?"];
    const params: unknown[] = [q.project];

    if (q.kinds && q.kinds.length > 0) {
      clauses.push(`kind IN (${q.kinds.map(() => "?").join(", ")})`);
      params.push(...q.kinds);
    }
    if (q.text) {
      clauses.push("(title LIKE ? OR body LIKE ?)");
      const like = `%${q.text}%`;
      params.push(like, like);
    }
    if (q.source) {
      clauses.push("source = ?");
      params.push(q.source);
    }

    const sql = `SELECT * FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`;
    params.push(clampLimit(q.limit));

    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toEntry);
  }

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

    // The pool cap must not evict what the rank mode cares about most: recency keeps the
    // newest matches (bm25-ordering here would silently drop a new-but-weak match once
    // matches exceed SEARCH_POOL); match/hybrid keep the strongest.
    const orderSql = q.rank === "recency" ? "e.id DESC" : "bm25";
    const matchExpr = buildMatchExpr(q.text);
    const ftsRows = matchExpr
      ? (this.db
          .prepare(
            `SELECT e.*, bm25(entries_fts) AS bm25
             FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
             WHERE entries_fts MATCH ? AND ${scopeSql}
             ORDER BY ${orderSql} LIMIT ?`,
          )
          .all(matchExpr, ...scopeParams, SEARCH_POOL) as Array<Row & { bm25: number }>)
      : [];

    const candidates: Candidate[] = ftsRows.map((r) => ({ entry: toEntry(r), textScore: r.bm25 }));

    // match and recency want matches only; the recent-pool padding below is hybrid's.
    if ((q.rank ?? "hybrid") !== "hybrid") return candidates;

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

  async findOpenPre(match: SpineMatch): Promise<LedgerEntry | null> {
    const row = this.db
      .prepare(
        `SELECT p.* FROM entries p
         WHERE p.kind = 'spine_tool'
           AND p.project = ?
           AND p.session_id IS ?
           AND p.tool_name = ?
           AND json_extract(p.payload, '$.phase') = 'pre'
           AND json_extract(p.payload, '$.args_digest') = ?
           AND NOT EXISTS (SELECT 1 FROM entries q WHERE q.ref_entry_id = p.id AND q.source = 'hook_spine')
         ORDER BY p.id DESC LIMIT 1`,
      )
      .get(match.project, match.sessionId, match.tool, match.argsDigest) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  async findLatestPost(match: SpineMatch): Promise<LedgerEntry | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE kind = 'spine_tool'
           AND project = ?
           AND session_id IS ?
           AND tool_name = ?
           AND json_extract(payload, '$.phase') = 'post'
           AND json_extract(payload, '$.args_digest') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(match.project, match.sessionId, match.tool, match.argsDigest) as Row | undefined;
    return row ? toEntry(row) : null;
  }

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

  async countProjects(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT project) c FROM entries WHERE source = 'self_report'")
      .get() as { c: number };
    return row.c;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT project, COUNT(*) AS entries, MAX(created_at) AS last_written
           FROM entries
          WHERE source = 'self_report'
          GROUP BY project
          ORDER BY entries DESC, project ASC`,
      )
      .all() as Array<{ project: string; entries: number; last_written: string }>;
    return rows.map((r) => ({
      project: r.project,
      entries: r.entries,
      lastWritten: r.last_written,
    }));
  }

  /** Seed `projects` from whatever slugs the denormalized column already holds (idempotent). */
  private backfillProjects(): void {
    const rows = this.db
      .prepare("SELECT DISTINCT project FROM entries WHERE project NOT IN (SELECT slug FROM projects)")
      .all() as Array<{ project: string }>;
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO projects (id, slug, label, created_at) VALUES (?,?,NULL,?)",
    );
    const now = new Date().toISOString();
    for (const r of rows) ins.run(ulid(), r.project, now);
  }

  async ensureProject(slug: string, label?: string): Promise<string> {
    const found = this.db.prepare("SELECT id FROM projects WHERE slug=?").get(slug) as
      | { id: string }
      | undefined;
    if (found) return found.id;
    const id = ulid();
    this.db
      .prepare("INSERT INTO projects (id, slug, label, created_at) VALUES (?,?,?,?)")
      .run(id, slug, label ?? null, new Date().toISOString());
    return id;
  }

  async startSession(input: {
    project: string;
    externalId: string;
    agent?: string;
    task?: string;
  }): Promise<string> {
    const projectId = await this.ensureProject(input.project);
    // Re-entering the same host session (SessionStart can fire more than once per session,
    // e.g. on resume) must not fork it — the external id is the identity.
    const existing = this.db
      .prepare("SELECT external_id FROM sessions WHERE external_id=?")
      .get(input.externalId) as { external_id: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE sessions SET ended_at=NULL WHERE external_id=?").run(input.externalId);
      return existing.external_id;
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, external_id, agent, task, started_at, ended_at)
         VALUES (?,?,?,?,?,?,NULL)`,
      )
      .run(ulid(), projectId, input.externalId, input.agent ?? null, input.task ?? null, new Date().toISOString());
    return input.externalId;
  }

  async endSession(externalId: string): Promise<void> {
    this.db
      .prepare("UPDATE sessions SET ended_at=? WHERE external_id=? AND ended_at IS NULL")
      .run(new Date().toISOString(), externalId);
  }

  /**
   * The most recently started still-open session for a project, as its external id.
   *
   * This is what lets a write from the MCP server — which cannot see the host session —
   * stamp the REAL session id instead of a per-process `proc-<ulid>` proxy.
   */
  async resolveSessionId(project: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT s.external_id AS ext
           FROM sessions s JOIN projects p ON p.id = s.project_id
          WHERE p.slug = ? AND s.ended_at IS NULL AND s.external_id IS NOT NULL
          ORDER BY s.started_at DESC, s.id DESC
          LIMIT 1`,
      )
      .get(project) as { ext: string } | undefined;
    return row?.ext ?? null;
  }

  async getNudgeCounts(project: string, sessionId: string | null): Promise<NudgeCounts> {
    const one = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { c: number }).c;
    const since = (ms: number): string => new Date(Date.now() - ms).toISOString();

    const projectEntryCount = one(
      "SELECT COUNT(*) c FROM entries WHERE source='self_report' AND project=?",
      project,
    );

    // Self-reports carry the MCP server's proc-<ulid>, never this session id, so this
    // is deliberately a project+recency proxy rather than a session join (see NudgeCounts).
    const recentSelfReports = one(
      "SELECT COUNT(*) c FROM entries WHERE source='self_report' AND project=? AND created_at > ?",
      project,
      since(ACTIVITY_WINDOW_MS),
    );

    // Same mismatch: recall_events is written by the server process. Session first (in case
    // a caller ever passes a real id), then the project-recency fallback that actually fires.
    const recallFired =
      (sessionId
        ? one("SELECT COUNT(*) c FROM recall_events WHERE session_id=?", sessionId)
        : 0) > 0 ||
      one(
        "SELECT COUNT(*) c FROM recall_events WHERE project=? AND created_at > ?",
        project,
        since(RECALL_RECENCY_MS),
      ) > 0;

    // Spine rows DO carry the host session id, so these two are genuine session counts.
    const sessionToolCalls = sessionId
      ? one(
          `SELECT COUNT(*) c FROM entries
            WHERE source='hook_spine' AND kind='spine_tool' AND session_id=?
              AND json_extract(payload,'$.phase')='pre'`,
          sessionId,
        )
      : 0;

    // Time-bounded on purpose: an unbounded session count treats two `git status` calls an
    // hour apart as evidence of being stuck, which false-positives on any normal TDD loop.
    const recentRetries = sessionId
      ? one(
          `SELECT COUNT(*) c FROM entries
            WHERE source='hook_spine' AND session_id=? AND created_at > ?
              AND json_extract(payload,'$.retry_of') IS NOT NULL`,
          sessionId,
          since(RETRY_WINDOW_MS),
        )
      : 0;

    // Scoped by project as well as session: at user scope the hook resolves the project
    // from the cwd basename, so one session can legitimately span two corpora.
    const alreadyNudged = sessionId
      ? (
          this.db
            .prepare(
              `SELECT title FROM entries
                WHERE source='hook_spine' AND kind='spine_lifecycle'
                  AND session_id=? AND project=? AND title LIKE 'nudge:%'`,
            )
            .all(sessionId, project) as Array<{ title: string }>
        ).map((r) => r.title.slice("nudge:".length))
      : [];

    return {
      projectEntryCount,
      recentSelfReports,
      sessionToolCalls,
      recentRetries,
      recallFired,
      alreadyNudged,
    };
  }

  async markNudged(project: string, sessionId: string | null, kind: string): Promise<void> {
    if (!sessionId) return; // no session ⇒ no fire-once bookkeeping is possible
    await this.insertEntry({
      kind: "spine_lifecycle" as AnyKind,
      project,
      title: `nudge:${kind}`,
      body: "",
      payload: { event: "nudge", reason: kind },
      source: "hook_spine",
      sessionId,
    });
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

  async close(): Promise<void> {
    this.db.close();
  }
}
