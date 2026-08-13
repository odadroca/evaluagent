import { describe, it, expect, afterEach } from "vitest";
import { hookOutput, runHook } from "./cli.js";
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
    expect(out.entries[0]!.kind).toBe("spine_tool");
    expect(out.entries[0]!.toolName).toBe("Edit");
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
    expect(out.entries[0]!.kind).toBe("spine_lifecycle");
  });
});

describe("runHook — nudge integration (real repo, real counts)", () => {
  async function svcWith(entries: Array<Record<string, unknown>> = []) {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "proj" });
    for (const e of entries) {
      await service.record({
        kind: "surprise",
        title: "seed",
        body: "seed",
        payload: { expected: "a", actual: "b", magnitude: 1 },
        ...e,
      } as never);
    }
    return { repo, service };
  }

  const pre = (sessionId: string) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

  it("emits the gate on a WARM project and marks it so it fires once", async () => {
    const { repo, service } = await svcWith([{ project: "proj" }]);
    const first = await runHook(pre("s1"), service, "proj");
    expect(first.nudge?.kind).toBe("gate");
    expect(hookOutput("PreToolUse", first)).toContain("additionalContext");

    const second = await runHook(pre("s1"), service, "proj");
    expect(second.nudge).toBeUndefined();
    await repo.close();
  });

  it("stays silent on a COLD project — no entries means no gate ceremony", async () => {
    const { repo, service } = await svcWith();
    const r = await runHook(pre("s1"), service, "proj");
    expect(r.nudge).toBeUndefined();
    expect(hookOutput("PreToolUse", r)).toBeNull();
    await repo.close();
  });

  it("stays silent after a recent recall in the project", async () => {
    // NB: recall_events carries the MCP server's proc-<ulid>, never the host session id,
    // so suppression must work off project recency rather than a session join.
    const { repo, service } = await svcWith([{ project: "proj" }]);
    await service.recall({ project: "proj" });
    const r = await runHook(pre("s2"), service, "proj");
    expect(r.nudge).toBeUndefined();
    await repo.close();
  });

  it("still writes the spine entry even when it emits a nudge", async () => {
    const { repo, service } = await svcWith([{ project: "proj" }]);
    const r = await runHook(pre("s3"), service, "proj");
    expect(r.written).toBeGreaterThan(0);
    expect(r.nudge).toBeTruthy();
    await repo.close();
  });

  it("never throws and emits nothing on malformed input", async () => {
    const { repo, service } = await svcWith([{ project: "proj" }]);
    const r = await runHook("{not json", service, "proj");
    expect(r).toEqual({ written: 0 });
    expect(hookOutput("PreToolUse", r)).toBeNull();
    await repo.close();
  });

  it("stays silent when the payload carries no session id — fire-once would be impossible", async () => {
    const { repo, service } = await svcWith([{ project: "proj" }]);
    const noSession = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    for (let i = 0; i < 3; i++) {
      const r = await runHook(noSession, service, "proj");
      expect(r.nudge, "a sessionless payload must never nudge — it would repeat forever").toBeUndefined();
    }
    await repo.close();
  });

  it("does not nudge on events where injection is unsupported (Stop)", async () => {
    const { repo, service } = await svcWith([{ project: "proj" }]);
    const r = await runHook(
      JSON.stringify({ hook_event_name: "Stop", session_id: "s4" }),
      service,
      "proj",
    );
    expect(r.nudge).toBeUndefined();
    await repo.close();
  });
});

describe("session unification — the point of the projects/sessions tables", () => {
  it("a self-report written after SessionStart carries the REAL host session id, joining the spine", async () => {
    const repo = new SqliteRepository(":memory:");
    // defaultSessionId is the proc-<ulid> proxy the MCP server would otherwise stamp.
    const service = new LedgerService({
      repo,
      defaultProject: "proj",
      defaultSessionId: "proc-PROXY",
    });

    // 1. the hook opens the session, as SessionStart would
    await runHook(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "host-REAL" }),
      service,
      "proj",
    );

    // 2. a tool call writes a spine row under the host id
    await runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "host-REAL",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      service,
      "proj",
    );

    // 3. the MCP server records a lesson — it cannot see the host session, but resolves it
    const entry = await service.record({
      kind: "surprise",
      title: "t",
      body: "b",
      payload: { expected: "a", actual: "b", magnitude: 1 },
    } as never);

    expect(entry.sessionId, "self-report must take the real session id, not proc-PROXY").toBe("host-REAL");

    const spine = await service.recall({ project: "proj", source: "hook_spine", rank: "recency" });
    expect(spine.entries[0]!.sessionId).toBe("host-REAL");
    expect(entry.sessionId).toBe(spine.entries[0]!.sessionId); // THE join that never worked
    await repo.close();
  });

  it("falls back to the proc proxy when no session is open", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "proj", defaultSessionId: "proc-PROXY" });
    const entry = await service.record({
      kind: "surprise",
      title: "t",
      body: "b",
      payload: { expected: "a", actual: "b", magnitude: 1 },
    } as never);
    expect(entry.sessionId).toBe("proc-PROXY");
    await repo.close();
  });

  it("stops attaching writes to a session once SessionEnd has fired", async () => {
    const repo = new SqliteRepository(":memory:");
    const service = new LedgerService({ repo, defaultProject: "proj", defaultSessionId: "proc-PROXY" });
    await runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "host-REAL" }), service, "proj");
    await runHook(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "host-REAL" }), service, "proj");
    const entry = await service.record({
      kind: "surprise",
      title: "t",
      body: "b",
      payload: { expected: "a", actual: "b", magnitude: 1 },
    } as never);
    expect(entry.sessionId).toBe("proc-PROXY");
    await repo.close();
  });
});
