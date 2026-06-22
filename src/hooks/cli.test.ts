import { describe, it, expect, afterEach } from "vitest";
import { runHook } from "./cli.js";
import { LedgerService } from "../service/ledger-service.js";
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";

let repo: SqliteRepository;

function svc() {
  repo = new SqliteRepository(":memory:");
  return new LedgerService({ repo, defaultProject: "evaluagent" });
}

afterEach(async () => {
  await repo?.close();
});

describe("runHook", () => {
  it("stores a spine entry for a PreToolUse event", async () => {
    const s = svc();
    const res = await runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "sess-1",
        tool_name: "Edit",
        tool_input: { file_path: "a.ts" },
      }),
      s,
    );
    expect(res.written).toBe(1);

    const out = await s.recall({ source: "hook_spine" });
    expect(out[0]!.kind).toBe("spine_tool");
    expect(out[0]!.toolName).toBe("Edit");
  });

  it("ignores malformed JSON without throwing", async () => {
    const s = svc();
    const res = await runHook("not json{", s);
    expect(res.written).toBe(0);
  });

  it("writes nothing for an unknown event", async () => {
    const s = svc();
    const res = await runHook(JSON.stringify({ hook_event_name: "Notification" }), s);
    expect(res.written).toBe(0);
  });

  it("records a lifecycle entry for SessionStart", async () => {
    const s = svc();
    const res = await runHook(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-1", cwd: "/repo" }),
      s,
    );
    expect(res.written).toBe(1);
    const out = await s.recall({ source: "hook_spine" });
    expect(out[0]!.kind).toBe("spine_lifecycle");
  });
});
