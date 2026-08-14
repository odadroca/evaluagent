import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLedgerServer } from "./server.js";
import { LedgerService } from "../service/ledger-service.js";
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";

let repo: SqliteRepository;
let service: LedgerService;

async function connectedClient() {
  repo = new SqliteRepository(":memory:");
  service = new LedgerService({ repo, defaultProject: "evaluagent" });
  const server = createLedgerServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

// callTool's result is a wide union; narrow to the text block we assert on.
function textOf(result: any): string {
  const block = result.content?.find((c: { type: string }) => c.type === "text");
  return block?.text ?? "";
}

afterEach(async () => {
  await repo?.close();
});

describe("MCP ledger server", () => {
  it("advertises record_reasoning and recall_reasoning", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("record_reasoning");
    expect(names).toContain("recall_reasoning");
  });

  it("records an entry and recalls it back", async () => {
    const client = await connectedClient();

    const rec = await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise",
        title: "expected react, found php",
        body: "vanilla php app, not a component library",
        payload: { expected: "react", actual: "php", magnitude: 2 },
        tags: ["scope"],
      },
    });
    expect(rec.isError).toBeFalsy();
    const recorded = JSON.parse(textOf(rec));
    expect(recorded.entry_id).toBeTruthy();
    expect(recorded.kind).toBe("surprise");

    const recall = await client.callTool({
      name: "recall_reasoning",
      arguments: { text: "php" },
    });
    expect(recall.isError).toBeFalsy();
    const recalled = JSON.parse(textOf(recall));
    expect(recalled.entries).toHaveLength(1);
    expect(recalled.entries[0].title).toBe("expected react, found php");
  });

  it("returns a tool error for an invalid payload", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise",
        title: "bad",
        body: "missing fields",
        payload: { expected: "only this" },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("payload");
  });

  it("returns a tool error for an unknown tool", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "nope", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("recall_reasoning resolves the multi-word query that the dogfood missed", async () => {
    const client = await connectedClient();
    await service.record({
      kind: "surprise",
      title: "noise",
      body: "irrelevant",
      payload: { expected: "a", actual: "b", magnitude: 1 },
    });
    await service.record({
      kind: "surprise",
      title: "Claude Code hooks hot-reload, but mcp add does not",
      body: "writing hooks into settings took effect with no restart",
      payload: { expected: "restart", actual: "hot reload", magnitude: 2 },
    });
    const res = await client.callTool({
      name: "recall_reasoning",
      arguments: { text: "hooks restart mcp", rank: "match" },
    });
    const out = JSON.parse(textOf(res));
    expect(out.count).toBe(1);
    expect(out.entries[0].title).toContain("hooks hot-reload");
  });

  it("recalls hook_spine entries when source is provided (default hides them)", async () => {
    const client = await connectedClient();
    await service.recordSpine({
      kind: "spine_tool",
      title: "PreToolUse: Edit",
      body: "about to run Edit",
      toolName: "Edit",
      payload: { phase: "pre", tool: "Edit" },
    });

    const hidden = JSON.parse(
      textOf(await client.callTool({ name: "recall_reasoning", arguments: {} })),
    );
    expect(hidden.entries).toHaveLength(0);

    const shown = JSON.parse(
      textOf(
        await client.callTool({
          name: "recall_reasoning",
          arguments: { source: "hook_spine" },
        }),
      ),
    );
    expect(shown.entries).toHaveLength(1);
    expect(shown.entries[0].kind).toBe("spine_tool");
  });

  it("recall response carries scope and superseded_by", async () => {
    const client = await connectedClient();

    const rec = await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise",
        title: "old conclusion",
        body: "turned out to be wrong",
        payload: { expected: "a", actual: "b", magnitude: 1 },
      },
    });
    const old = JSON.parse(textOf(rec));

    await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise",
        title: "corrected conclusion",
        body: "supersedes the earlier one",
        payload: { expected: "a", actual: "c", magnitude: 1 },
        ref_entry_id: old.entry_id,
      },
    });

    const recall = await client.callTool({ name: "recall_reasoning", arguments: {} });
    expect(recall.isError).toBeFalsy();
    const recalled = JSON.parse(textOf(recall));

    expect(recalled.scope.project).toBe("evaluagent");
    expect(recalled.scope.projects_total).toBe(1);

    const oldEntry = recalled.entries.find((e: { entry_id: string }) => e.entry_id === old.entry_id);
    const newEntry = recalled.entries.find((e: { entry_id: string }) => e.entry_id !== old.entry_id);
    expect(oldEntry.superseded_by).toEqual([newEntry.entry_id]);
    expect(newEntry.superseded_by).toEqual([]);
  });
});

