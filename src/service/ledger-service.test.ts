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
    expect(out.map((e) => e.title)).toEqual(["second", "first"]);
  });

  it("clamps the limit (a negative limit never returns the whole ledger)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    for (let i = 0; i < 3; i++) await s.record({ ...surprise, title: `e${i}` });
    expect(await s.recall({ limit: 1 })).toHaveLength(1);
    // -1 must not become an unbounded SQLite LIMIT; it falls back to the default.
    expect(await s.recall({ limit: -1 })).toHaveLength(3);
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
    expect(out.map((e) => e.title)).toEqual(["lesson"]);
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
    expect(out.map((e) => e.title)).toEqual(["PreToolUse: Edit"]);
  });

  it("explicit rank:recency preserves insertion order (newest first)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "older-high-salience", salience: 3 });
    await s.record({ ...surprise, title: "newer-no-salience", salience: 0 });
    const out = await s.recall({ rank: "recency" });
    expect(out.map((e) => e.title)).toEqual(["newer-no-salience", "older-high-salience"]);
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
    expect(out[0]!.title).toContain("hooks hot-reload");
  });

  it("match mode can be empty", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "alpha", body: "beta" });
    expect(await s.recall({ rank: "match", text: "zzzzz" })).toHaveLength(0);
  });

  it("recency mode preserves insertion order (unchanged behavior)", async () => {
    const s = svc({ defaultProject: "evaluagent" });
    await s.record({ ...surprise, title: "first" });
    await s.record({ ...surprise, title: "second" });
    expect((await s.recall({ rank: "recency" })).map((e) => e.title)).toEqual(["second", "first"]);
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
