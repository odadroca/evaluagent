import { describe, it, expect } from "vitest";
import { HybridRanker } from "./hybrid-ranker.js";
import type { Candidate, LedgerEntry } from "../domain/entry.js";

const NOW = Date.parse("2026-06-22T00:00:00.000Z");
const ranker = new HybridRanker(() => NOW);

let seq = 0;
function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `01_${String(seq).padStart(4, "0")}`,
    kind: "surprise",
    project: "evaluagent",
    title: "t",
    body: "b",
    payload: {},
    confidence: null,
    salience: 0,
    tags: [],
    sessionId: null,
    occurredAt: null,
    createdAt: "2026-06-22T00:00:00.000Z",
    source: "self_report",
    toolName: null,
    refEntryId: null,
    ...over,
  };
}
const cand = (e: LedgerEntry, textScore: number | null): Candidate => ({ entry: e, textScore });

describe("HybridRanker", () => {
  it("recency mode orders by id descending and ignores text", () => {
    const a = entry({ id: "01_0001" });
    const b = entry({ id: "01_0002" });
    const out = ranker.rank({ project: "p", rank: "recency" }, [cand(a, -5), cand(b, null)]);
    expect(out.map((e) => e.id)).toEqual(["01_0002", "01_0001"]);
  });

  it("match mode keeps only FTS matches, best bm25 first", () => {
    const a = entry({ title: "weak" });
    const b = entry({ title: "strong" });
    const c = entry({ title: "nomatch" });
    // bm25 lower = better, so b (-9) ranks above a (-1); c (null) dropped.
    const out = ranker.rank({ project: "p", rank: "match" }, [cand(a, -1), cand(b, -9), cand(c, null)]);
    expect(out.map((e) => e.title)).toEqual(["strong", "weak"]);
  });

  it("hybrid surfaces a strong text match above a recent non-match", () => {
    const recentNoMatch = entry({ title: "recent", createdAt: "2026-06-22T00:00:00.000Z" });
    const oldStrongMatch = entry({ title: "match", createdAt: "2026-06-01T00:00:00.000Z" });
    const out = ranker.rank({ project: "p", rank: "hybrid", text: "x" }, [
      cand(recentNoMatch, null),
      cand(oldStrongMatch, -9),
    ]);
    expect(out[0]!.title).toBe("match");
  });

  it("hybrid still returns recent entries when nothing matches (best-available)", () => {
    const a = entry({ id: "01_0001", createdAt: "2026-06-10T00:00:00.000Z" });
    const b = entry({ id: "01_0002", createdAt: "2026-06-21T00:00:00.000Z" });
    const out = ranker.rank({ project: "p", rank: "hybrid", text: "zzz" }, [cand(a, null), cand(b, null)]);
    expect(out.map((e) => e.id)).toEqual(["01_0002", "01_0001"]); // recency wins, no false-empty
  });

  it("hybrid boosts tag overlap", () => {
    const tagged = entry({ id: "01_0001", tags: ["fts", "search"] });
    const plain = entry({ id: "01_0002", tags: [] }); // newer id
    const out = ranker.rank({ project: "p", rank: "hybrid", tags: ["FTS"] }, [
      cand(plain, null),
      cand(tagged, null),
    ]);
    expect(out[0]!.id).toBe("01_0001"); // tag overlap beats the newer plain entry
  });

  it("respects the limit", () => {
    const cands = [entry(), entry(), entry()].map((e) => cand(e, null));
    expect(ranker.rank({ project: "p", rank: "hybrid", limit: 2 }, cands)).toHaveLength(2);
  });
});
