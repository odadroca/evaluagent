import { createHash } from "node:crypto";

/** Behavioral-spine kinds, written by the hook bridge (source = "hook_spine"). */
export const SPINE_KINDS = ["spine_tool", "spine_lifecycle"] as const;
export type SpineKind = (typeof SPINE_KINDS)[number];

/** The subset of a Claude Code hook payload we read. Extra fields are ignored. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  [k: string]: unknown;
}

/** A spine entry the bridge will persist. */
export interface SpineWrite {
  kind: SpineKind;
  title: string;
  body: string;
  toolName?: string | null;
  sessionId?: string | null;
  payload: Record<string, unknown>;
}

/** Hash tool input so the ledger never stores raw args (bounds size + PII). */
export function digestArgs(input: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
  return `sha256:${hash.slice(0, 16)}`;
}

function looksLikeError(response: unknown): boolean {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if ("error" in r && r.error) return true;
    if (r.success === false) return true;
    if (r.is_error === true || r.isError === true) return true;
  }
  return false;
}

/**
 * Map one Claude Code hook event to zero or more spine entries. Pure: correlation
 * (pre/post duration, retries) is a later, DB-aware refinement.
 */
export function mapHookEvent(event: HookEvent): SpineWrite[] {
  const name = event.hook_event_name ?? "";
  const sessionId = event.session_id ?? null;

  switch (name) {
    case "SessionStart":
      return [
        {
          kind: "spine_lifecycle",
          title: "SessionStart",
          body: event.cwd ? `session started in ${event.cwd}` : "session started",
          sessionId,
          payload: { event: "SessionStart", cwd: event.cwd ?? null },
        },
      ];
    case "SessionEnd":
      return [
        {
          kind: "spine_lifecycle",
          title: "SessionEnd",
          body: "session ended",
          sessionId,
          payload: { event: "SessionEnd" },
        },
      ];
    case "Stop":
      return [
        {
          kind: "spine_lifecycle",
          title: "Stop",
          body: "assistant turn stopped",
          sessionId,
          payload: { event: "Stop" },
        },
      ];
    case "PreToolUse": {
      const tool = event.tool_name ?? "unknown";
      return [
        {
          kind: "spine_tool",
          title: `PreToolUse: ${tool}`,
          body: `about to run ${tool}`,
          toolName: tool,
          sessionId,
          payload: { phase: "pre", tool, args_digest: digestArgs(event.tool_input) },
        },
      ];
    }
    case "PostToolUse": {
      const tool = event.tool_name ?? "unknown";
      return [
        {
          kind: "spine_tool",
          title: `PostToolUse: ${tool}`,
          body: `finished ${tool}`,
          toolName: tool,
          sessionId,
          payload: {
            phase: "post",
            tool,
            args_digest: digestArgs(event.tool_input),
            ok: !looksLikeError(event.tool_response),
          },
        },
      ];
    }
    default:
      return [];
  }
}
