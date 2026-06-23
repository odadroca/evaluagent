import Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import type { AnyKind, EntrySource, LedgerEntry, LedgerQuery, NewEntry } from "../../domain/entry.js";
import type { LedgerRepository, SpineMatch } from "../ledger-repository.js";
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

export class SqliteRepository implements LedgerRepository {
  private readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
    this.migrateColumns();
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
           AND NOT EXISTS (SELECT 1 FROM entries q WHERE q.ref_entry_id = p.id)
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

  async close(): Promise<void> {
    this.db.close();
  }
}
