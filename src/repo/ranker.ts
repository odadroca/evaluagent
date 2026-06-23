import type { Candidate, LedgerEntry, LedgerQuery } from "../domain/entry.js";

/**
 * Scoring/ordering seam. The repository scope-filters into a Candidate set; the
 * Ranker orders it. HybridRanker handles recency/match/hybrid; SemanticRanker
 * (Phase 6) drops into the same interface.
 */
export interface Ranker {
  rank(q: LedgerQuery, candidates: Candidate[]): LedgerEntry[];
}
