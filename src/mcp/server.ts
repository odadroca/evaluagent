import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LedgerService, LedgerValidationError } from "../service/ledger-service.js";
import type { EntryKind } from "../domain/entry-kinds.js";
import { TOOLS } from "./tools.js";

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function err(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function recordReasoning(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const entry = await service.record({
    kind: String(args.kind),
    title: String(args.title ?? ""),
    body: String(args.body ?? ""),
    payload: args.payload,
    project: args.project as string | undefined,
    confidence: args.confidence as number | undefined,
    salience: args.salience as number | undefined,
    tags: args.tags as string[] | undefined,
    sessionId: args.session_id as string | undefined,
    occurredAt: args.occurred_at as string | undefined,
  });
  return ok({
    entry_id: entry.id,
    kind: entry.kind,
    project: entry.project,
    created_at: entry.createdAt,
  });
}

async function recallReasoning(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const entries = await service.recall({
    project: args.project as string | undefined,
    kinds: args.kinds as EntryKind[] | undefined,
    text: args.text as string | undefined,
    limit: args.limit as number | undefined,
  });
  return ok({
    count: entries.length,
    entries: entries.map((e) => ({
      entry_id: e.id,
      kind: e.kind,
      title: e.title,
      body: e.body,
      tags: e.tags,
      confidence: e.confidence,
      salience: e.salience,
      created_at: e.createdAt,
      payload: e.payload,
    })),
  });
}

/** Build the MCP server (transport-agnostic; connect a transport via `.connect`). */
export function createLedgerServer(service: LedgerService): Server {
  const server = new Server(
    { name: "evaluagent", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "record_reasoning":
          return await recordReasoning(service, args);
        case "recall_reasoning":
          return await recallReasoning(service, args);
        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      if (e instanceof LedgerValidationError) {
        const detail = e.errors.length > 0 ? `: ${e.errors.join("; ")}` : "";
        return err(`${e.message}${detail}`);
      }
      return err(`internal error: ${(e as Error).message}`);
    }
  });

  return server;
}
