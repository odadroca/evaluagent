import type { Candidate, LedgerEntry, LedgerQuery, NewEntry } from "../domain/entry.js";
import type { NewRecallEvent, RecallEvent } from "../domain/recall-event.js";

/** One project's browse-face summary: what exists, how much, and how fresh. */
export interface ProjectSummary {
  project: string;
  entries: number;
  lastWritten: string;
}

/**
 * Counts the hook bridge needs to decide whether to nudge. Gathered in one pass.
 *
 * NOTE ON SESSION IDENTITY — the hook sees the real Claude Code `session_id`, but
 * everything written through the MCP server (self-reports, recall events) is stamped
 * with that server process's `proc-<ulid>` instead. The two never match: across the
 * whole live corpus exactly one session id is shared between the sources. So only
 * spine-derived counts may join on session; anything touching self-reports or recall
 * events has to fall back to "recently, in this project". The real fix is the unbuilt
 * `sessions.external_id` from the architecture doc.
 */
export interface NudgeCounts {
  projectEntryCount: number;
  /** self-reports written to this project recently — NOT session-joined; see note above. */
  recentSelfReports: number;
  /** spine tool invocations this session. Session-joined and reliable. */
  sessionToolCalls: number;
  /** spine retries in this session, time-bounded so it means "stuck now", not "ever". */
  recentRetries: number;
  recallFired: boolean;
  alreadyNudged: string[];
}

/** Non-ranked filter for analysis reads (`ledger_query`), including a time range. */
export interface EntryFilter {
  project?: string;
  source?: string;
  kinds?: string[];
  since?: string;
  until?: string;
  limit?: number;
}

/** Identifies a specific tool invocation across separate hook processes. */
export interface SpineMatch {
  project: string;
  sessionId: string | null;
  tool: string;
  argsDigest: string;
}

/**
 * Storage seam. Async on purpose so a future Postgres (+ pgvector) implementation
 * is a drop-in with no change to the service or gateways above it.
 */
export interface LedgerRepository {
  insertEntry(entry: NewEntry): Promise<LedgerEntry>;
  getEntry(id: string): Promise<LedgerEntry | null>;
  query(q: LedgerQuery): Promise<LedgerEntry[]>;
  /** FTS-aware candidate fetch for match/hybrid ranking. */
  search(q: LedgerQuery): Promise<Candidate[]>;
  /** The most recent `pre` spine entry for a tool invocation not yet linked to a post. */
  findOpenPre(match: SpineMatch): Promise<LedgerEntry | null>;
  /** The most recent `post` spine entry for a tool invocation (for retry detection). */
  findLatestPost(match: SpineMatch): Promise<LedgerEntry | null>;
  /** Log one recall invocation (query + returned ids/ranks) for T2/T3 measurement. */
  insertRecallEvent(e: NewRecallEvent): Promise<RecallEvent>;
  /** Recall events for a project, newest first. */
  listRecallEvents(project: string, limit?: number): Promise<RecallEvent[]>;
  /** Distinct projects among self_report entries (scope-visibility metadata). */
  countProjects(): Promise<number>;
  /**
   * Every self_report project with its entry count and newest write, busiest first.
   * Without this, `countProjects` only tells a caller how much it cannot see.
   */
  listProjects(): Promise<ProjectSummary[]>;
  /** Ensure a project row exists for a slug; returns its stable id. */
  ensureProject(slug: string, label?: string): Promise<string>;
  /** Open (or re-open) a session keyed by the host session id. Returns that external id. */
  startSession(input: { project: string; externalId: string; agent?: string; task?: string }): Promise<string>;
  /** Close a session by its host session id. */
  endSession(externalId: string): Promise<void>;
  /**
   * The open session's host id for a project, or null.
   * Lets an MCP-server write stamp the REAL session id rather than a proc-<ulid> proxy.
   */
  resolveSessionId(project: string): Promise<string | null>;
  /** Rename a project everywhere, or merge it into an existing one (destructive — explicit only). */
  renameProject(from: string, to: string, merge: boolean): Promise<{ entries: number; recallEvents: number; merged: boolean }>;
  /** One session's entries, self-report and spine interleaved, oldest first. */
  getSessionTimeline(sessionId: string, limit?: number): Promise<LedgerEntry[]>;
  /** Non-ranked filtered read for analysis. Deliberately NOT logged as a recall event. */
  queryEntries(f: EntryFilter): Promise<LedgerEntry[]>;
  /** One-pass counts for the hook bridge's nudge decision (runs per tool call — keep it cheap). */
  getNudgeCounts(project: string, sessionId: string | null): Promise<NudgeCounts>;
  /** Remember that a nudge kind fired this session, so it fires at most once. */
  markNudged(project: string, sessionId: string | null, kind: string): Promise<void>;
  /** Map of entry id → ids of self_report entries whose ref_entry_id points at it. */
  findReferrers(ids: string[]): Promise<Record<string, string[]>>;
  close(): Promise<void>;
}
