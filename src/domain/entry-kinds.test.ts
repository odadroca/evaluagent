import { describe, it, expect } from "vitest";
import { validatePayload, isEntryKind, ENTRY_KINDS } from "./entry-kinds.js";

describe("entry-kind payload validation", () => {
  it("accepts a valid surprise payload", () => {
    const r = validatePayload("surprise", {
      expected: "react repo",
      actual: "php app",
      magnitude: 3,
    });
    expect(r.valid).toBe(true);
  });

  it("rejects a surprise payload missing required fields", () => {
    expect(validatePayload("surprise", { expected: "x" }).valid).toBe(false);
  });

  it("accepts a valid dead_end payload", () => {
    expect(
      validatePayload("dead_end", {
        approach: "regex parse",
        reason: "nested quotes",
        signal: "test 7 failed",
        recoverable: true,
      }).valid,
    ).toBe(true);
  });

  it("accepts a valid confidence payload", () => {
    expect(
      validatePayload("confidence", {
        decision: "storage backend",
        chosen: "sqlite",
        options_considered: ["sqlite", "postgres"],
      }).valid,
    ).toBe(true);
  });

  it("accepts a valid abandoned_branch payload", () => {
    expect(
      validatePayload("abandoned_branch", {
        branch: "build own store",
        why_abandoned: "calane already has one",
        could_revisit: false,
      }).valid,
    ).toBe(true);
  });

  it("accepts a valid reconstruction payload", () => {
    expect(
      validatePayload("reconstruction", {
        what_was_lost: "auth flow understanding",
        cost: 2,
        how_recovered: "re-read 5 files",
      }).valid,
    ).toBe(true);
  });

  it("accepts a valid friction payload", () => {
    expect(
      validatePayload("friction", { where: "mcp wiring", kind: "tooling", intensity: 2 }).valid,
    ).toBe(true);
  });

  it("rejects an out-of-range magnitude", () => {
    expect(
      validatePayload("surprise", { expected: "x", actual: "y", magnitude: 9 }).valid,
    ).toBe(false);
  });

  it("rejects unknown additional properties", () => {
    expect(
      validatePayload("friction", { where: "x", kind: "tooling", intensity: 1, bogus: true })
        .valid,
    ).toBe(false);
  });

  it("rejects an unknown kind with a helpful error", () => {
    const r = validatePayload("nonsense", {});
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.join(" ")).toContain("nonsense");
  });

  it("exposes exactly the six introspective kinds", () => {
    expect([...ENTRY_KINDS].sort()).toEqual([
      "abandoned_branch",
      "confidence",
      "dead_end",
      "friction",
      "reconstruction",
      "surprise",
    ]);
    expect(isEntryKind("surprise")).toBe(true);
    expect(isEntryKind("spine_tool")).toBe(false);
  });
});
