import { describe, it, expect, afterEach, vi } from "vitest";
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

  it("rejects an out-of-range or non-integer salience", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await expect(s.record({ ...surprise, salience: 100 })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    await expect(s.record({ ...surprise, salience: -1 })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    await expect(s.record({ ...surprise, salience: 2.5 })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    const ok = await s.record({ ...surprise, salience: 2 });
    expect(ok.salience).toBe(2);
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
    expect(out.entries.map((e) => e.title)).toEqual(["second", "first"]);
  });

  it("clamps the limit (a negative limit never returns the whole ledger)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    for (let i = 0; i < 3; i++) await s.record({ ...surprise, title: `e${i}` });
    expect((await s.recall({ limit: 1 })).entries).toHaveLength(1);
    // -1 must not become an unbounded SQLite LIMIT; it falls back to the default.
    expect((await s.recall({ limit: -1 })).entries).toHaveLength(3);
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
    expect(out.entries.map((e) => e.title)).toEqual(["d"]);
  });
});

describe("LedgerService spine + recall scoping", () => {
  it("records a spine entry via recordSpine with source hook_spine", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const e = await s.recordSpine({
      kind: "spine_tool",
      title: "PreToolUse: Edit",
      body: "about to run Edit",
      toolName: "Edit",
      sessionId: "sess-1",
      payload: { phase: "pre", tool: "Edit" },
    });
    expect(e.source).toBe("hook_spine");
    expect(e.kind).toBe("spine_tool");
  });

  it("recall excludes spine entries by default", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "lesson" });
    await s.recordSpine({
      kind: "spine_tool",
      title: "PreToolUse: Edit",
      body: "x",
      payload: { phase: "pre" },
    });
    const out = await s.recall({});
    expect(out.entries.map((e) => e.title)).toEqual(["lesson"]);
  });

  it("recall can include spine entries when source is overridden", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.recordSpine({
      kind: "spine_tool",
      title: "PreToolUse: Edit",
      body: "x",
      payload: { phase: "pre" },
    });
    const out = await s.recall({ source: "hook_spine" });
    expect(out.entries.map((e) => e.title)).toEqual(["PreToolUse: Edit"]);
  });

  it("explicit rank:recency preserves insertion order (newest first)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "older-high-salience", salience: 3 });
    await s.record({ ...surprise, title: "newer-no-salience", salience: 0 });
    const out = await s.recall({ rank: "recency" });
    expect(out.entries.map((e) => e.title)).toEqual(["newer-no-salience", "older-high-salience"]);
  });
});

describe("LedgerService.recall (FTS + hybrid)", () => {
  it("hybrid (default) returns a relevant entry for a multi-word query that lacks a full match", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({
      kind: "surprise",
      title: "Claude Code hooks hot-reload, but mcp add does not",
      body: "writing hooks into settings took effect with no restart",
      payload: { expected: "restart needed", actual: "hot reload", magnitude: 2 },
    });
    await s.record({ ...surprise, title: "totally unrelated", body: "nothing relevant" });
    const out = await s.recall({ text: "hooks restart mcp" });
    expect(out.entries[0]!.title).toContain("hooks hot-reload");
  });

  it("match mode can be empty", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "alpha", body: "beta" });
    expect((await s.recall({ rank: "match", text: "zzzzz" })).entries).toHaveLength(0);
  });

  it("recency mode preserves insertion order (unchanged behavior)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "first" });
    await s.record({ ...surprise, title: "second" });
    expect((await s.recall({ rank: "recency" })).entries.map((e) => e.title)).toEqual(["second", "first"]);
  });

  it("recency+text keeps the newest match even when more than SEARCH_POOL entries match", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    // 200 older entries with strong bm25 for "alpha" (high term frequency, short docs)…
    for (let i = 0; i < 200; i++) {
      await s.record({ ...surprise, title: "alpha alpha alpha alpha alpha", body: "alpha alpha" });
    }
    // …then one newest entry that matches weakly (single occurrence, long body).
    const filler = "unrelated words padding the document so its bm25 score ranks last ".repeat(5);
    const newest = await s.record({ ...surprise, title: "one alpha only", body: filler });

    const out = await s.recall({ rank: "recency", text: "alpha", limit: 1 });
    expect(out.entries[0]!.id).toBe(newest.id);
  });
});

