import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { SqliteRepository } from "./sqlite-repository.js";

let repo: SqliteRepository;

function makeRepo() {
  repo = new SqliteRepository(":memory:");
  return repo;
}

function newEntry(over: Record<string, unknown> = {}) {
  return {
    kind: "surprise" as const,
    project: "evaluagent",
    title: "expected react, found php",
    body: "the repo was vanilla php, not a component library",
    payload: { expected: "react", actual: "php", magnitude: 2 },
    tags: ["scope", "assumption"],
    confidence: 0.7,
    salience: 2,
    ...over,
  };
}

afterEach(async () => {
  await repo?.close();
});

describe("SqliteRepository", () => {
  it("round-trips an inserted entry through getEntry", async () => {
    const r = makeRepo();
    const saved = await r.insertEntry(newEntry());

    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = await r.getEntry(saved.id);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("surprise");
    expect(got!.project).toBe("evaluagent");
    expect(got!.title).toBe("expected react, found php");
    expect(got!.payload).toEqual({ expected: "react", actual: "php", magnitude: 2 });
    expect(got!.tags).toEqual(["scope", "assumption"]);
    expect(got!.confidence).toBe(0.7);
    expect(got!.salience).toBe(2);
  });

  it("returns null for an unknown id", async () => {
    const r = makeRepo();
    expect(await r.getEntry("does-not-exist")).toBeNull();
  });

  it("queries most-recent-first", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "first" }));
    await r.insertEntry(newEntry({ title: "second" }));
    await r.insertEntry(newEntry({ title: "third" }));

    const out = await r.query({ project: "evaluagent" });
    expect(out.map((e) => e.title)).toEqual(["third", "second", "first"]);
  });

  it("isolates entries by project", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ project: "evaluagent", title: "mine" }));
    await r.insertEntry(newEntry({ project: "other-repo", title: "theirs" }));

    const out = await r.query({ project: "evaluagent" });
    expect(out.map((e) => e.title)).toEqual(["mine"]);
  });

  it("filters by kind", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ kind: "surprise", title: "s" }));
    await r.insertEntry(
      newEntry({
        kind: "dead_end",
        title: "d",
        payload: { approach: "a", reason: "r", signal: "x", recoverable: true },
      }),
    );

    const out = await r.query({ project: "evaluagent", kinds: ["dead_end"] });
    expect(out.map((e) => e.title)).toEqual(["d"]);
  });

  it("matches free text in title or body", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "sqlite decision", body: "chose sqlite" }));
    await r.insertEntry(newEntry({ title: "unrelated", body: "something else" }));

    const out = await r.query({ project: "evaluagent", text: "sqlite" });
    expect(out.map((e) => e.title)).toEqual(["sqlite decision"]);
  });

  it("respects the limit", async () => {
    const r = makeRepo();
    for (let i = 0; i < 5; i++) await r.insertEntry(newEntry({ title: `e${i}` }));
    const out = await r.query({ project: "evaluagent", limit: 2 });
    expect(out).toHaveLength(2);
  });
});

describe("SqliteRepository FTS index", () => {
  // Helper reaching into the raw db to assert FTS rows match.
  function ftsHits(r: SqliteRepository, match: string): number {
    // @ts-expect-error access private db for a white-box index assertion
    const db = r.db as import("better-sqlite3").Database;
    return (db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH ?").get(match) as { c: number }).c;
  }

  it("indexes inserted entries for full-text + stemmed match", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "the server is running", body: "vite dev" }));
    expect(ftsHits(r, '"running"')).toBe(1);
    expect(ftsHits(r, '"run"')).toBe(1); // porter stemming
    expect(ftsHits(r, '"absent"')).toBe(0);
  });

  it("backfills pre-existing rows on open (rebuild)", async () => {
    const path = `${tmpdir()}/evg-fts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`;
    // Seed an entry, then drop the FTS index to simulate an old DB without FTS.
    const first = new SqliteRepository(path);
    await first.insertEntry(newEntry({ title: "backfilled lesson", body: "x" }));
    // @ts-expect-error white-box
    (first.db as import("better-sqlite3").Database).exec("DROP TABLE entries_fts");
    await first.close();

    const reopened = new SqliteRepository(path); // constructor must rebuild FTS
    // @ts-expect-error white-box
    const db = reopened.db as import("better-sqlite3").Database;
    const hits = (db.prepare("SELECT count(*) c FROM entries_fts WHERE entries_fts MATCH ?").get('"backfilled"') as { c: number }).c;
    expect(hits).toBe(1);
    await reopened.close();
  });
});

