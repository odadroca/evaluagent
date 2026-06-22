import type { LedgerEntry, LedgerQuery, NewEntry } from "../domain/entry.js";

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
  /** The most recent `pre` spine entry for a tool invocation not yet linked to a post. */
  findOpenPre(match: SpineMatch): Promise<LedgerEntry | null>;
  /** The most recent `post` spine entry for a tool invocation (for retry detection). */
  findLatestPost(match: SpineMatch): Promise<LedgerEntry | null>;
  close(): Promise<void>;
}
