import { describe, it, expect } from "vitest";
import { mapHookEvent, digestArgs, SPINE_KINDS } from "./spine.js";

describe("digestArgs", () => {
  it("is deterministic and prefixed", () => {
    const a = digestArgs({ file_path: "x.ts", content: "hi" });
    const b = digestArgs({ file_path: "x.ts", content: "hi" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it("differs for different inputs and never echoes raw content", () => {
    const a = digestArgs({ secret: "TOKEN-123" });
    const b = digestArgs({ secret: "TOKEN-456" });
    expect(a).not.toBe(b);
    expect(a).not.toContain("TOKEN");
  });
});

describe("mapHookEvent", () => {
  it("maps SessionStart to a lifecycle entry carrying the session id", () => {
    const out = mapHookEvent({
      hook_event_name: "SessionStart",
      session_id: "sess-1",
      cwd: "/repo",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("spine_lifecycle");
    expect(out[0]!.sessionId).toBe("sess-1");
    expect(out[0]!.payload.event).toBe("SessionStart");
  });

  it("maps PreToolUse to a spine_tool pre entry with a hashed args digest", () => {
    const out = mapHookEvent({
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      tool_name: "Edit",
      tool_input: { file_path: "a.ts", content: "secret-stuff" },
    });
    expect(out).toHaveLength(1);
    const w = out[0]!;
    expect(w.kind).toBe("spine_tool");
    expect(w.toolName).toBe("Edit");
    expect(w.payload.phase).toBe("pre");
    expect(w.payload.tool).toBe("Edit");
    expect(String(w.payload.args_digest)).toMatch(/^sha256:/);
    expect(JSON.stringify(w.payload)).not.toContain("secret-stuff");
  });

  it("maps PostToolUse to a spine_tool post entry, ok=true for a normal response", () => {
    const out = mapHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_response: { content: "ok" },
    });
    expect(out[0]!.payload.phase).toBe("post");
    expect(out[0]!.payload.ok).toBe(true);
  });

  it("marks PostToolUse ok=false when the tool response signals an error", () => {
    const out = mapHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { error: "command failed" },
    });
    expect(out[0]!.payload.ok).toBe(false);
  });

  it("maps PostToolUseFailure to a failed spine_tool post (Claude Code fires it, not PostToolUse, on failure)", () => {
    const out = mapHookEvent({
      hook_event_name: "PostToolUseFailure",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { error: "command failed" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("spine_tool");
    expect(out[0]!.payload.phase).toBe("post");
    expect(out[0]!.payload.ok).toBe(false);
  });

  it("captures the failure message from the top-level error field", () => {
    const out = mapHookEvent({
      hook_event_name: "PostToolUseFailure",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "nope" },
      error: "command not found",
    });
    expect(out[0]!.payload.ok).toBe(false);
    expect(out[0]!.payload.error).toBe("command not found");
  });

  it("falls back to tool_response.error when there is no top-level error", () => {
    const out = mapHookEvent({
      hook_event_name: "PostToolUseFailure",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { error: "nested boom" },
    });
    expect(out[0]!.payload.error).toBe("nested boom");
  });

  it("maps Stop and SessionEnd to lifecycle entries", () => {
    expect(mapHookEvent({ hook_event_name: "Stop", session_id: "s" })[0]!.kind).toBe(
      "spine_lifecycle",
    );
    expect(mapHookEvent({ hook_event_name: "SessionEnd", session_id: "s" })[0]!.payload.event).toBe(
      "SessionEnd",
    );
  });

  it("ignores unknown events", () => {
    expect(mapHookEvent({ hook_event_name: "Notification", session_id: "s" })).toEqual([]);
    expect(mapHookEvent({})).toEqual([]);
  });

  it("exposes the spine kinds", () => {
    expect([...SPINE_KINDS].sort()).toEqual(["spine_lifecycle", "spine_tool"]);
  });
});