describe("SqliteRepository.search", () => {
  it("match: OR-joins terms so any term hits, scored by bm25", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "hooks hot-reload", body: "claude code mcp add" }));
    await r.insertEntry(newEntry({ title: "unrelated", body: "nothing here" }));
    const out = await r.search({ project: "evaluagent", rank: "match", text: "hooks restart mcp" });
    expect(out.map((c) => c.entry.title)).toEqual(["hooks hot-reload"]);
    expect(typeof out[0]!.textScore).toBe("number");
  });

  it("match: returns empty when no term matches", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "alpha", body: "beta" }));
    expect(await r.search({ project: "evaluagent", rank: "match", text: "zzz" })).toHaveLength(0);
  });

  it("hybrid: unions FTS matches with the recent pool (never empty when entries exist)", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "alpha", body: "beta" }));
    const out = await r.search({ project: "evaluagent", rank: "hybrid", text: "zzz" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.textScore === null)).toBe(true); // no FTS hit → recency pool only
  });

  it("scopes by project and source", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ project: "evaluagent", title: "mine hooks" }));
    await r.insertEntry(newEntry({ project: "other", title: "theirs hooks" }));
    const out = await r.search({ project: "evaluagent", rank: "match", text: "hooks" });
    expect(out.map((c) => c.entry.title)).toEqual(["mine hooks"]);
  });
});

describe("SqliteRepository spine support", () => {
  it("round-trips a spine entry with source and tool_name", async () => {
    const r = makeRepo();
    const saved = await r.insertEntry({
      kind: "spine_tool",
      project: "evaluagent",
      title: "PreToolUse: Edit",
      body: "about to run Edit",
      payload: { phase: "pre", tool: "Edit", args_digest: "sha256:abc" },
      source: "hook_spine",
      toolName: "Edit",
      sessionId: "sess-1",
    });
    expect(saved.source).toBe("hook_spine");
    expect(saved.toolName).toBe("Edit");

    const got = await r.getEntry(saved.id);
    expect(got!.kind).toBe("spine_tool");
    expect(got!.source).toBe("hook_spine");
    expect(got!.toolName).toBe("Edit");
    expect(got!.sessionId).toBe("sess-1");
    expect(got!.payload).toEqual({ phase: "pre", tool: "Edit", args_digest: "sha256:abc" });
  });

  it("defaults source to self_report and tool_name to null for ordinary entries", async () => {
    const r = makeRepo();
    const saved = await r.insertEntry(newEntry());
    expect(saved.source).toBe("self_report");
    expect(saved.toolName).toBeNull();
  });

  it("filters by source", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ title: "self" }));
    await r.insertEntry({
      kind: "spine_tool",
      project: "evaluagent",
      title: "spine",
      body: "b",
      payload: { phase: "pre" },
      source: "hook_spine",
      toolName: "Edit",
    });
    const out = await r.query({ project: "evaluagent", source: "self_report" });
    expect(out.map((e) => e.title)).toEqual(["self"]);
  });
});

describe("recall events", () => {
  it("inserts and lists recall events newest-first with round-tripped JSON", async () => {
    const repo = new SqliteRepository(":memory:");
    const first = await repo.insertRecallEvent({
      project: "p",
      sessionId: "proc-A",
      query: { text: "hooks restart", rank: "hybrid", source: "self_report", limit: 10 },
      returned: [{ entry_id: "01AAA", rank: 1 }, { entry_id: "01BBB", rank: 2 }],
    });
    await repo.insertRecallEvent({
      project: "p",
      query: { rank: "recency", source: "self_report", limit: 5 },
      returned: [],
    });

    expect(first.id).toBeTruthy();
    expect(first.resultCount).toBe(2);

    const events = await repo.listRecallEvents("p");
    expect(events).toHaveLength(2);
    expect(events[0].query.rank).toBe("recency"); // newest first
    expect(events[0].sessionId).toBeNull();
    expect(events[1].returned).toEqual([{ entry_id: "01AAA", rank: 1 }, { entry_id: "01BBB", rank: 2 }]);
    expect(events[1].query.text).toBe("hooks restart");
  });

  it("scopes listRecallEvents by project", async () => {
    const repo = new SqliteRepository(":memory:");
    await repo.insertRecallEvent({ project: "a", query: { rank: "hybrid", source: "self_report", limit: 10 }, returned: [] });
    expect(await repo.listRecallEvents("b")).toEqual([]);
  });
});

