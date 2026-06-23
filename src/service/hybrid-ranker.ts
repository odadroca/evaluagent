import type { Ranker } from "../repo/ranker.js";
import type { Candidate, LedgerEntry, LedgerQuery, RankMode } from "../domain/entry.js";
import { clampLimit, RECALL_MAX_LIMIT } from "../domain/limits.js";

const WEIGHTS = { text: 0.5, recency: 0.25, salience: 0.15, tag: 0.1 };
const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

/** id DESC = most-recent-first (ulids are time-sortable). */
function byIdDesc(a: Candidate, b: Candidate): number {
  return a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0;
}

/**
 * Clamp salience to the documented 0..3 range. Stored values aren't trusted here — legacy
 * rows may hold non-numeric junk — so coerce and require finiteness, defaulting to 0,
 * before clamping (a NaN would otherwise poison the whole hybrid score).
 */
function clampSalience(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(3, Math.max(0, n));
}

export class HybridRanker implements Ranker {
  constructor(private readonly now: () => number = () => Date.now()) {}

  rank(q: LedgerQuery, candidates: Candidate[]): LedgerEntry[] {
    const mode: RankMode = q.rank ?? "hybrid";
    const limit = clampLimit(q.limit, RECALL_MAX_LIMIT);

    if (mode === "recency") {
      return [...candidates].sort(byIdDesc).slice(0, limit).map((c) => c.entry);
    }

    // Normalize text from raw bm25 (lower=better) via min-max over matches → [0,1], higher=better.
    const matched = candidates.filter((c) => c.textScore !== null);
    const vals = matched.map((c) => -(c.textScore as number));
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 0;
    const textOf = (c: Candidate): number => {
      if (c.textScore === null) return 0;
      if (matched.length === 1 || max === min) return 1;
      return (-(c.textScore) - min) / (max - min);
    };

    if (mode === "match") {
      return matched
        .map((c) => ({ c, text: textOf(c) }))
        .sort(
          (a, b) =>
            b.text - a.text ||
            clampSalience(b.c.entry.salience) - clampSalience(a.c.entry.salience) ||
            byIdDesc(a.c, b.c),
        )
        .slice(0, limit)
        .map((x) => x.c.entry);
    }

    // hybrid
    const nowMs = this.now();
    const qTags = (q.tags ?? []).map((t) => t.toLowerCase());
    const scoreOf = (c: Candidate): number => {
      const text = textOf(c);
      const ageDays = Math.max(0, (nowMs - Date.parse(c.entry.createdAt)) / DAY_MS);
      const recency = Math.exp(-ageDays / HALF_LIFE_DAYS);
      const salience = clampSalience(c.entry.salience) / 3;
      const tag =
        qTags.length === 0
          ? 0
          : c.entry.tags.filter((t) => qTags.includes(t.toLowerCase())).length / qTags.length;
      return WEIGHTS.text * text + WEIGHTS.recency * recency + WEIGHTS.salience * salience + WEIGHTS.tag * tag;
    };
    return [...candidates]
      .map((c) => ({ c, s: scoreOf(c) }))
      .sort((a, b) => b.s - a.s || byIdDesc(a.c, b.c))
      .slice(0, limit)
      .map((x) => x.c.entry);
  }
}
