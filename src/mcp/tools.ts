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
      "Record one introspective reasoning entry (a surprise, dead-end, confidence call, abandoned branch, expensive reconstruction, or friction point) so a future instance can recall it. " +
      "CHOOSING THE KIND — `surprise` is the broadest kind and will fit almost anything, so check the narrower ones first: " +
      "if you PURSUED AN APPROACH THAT FAILED, it is a `dead_end`, not a `surprise` — and its `signal` field (what should have tipped you off, and when) is the part worth recording. " +
      "If you left a line of work unfinished, it is an `abandoned_branch`. If something was tangled or slow to work with, it is `friction`. " +
      "Record each ruled-out hypothesis as its own entry rather than bundling several into one summary; a negative result is a first-class result.",
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
      "Recall the most relevant past reasoning entries for the current work. Defaults to hybrid ranking (blends text match, recency, salience, and tags). Use at the start of a task to learn from earlier instances. " +
      "Responses include the effective project scope (`scope.projects_total` shows how many projects exist beyond it) and per-entry `superseded_by` links — treat a superseded entry as potentially stale and read its successor.",
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
            "recency = newest first (text, if given, filters via the same tokenized FTS match); match = strict FTS matches only (can be empty); hybrid = best-available, blends text + recency + salience + tags (default).",
        },
        tags: { type: "array", items: { type: "string" }, description: "Filter/boost by tag overlap." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ledger_get",
    description:
      "Fetch one entry by its entry_id, from any project. Not scoped to the current project — an id is globally unique, and you usually hold one precisely because the entry lives somewhere recall cannot see. " +
      "Returns the full entry plus `superseded_by`. Use this when you have an id from a handoff, a commit message, or an earlier session.",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "The ULID of the entry to fetch." },
      },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ledger_query",
    description:
      "Filtered, non-ranked read over the ledger for ANALYSIS — counts, time ranges, kind mixes. " +
      "Use `recall_reasoning` when you want the most relevant lessons for the work in front of you; use this when you want a defined slice. " +
      "Unlike recall, this is NOT logged as a recall event, so analysis traffic cannot distort the measurement of whether recall changes behaviour. " +
      "Omit `project` to span every project. Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Omit to span all projects." },
        kinds: { type: "array", items: { type: "string" } },
        source: { type: "string", enum: ["self_report", "hook_spine"] },
        since: { type: "string", description: "ISO timestamp, inclusive lower bound on created_at." },
        until: { type: "string", description: "ISO timestamp, inclusive upper bound on created_at." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_timeline",
    description:
      "One session's entries — self-reports and the automatic tool/lifecycle spine interleaved, oldest first. " +
      "Answers \"what happened, and what did I learn, in that session?\". " +
      "NOTE: entries written before 2026-08-14 predate the sessions table, so self-reports carry a per-process `proc-<ulid>` id while spine rows carry the host session id — a timeline over that era will show one source only.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_project",
    description:
      "Rename a project everywhere (entries, recall events, the projects row), or merge it into an existing one. " +
      "MERGING IS DESTRUCTIVE AND IRREVERSIBLE: it requires `merge: true`, so a mistyped target cannot silently combine two unrelated corpora. " +
      "Moved entries are stamped `was:<old-slug>` so provenance survives. Use it to collapse slug variants of the same work (e.g. a folder renamed on disk).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        merge: { type: "boolean", description: "Required when `to` already exists." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List every project in the ledger with its entry count and most recent write, busiest first. " +
      "Use it when `recall_reasoning` returns a `scope.projects_total` larger than expected, or to find the project name an entry was filed under before recalling from it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];