describe("SqliteRepository.findOpenPre", () => {
  it("only a spine post closes an open pre — a self-report ref must not close it", async () => {
    const r = makeRepo();
    const pre = await r.insertEntry({
      kind: "spine_tool",
      project: "evaluagent",
      title: "PreToolUse: Edit",
      body: "about to run Edit",
      payload: { phase: "pre", args_digest: "d" },
      source: "hook_spine",
      toolName: "Edit",
    });

    const match = { project: "evaluagent", sessionId: null, tool: "Edit", argsDigest: "d" };
    expect((await r.findOpenPre(match))?.id).toBe(pre.id);

    // A self_report entry referencing the pre must NOT count as closing it.
    await r.insertEntry({
      kind: "friction",
      project: "evaluagent",
      title: "unrelated self report",
      body: "b",
      payload: { where: "x", kind: "tooling", intensity: 1 },
      source: "self_report",
      refEntryId: pre.id,
    });
    expect((await r.findOpenPre(match))?.id).toBe(pre.id);

    // A spine post referencing the pre DOES close it.
    await r.insertEntry({
      kind: "spine_tool",
      project: "evaluagent",
      title: "PostToolUse: Edit",
      body: "finished Edit",
      payload: { phase: "post", args_digest: "d" },
      source: "hook_spine",
      toolName: "Edit",
      refEntryId: pre.id,
    });
    expect(await r.findOpenPre(match)).toBeNull();
  });
});

describe("countProjects and findReferrers", () => {
  it("counts distinct self_report projects only", async () => {
    const repo = new SqliteRepository(":memory:");
    await repo.insertEntry({ kind: "friction", project: "a", title: "t", body: "b", payload: {} });
    await repo.insertEntry({ kind: "friction", project: "b", title: "t", body: "b", payload: {} });
    await repo.insertEntry({ kind: "spine_tool", project: "c", title: "t", body: "b", payload: {}, source: "hook_spine" });
    expect(await repo.countProjects()).toBe(2);
  });

  it("maps referenced ids to self_report referrers, excluding spine refs", async () => {
    const repo = new SqliteRepository(":memory:");
    const old = await repo.insertEntry({ kind: "friction", project: "a", title: "t", body: "b", payload: {} });
    const fix = await repo.insertEntry({ kind: "friction", project: "a", title: "t2", body: "b", payload: {}, refEntryId: old.id });
    await repo.insertEntry({ kind: "spine_tool", project: "a", title: "post", body: "b", payload: {}, source: "hook_spine", refEntryId: old.id });
    const map = await repo.findReferrers([old.id, fix.id]);
    expect(map[old.id]).toEqual([fix.id]);
    expect(map[fix.id]).toBeUndefined();
    expect(await repo.findReferrers([])).toEqual({});
  });
});

describe("SqliteRepository.listProjects", () => {
  it("returns each self_report project with its entry count and newest write, busiest first", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ project: "alpha", title: "a1" }));
    await r.insertEntry(newEntry({ project: "alpha", title: "a2" }));
    await r.insertEntry(newEntry({ project: "beta", title: "b1" }));

    const projects = await r.listProjects();

    expect(projects.map((p) => p.project)).toEqual(["alpha", "beta"]);
    expect(projects[0]!.entries).toBe(2);
    expect(projects[1]!.entries).toBe(1);
    expect(projects[0]!.lastWritten).toBeTruthy();
  });

  it("excludes hook_spine rows so the browse face shows lessons, not tool noise", async () => {
    const r = makeRepo();
    await r.insertEntry(newEntry({ project: "alpha" }));
    await r.insertEntry({
      kind: "spine_tool" as never,
      project: "spine-only",
      title: "PreToolUse: Bash",
      body: "",
      payload: { phase: "pre", tool: "Bash" },
      source: "hook_spine",
    } as never);

    const projects = await r.listProjects();
    expect(projects.map((p) => p.project)).toEqual(["alpha"]);
  });

  it("returns an empty list on an empty store", async () => {
    expect(await makeRepo().listProjects()).toEqual([]);
  });
});
