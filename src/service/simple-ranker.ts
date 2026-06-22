import type { Ranker } from "../repo/ranker.js";
import type { LedgerEntry, LedgerQuery } from "../domain/entry.js";

/**
 * v1 ranker. The only mode is "recency", and the repository already returns
 * candidates ordered most-recent-first (by ulid id DESC), so ranking is identity
 * here. The class exists to hold the seam: "match"/"hybrid"/"semantic" land here.
 */
export class SimpleRanker implements Ranker {
  rank(_q: LedgerQuery, candidates: LedgerEntry[]): LedgerEntry[] {
    return candidates;
  }
}
