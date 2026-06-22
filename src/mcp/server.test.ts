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
});
