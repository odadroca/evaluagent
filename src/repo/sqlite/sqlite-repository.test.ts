import { describe, it, expect, afterEach } from "vitest";
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
