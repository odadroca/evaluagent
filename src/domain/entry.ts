import type { EntryKind } from "./entry-kinds.js";
import type { SpineKind } from "./spine.js";

/** Any stored kind: the six self-report kinds plus the hook-bridge spine kinds. */
export type AnyKind = EntryKind | SpineKind;

/** Where an entry came from. */
export type EntrySource = "self_report" | "hook_spine";

/** Input to record a new entry. Identity/time are assigned by the repository. */
export interface NewEntry {
  kind: AnyKind;
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
  /** Defaults to "self_report" in the repository. */
  source?: EntrySource;
  /** Tool name for spine_tool entries; null otherwise. */
  toolName?: string | null;
  /** Link to another entry (e.g. a post spine entry → its pre). */
  refEntryId?: string | null;
}

/** A stored entry. */
export interface LedgerEntry {
  id: string;
  kind: AnyKind;
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
  source: EntrySource;
  toolName: string | null;
  refEntryId: string | null;
}

/** v1 ranking modes. The `Ranker` seam will add "match"/"hybrid"/"semantic" later. */
export type RankMode = "recency";

export interface LedgerQuery {
  project: string;
  kinds?: AnyKind[];
  /** Free-text match (LIKE in v1; FTS/semantic later). */
  text?: string;
  /** Restrict to self-report vs hook-spine entries. */
  source?: EntrySource;
  limit?: number;
  rank?: RankMode;
}