describe("MCP ledger_get", () => {
  it("retrieves an entry written under a different project than the server default", async () => {
    const client = await connectedClient();
    const rec = await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise",
        title: "filed somewhere else",
        body: "the entry a caller could not reach",
        payload: { expected: "here", actual: "elsewhere", magnitude: 2 },
        project: "somewhere-else",
      },
    });
    const { entry_id } = JSON.parse(textOf(rec));

    const got = await client.callTool({ name: "ledger_get", arguments: { entry_id } });
    expect(got.isError).toBeFalsy();
    const entry = JSON.parse(textOf(got));
    expect(entry.entry_id).toBe(entry_id);
    expect(entry.project).toBe("somewhere-else");
    expect(entry.title).toBe("filed somewhere else");
    expect(entry.superseded_by).toEqual([]);
  });

  it("errors clearly on an unknown id instead of returning an empty success", async () => {
    const client = await connectedClient();
    const got = await client.callTool({
      name: "ledger_get",
      arguments: { entry_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" },
    });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toMatch(/not found/i);
  });
});

describe("MCP list_projects", () => {
  it("names the projects that projects_total only counts", async () => {
    const client = await connectedClient();
    for (const project of ["alpha", "alpha", "beta"]) {
      await client.callTool({
        name: "record_reasoning",
        arguments: {
          kind: "surprise",
          title: "t",
          body: "b",
          payload: { expected: "a", actual: "b", magnitude: 1 },
          project,
        },
      });
    }

    const res = await client.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(textOf(res));
    expect(out.count).toBe(2);
    expect(out.projects.map((p: { project: string }) => p.project)).toEqual(["alpha", "beta"]);
    expect(out.projects[0].entries).toBe(2);
    expect(out.projects[0].last_written).toBeTruthy();
  });

  it("is advertised alongside the other tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ledger_get");
    expect(names).toContain("list_projects");
  });
});

describe("MCP spec-completion tools", () => {
  async function seed(client: any, project: string, title = "t") {
    return client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise", title, body: "b",
        payload: { expected: "a", actual: "b", magnitude: 1 }, project,
      },
    });
  }

  it("advertises all seven tools", async () => {
    const client = await connectedClient();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ledger_get", "ledger_query", "list_projects",
      "recall_reasoning", "record_reasoning", "rename_project", "session_timeline",
    ]);
  });

  it("ledger_query spans all projects and filters by kind", async () => {
    const client = await connectedClient();
    await seed(client, "p1");
    await seed(client, "p2");
    const all = JSON.parse(textOf(await client.callTool({ name: "ledger_query", arguments: {} })));
    expect(all.count).toBe(2);
    const none = JSON.parse(
      textOf(await client.callTool({ name: "ledger_query", arguments: { kinds: ["friction"] } })),
    );
    expect(none.count).toBe(0);
  });

  it("ledger_query does NOT log a recall event — analysis must not distort the measurement", async () => {
    const client = await connectedClient();
    await seed(client, "p1");
    await client.callTool({ name: "ledger_query", arguments: { project: "p1" } });
    const events = await repo.listRecallEvents("p1", 10);
    expect(events, "a ledger_query must never appear in recall_events").toHaveLength(0);

    await client.callTool({ name: "recall_reasoning", arguments: { project: "p1" } });
    expect(await repo.listRecallEvents("p1", 10)).toHaveLength(1); // recall still does
  });

  it("rename_project refuses a silent merge, then performs an explicit one", async () => {
    const client = await connectedClient();
    await seed(client, "a");
    await seed(client, "b");

    const refused = await client.callTool({
      name: "rename_project",
      arguments: { from: "a", to: "b" },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/merge:\s*true/i);

    const done = JSON.parse(
      textOf(await client.callTool({ name: "rename_project", arguments: { from: "a", to: "b", merge: true } })),
    );
    expect(done.merged).toBe(true);
    expect(done.entries_moved).toBe(1);

    const projects = JSON.parse(textOf(await client.callTool({ name: "list_projects", arguments: {} })));
    expect(projects.projects.map((p: { project: string }) => p.project)).toEqual(["b"]);
  });

  it("session_timeline reports both sources for one session", async () => {
    const client = await connectedClient();
    await client.callTool({
      name: "record_reasoning",
      arguments: {
        kind: "surprise", title: "in a session", body: "b",
        payload: { expected: "a", actual: "b", magnitude: 1 },
        project: "p1", session_id: "SESS-1",
      },
    });
    const sid = "SESS-1";

    const tl = JSON.parse(
      textOf(await client.callTool({ name: "session_timeline", arguments: { session_id: sid } })),
    );
    expect(tl.count).toBeGreaterThan(0);
    expect(tl.self_reports).toBeGreaterThan(0);
  });

  it("session_timeline errors on a missing session_id rather than returning everything", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "session_timeline", arguments: { session_id: "" } });
    expect(res.isError).toBe(true);
  });
});
