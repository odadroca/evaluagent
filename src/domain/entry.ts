import type { EntryKind } from "./entry-kinds.js";

/** Input to record a new entry. Identity/time are assigned by the repository. */
export interface NewEntry {
  kind: EntryKind;
  project: string;
  title: string;
  body: string;
  /** Kind-specific, schema-validated before it reaches the repository. */
  payload: unknown;
  confidence?: number | null;
  /** Author-rated "how worth remembering", 0..3. */
  salience?: number;
  tags?: string[];
  sessionId?: string | null;
  occurredAt?: string | null;
}

/** A stored entry. */
export interface LedgerEntry {
  id: string;
  kind: EntryKind;
  project: string;
  title: string;
  body: string;
  payload: unknown;
  confidence: number | null;
  salience: number;
  tags: string[];
  sessionId: string | null;
  occurredAt: string | null;
  createdAt: string;
}

/** v1 ranking modes. The `Ranker` seam will add "match"/"hybrid"/"semantic" later. */
export type RankMode = "recency";

export interface LedgerQuery {
  project: string;
  kinds?: EntryKind[];
  /** Free-text match (LIKE in v1; FTS/semantic later). */
  text?: string;
  limit?: number;
  rank?: RankMode;
}
