import type { LedgerEntry, LedgerQuery } from "../domain/entry.js";

/**
 * Scoring/ordering seam. The repository scope-filters into a candidate set; the
 * Ranker orders it. v1 ships SimpleRanker (recency); SemanticRanker drops in
 * later without changing this interface.
 */
export interface Ranker {
  rank(q: LedgerQuery, candidates: LedgerEntry[]): LedgerEntry[];
}
