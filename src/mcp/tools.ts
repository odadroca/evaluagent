import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ENTRY_KINDS } from "../domain/entry-kinds.js";

/**
 * Tool definitions for the MCP surface. inputSchemas are plain JSON Schema
 * (no Zod, per the Calane convention). Deep per-kind payload validation happens
 * in LedgerService — the schemas here are the coarse outer shape.
 */
export const TOOLS: Tool[] = [
  {
    name: "record_reasoning",
    description:
      "Record one introspective reasoning entry (a surprise, dead-end, confidence call, abandoned branch, expensive reconstruction, or friction point) so a future instance can recall it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ENTRY_KINDS] },
        title: { type: "string", description: "Short one-line summary." },
        body: { type: "string", description: "The introspective prose." },
        payload: {
          type: "object",
          description: "Kind-specific fields (validated per kind).",
        },
        project: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        salience: { type: "integer", minimum: 0, maximum: 3 },
        tags: { type: "array", items: { type: "string" } },
        session_id: { type: "string" },
        occurred_at: { type: "string" },
        ref_entry_id: {
          type: "string",
          description:
            "entry_id of an earlier entry this one SUPERSEDES, corrects, or refines. Set it whenever a conclusion overturns a stored one — recall surfaces the link so stale entries are visibly outdated.",
        },
      },
      required: ["kind", "title", "body", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "recall_reasoning",
    description:
      "Recall the most relevant past reasoning entries for the current work. Defaults to hybrid ranking (blends text match, recency, salience, and tags). Use at the start of a task to learn from earlier instances.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        kinds: { type: "array", items: { type: "string", enum: [...ENTRY_KINDS] } },
        text: { type: "string", description: "Free-text match against title/body." },
        source: {
          type: "string",
          enum: ["self_report", "hook_spine"],
          description:
            "Defaults to self_report (the lessons). Pass hook_spine to read the automatic tool/lifecycle spine.",
        },
        rank: {
          type: "string",
          enum: ["recency", "match", "hybrid"],
          description:
            "recency = newest first; match = strict FTS matches only (can be empty); hybrid = best-available, blends text + recency + salience + tags (default).",
        },
        tags: { type: "array", items: { type: "string" }, description: "Filter/boost by tag overlap." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
];