describe("LedgerService spine pre/post correlation", () => {
  const pre = {
    kind: "spine_tool" as const,
    title: "PreToolUse: Edit",
    body: "about to run Edit",
    toolName: "Edit",
    sessionId: "s1",
    payload: { phase: "pre", tool: "Edit", args_digest: "sha256:aaa" },
  };
  const post = {
    kind: "spine_tool" as const,
    title: "PostToolUse: Edit",
    body: "finished Edit",
    toolName: "Edit",
    sessionId: "s1",
    payload: { phase: "post", tool: "Edit", args_digest: "sha256:aaa", ok: true },
  };
  const payloadOf = (e: { payload: unknown }) => e.payload as Record<string, unknown>;

  it("links a post to its open pre and records a duration", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const recordedPre = await s.recordSpine(pre);
    const recordedPost = await s.recordSpine(post);

    expect(recordedPost.refEntryId).toBe(recordedPre.id);
    expect(typeof payloadOf(recordedPost).duration_ms).toBe("number");
    expect(payloadOf(recordedPost).duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("does not link a post when there is no matching pre", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const orphan = await s.recordSpine({
      ...post,
      payload: { phase: "post", tool: "Edit", args_digest: "sha256:zzz", ok: true },
    });
    expect(orphan.refEntryId).toBeNull();
    expect(payloadOf(orphan).duration_ms).toBeUndefined();
  });

  it("does not re-link the same pre to a second post", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    const recordedPre = await s.recordSpine(pre);
    const post1 = await s.recordSpine(post);
    const post2 = await s.recordSpine(post);
    expect(post1.refEntryId).toBe(recordedPre.id);
    expect(post2.refEntryId).toBeNull();
  });

  it("flags a repeated pre (same tool+args) as a retry of the prior post", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.recordSpine(pre);
    const post1 = await s.recordSpine(post);
    const pre2 = await s.recordSpine(pre);
    expect(payloadOf(pre2).retry_of).toBe(post1.id);
  });
});

describe("defaultSessionId stamping", () => {
  it("stamps record() writes that carry no sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.record({
      kind: "friction",
      title: "t",
      body: "b",
      payload: { where: "x", kind: "tooling", intensity: 1 },
    });
    expect(entry.sessionId).toBe("proc-TEST");
  });

  it("does not override an explicit sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.record({
      kind: "friction",
      title: "t",
      body: "b",
      payload: { where: "x", kind: "tooling", intensity: 1 },
      sessionId: "real-session",
    });
    expect(entry.sessionId).toBe("real-session");
  });

  it("stamps recordSpine() writes that carry no sessionId", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-TEST" });
    const entry = await service.recordSpine({ kind: "spine_lifecycle", title: "t", body: "b" });
    expect(entry.sessionId).toBe("proc-TEST");
  });
});

describe("recall-event logging", () => {
  it("logs the effective query and returned ids with ranks", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p", defaultSessionId: "proc-T" });
    const a = await service.record({ kind: "friction", title: "hooks restart pain", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.recall({ text: "hooks", limit: 5 });

    const events = await repo.listRecallEvents("p");
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("proc-T");
    expect(events[0].query).toEqual({ text: "hooks", rank: "hybrid", source: "self_report", limit: 5 });
    expect(events[0].returned[0]).toEqual({ entry_id: a.id, rank: 1 });
    expect(events[0].resultCount).toBeGreaterThanOrEqual(1);
  });

  it("a failing event insert does not fail the recall", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    await service.record({ kind: "friction", title: "t", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const boom = vi.spyOn(repo, "insertRecallEvent").mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = await service.recall({});
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(boom).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ref_entry_id on record", () => {
  it("stores a valid reference to an earlier entry", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const prior = await service.record({ kind: "friction", title: "t1", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const next = await service.record({
      kind: "friction", title: "t2", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 },
      refEntryId: prior.id,
    });
    expect(next.refEntryId).toBe(prior.id);
  });

  it("rejects a reference to a non-existent entry", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    await expect(
      service.record({
        kind: "friction", title: "t", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 },
        refEntryId: "01NOPE",
      }),
    ).rejects.toThrow(/ref_entry_id/);
  });

  it("rejects a non-string ref_entry_id before it reaches the repo", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    await expect(
      service.record({
        kind: "friction", title: "t", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 },
        refEntryId: 42 as never,
      }),
    ).rejects.toThrow(/ref_entry_id must be a string/);
  });
});

describe("RecallResult envelope", () => {
  it("returns entries with scope metadata and referrer links", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const old = await service.record({ kind: "friction", title: "old", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.record({ kind: "friction", title: "new", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 }, refEntryId: old.id });

    const result = await service.recall({});
    expect(result.scope.project).toBe("p");
    expect(result.scope.projectsTotal).toBe(1);
    expect(result.entries.length).toBe(2);
    expect(result.referrers[old.id]).toHaveLength(1);
  });
});

describe("recency + text", () => {
  it("multi-word text under rank=recency returns tokenized matches newest-first", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const a = await service.record({ kind: "friction", title: "hooks hot-reload works", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const b = await service.record({ kind: "friction", title: "mcp needs restart", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    await service.record({ kind: "friction", title: "unrelated", body: "nothing here", payload: { where: "x", kind: "tooling", intensity: 1 } });

    const result = await service.recall({ rank: "recency", text: "hooks restart mcp" });
    expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]); // both match, newest first
  });

  it("recency without text still returns everything newest-first", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const a = await service.record({ kind: "friction", title: "one", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const b = await service.record({ kind: "friction", title: "two", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const result = await service.recall({ rank: "recency" });
    expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("whitespace-only text under rank=recency must not false-empty", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "p" });
    const a = await service.record({ kind: "friction", title: "one", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const b = await service.record({ kind: "friction", title: "two", body: "b", payload: { where: "x", kind: "tooling", intensity: 1 } });
    const result = await service.recall({ rank: "recency", text: "   " });
    expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]);
  });
});
