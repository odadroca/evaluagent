import { describe, it, expect } from "vitest";
import { clampLimit, DEFAULT_LIMIT, HARD_MAX_LIMIT, RECALL_MAX_LIMIT } from "./limits.js";

describe("clampLimit", () => {
  it("defaults when the value is missing or not a number", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("abc")).toBe(DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
  });

  it("defaults on zero or negative values (never an unbounded LIMIT)", () => {
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-1)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-1000000)).toBe(DEFAULT_LIMIT);
  });

  it("passes through valid positive values, floored", () => {
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(2.7)).toBe(2);
    expect(clampLimit("8")).toBe(8);
  });

  it("caps at the hard max by default", () => {
    expect(clampLimit(1_000_000)).toBe(HARD_MAX_LIMIT);
  });

  it("caps at a custom max (the recall contract is 100)", () => {
    expect(clampLimit(1_000_000, RECALL_MAX_LIMIT)).toBe(RECALL_MAX_LIMIT);
    expect(clampLimit(50, RECALL_MAX_LIMIT)).toBe(50);
  });
});
