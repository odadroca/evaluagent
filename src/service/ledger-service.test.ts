import { describe, it, expect, afterEach } from "vitest";
import { LedgerService, LedgerValidationError } from "./ledger-service.js";
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";

let repo: SqliteRepository;

function svc(opts: { defaultProject?: string } = {}) {
  repo = new SqliteRepository(":memory:");
  return new LedgerService({ repo, defaultProject: opts.defaultProject });
}

const surprise = {
  kind: "surprise",
  title: "expected react, found php",
  body: "vanilla php app, not a component library",
  payload: { expected: "react", actual: "php", magnitude: 2 },
};

afterEach(async () => {
  await repo?.close();
});

describe("LedgerService.record", () => {
  it("stores a valid entry and returns it with an id", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const e = await s.record(surprise);
    expect(e.id).toBeTruthy();
    expect(e.project).toBe("evaluagent");
    expect(e.kind).toBe("surprise");
  });

  it("rejects an unknown kind", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await expect(s.record({ ...surprise, kind: "nonsense" })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
  });

  it("rejects an invalid payload for the kind", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await expect(s.record({ ...surprise, payload: { expected: "x" } })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
  });

  it("defaults the project from the configured default", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const e = await s.record(surprise);
    expect(e.project).toBe("evaluagent");
  });

  it("requires a project when no default is configured", async () => {
    const s = svc();
    await expect(s.record(surprise)).rejects.toBeInstanceOf(LedgerValidationError);
  });

  it("uses an explicit project over the default", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const e = await s.record({ ...surprise, project: "other" });
    expect(e.project).toBe("other");
  });

  it("requires a confidence score in [0,1] for the confidence kind", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const conf = {
      kind: "confidence",
      title: "storage backend",
      body: "picked sqlite",
      payload: { decision: "storage backend", chosen: "sqlite" },
    };
    await expect(s.record(conf)).rejects.toBeInstanceOf(LedgerValidationError);
    await expect(s.record({ ...conf, confidence: 1.5 })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    const ok = await s.record({ ...conf, confidence: 0.8 });
    expect(ok.confidence).toBe(0.8);
  });

  it("rejects an out-of-range confidence on any kind", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await expect(s.record({ ...surprise, confidence: 2 })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
  });

  it("requires a non-empty title and body", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await expect(s.record({ ...surprise, title: "  " })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    await expect(s.record({ ...surprise, body: "" })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
  });
});

describe("LedgerService.recall", () => {
  it("returns entries most-recent-first for a project", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "first" });
    await s.record({ ...surprise, title: "second" });
    const out = await s.recall({});
    expect(out.map((e) => e.title)).toEqual(["second", "first"]);
  });

  it("passes kind filters through to the query", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "s" });
    await s.record({
      kind: "dead_end",
      title: "d",
      body: "an approach failed",
      payload: { approach: "a", reason: "r", signal: "x", recoverable: true },
    });
    const out = await s.recall({ kinds: ["dead_end"] });
    expect(out.map((e) => e.title)).toEqual(["d"]);
  });
});
