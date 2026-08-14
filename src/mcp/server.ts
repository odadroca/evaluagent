import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LedgerService, LedgerValidationError } from "../service/ledger-service.js";
import type { EntryKind } from "../domain/entry-kinds.js";
import type { EntrySource, RankMode } from "../domain/entry.js";
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
    refEntryId: args.ref_entry_id as string | undefined,
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
  const result = await service.recall({
    project: args.project as string | undefined,
    kinds: args.kinds as EntryKind[] | undefined,
    text: args.text as string | undefined,
    source: args.source as EntrySource | undefined,
    rank: args.rank as RankMode | undefined,
    tags: args.tags as string[] | undefined,
    limit: args.limit as number | undefined,
  });
  return ok({
    count: result.entries.length,
    scope: { project: result.scope.project, projects_total: result.scope.projectsTotal },
    entries: result.entries.map((e) => ({
      entry_id: e.id,
      kind: e.kind,
      project: e.project,
      title: e.title,
      body: e.body,
      tags: e.tags,
      confidence: e.confidence,
      salience: e.salience,
      created_at: e.createdAt,
      payload: e.payload,
      superseded_by: result.referrers[e.id] ?? [],
    })),
  });
}

async function ledgerGet(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const id = String(args.entry_id ?? "");
  const found = await service.getEntry(id);
  if (!found) return err(`entry not found: ${id}`);
  const { entry: e, supersededBy } = found;
  return ok({
    entry_id: e.id,
    kind: e.kind,
    project: e.project,
    title: e.title,
    body: e.body,
    tags: e.tags,
    confidence: e.confidence,
    salience: e.salience,
    created_at: e.createdAt,
    occurred_at: e.occurredAt,
    session_id: e.sessionId,
    source: e.source,
    payload: e.payload,
    ref_entry_id: e.refEntryId,
    superseded_by: supersededBy,
  });
}

async function listProjects(service: LedgerService): Promise<CallToolResult> {
  const projects = await service.listProjects();
  return ok({
    count: projects.length,
    projects: projects.map((p) => ({
      project: p.project,
      entries: p.entries,
      last_written: p.lastWritten,
    })),
  });
}

function entryOut(e: {
  id: string; kind: string; project: string; title: string; body: string; tags: string[];
  confidence: number | null; salience: number; createdAt: string; source: string; payload: unknown;
  sessionId: string | null;
}): Record<string, unknown> {
  return {
    entry_id: e.id, kind: e.kind, project: e.project, title: e.title, body: e.body,
    tags: e.tags, confidence: e.confidence, salience: e.salience,
    created_at: e.createdAt, session_id: e.sessionId, source: e.source, payload: e.payload,
  };
}

async function ledgerQuery(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const entries = await service.queryEntries({
    project: args.project as string | undefined,
    source: args.source as string | undefined,
    kinds: args.kinds as string[] | undefined,
    since: args.since as string | undefined,
    until: args.until as string | undefined,
    limit: args.limit as number | undefined,
  });
  return ok({ count: entries.length, entries: entries.map(entryOut) });
}

async function sessionTimeline(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const entries = await service.sessionTimeline(
    String(args.session_id ?? ""),
    args.limit as number | undefined,
  );
  return ok({
    session_id: args.session_id,
    count: entries.length,
    self_reports: entries.filter((e) => e.source === "self_report").length,
    spine: entries.filter((e) => e.source === "hook_spine").length,
    entries: entries.map(entryOut),
  });
}

async function renameProject(
  service: LedgerService,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const res = await service.renameProject(
    String(args.from ?? ""),
    String(args.to ?? ""),
    args.merge === true,
  );
  return ok({
    from: args.from, to: args.to, merged: res.merged,
    entries_moved: res.entries, recall_events_moved: res.recallEvents,
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
        case "ledger_get":
          return await ledgerGet(service, args);
        case "list_projects":
          return await listProjects(service);
        case "ledger_query":
          return await ledgerQuery(service, args);
        case "session_timeline":
          return await sessionTimeline(service, args);
        case "rename_project":
          return await renameProject(service, args);
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
