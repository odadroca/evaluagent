import type { LedgerEntry, LedgerQuery, NewEntry } from "../domain/entry.js";

/**
 * Storage seam. Async on purpose so a future Postgres (+ pgvector) implementation
 * is a drop-in with no change to the service or gateways above it.
 */
export interface LedgerRepository {
  insertEntry(entry: NewEntry): Promise<LedgerEntry>;
  getEntry(id: string): Promise<LedgerEntry | null>;
  query(q: LedgerQuery): Promise<LedgerEntry[]>;
  close(): Promise<void>;
}
