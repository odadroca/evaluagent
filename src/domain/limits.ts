/** Default page size when no (valid) limit is supplied. */
export const DEFAULT_LIMIT = 20;
/** Defensive ceiling at the storage boundary (protects SQLite from huge LIMITs). */
export const HARD_MAX_LIMIT = 1000;
/** The advertised recall_reasoning contract ceiling. */
export const RECALL_MAX_LIMIT = 100;

/**
 * Clamp an untrusted limit to a safe positive integer. Missing / non-numeric /
 * zero / negative all fall back to the default — crucially, a negative value is
 * never forwarded to SQLite (where a negative LIMIT means "no limit").
 */
export function clampLimit(value: unknown, max = HARD_MAX_LIMIT, def = DEFAULT_LIMIT): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  const floored = Math.floor(n);
  if (floored < 1) return def;
  return Math.min(floored, max);
}
