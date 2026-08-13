import { describe, it, expect } from "vitest";
import { decideNudge, type NudgeContext, type NudgeKind } from "./nudge.js";

function ctx(over: Partial<NudgeContext> = {}): NudgeContext {
  return {
    event: "PreToolUse",
    toolName: "Bash",
    projectEntryCount: 10,
    recentSelfReports: 0,
    sessionToolCalls: 0,
    recentRetries: 0,
    recallFired: false,
    alreadyNudged: [] as NudgeKind[],
    ...over,
  };
}

describe("decideNudge — the recall gate", () => {
  it("fires on the first tool use of a warm project when recall has not run", () => {
    const n = decideNudge(ctx());
    expect(n?.kind).toBe("gate");
    expect(n?.text).toContain("10 stored lesson");
  });

  it("stays silent on a COLD project — recall against an empty corpus is ceremony", () => {
    expect(decideNudge(ctx({ projectEntryCount: 0 }))).toBeNull();
  });

  it("stays silent once recall has already fired", () => {
    expect(decideNudge(ctx({ recallFired: true }))).toBeNull();
  });

  it("stops offering the gate after the work has started", () => {
    expect(decideNudge(ctx({ sessionToolCalls: 3 }))).toBeNull();
  });

  it("STILL fires late when planning starts — the case the old plan-mode triggers covered", () => {
    for (const toolName of ["EnterPlanMode", "ExitPlanMode", "Skill", "Task"]) {
      const n = decideNudge(ctx({ sessionToolCalls: 40, toolName }));
      expect(n?.kind, `expected a gate for ${toolName}`).toBe("gate");
    }
  });

  it("does not fire late for an ordinary tool", () => {
    expect(decideNudge(ctx({ sessionToolCalls: 40, toolName: "Bash" }))).toBeNull();
  });

  it("still respects cold/recalled/once-only when planning starts late", () => {
    const late = { sessionToolCalls: 40, toolName: "ExitPlanMode" };
    expect(decideNudge(ctx({ ...late, projectEntryCount: 0 }))).toBeNull();
    expect(decideNudge(ctx({ ...late, recallFired: true }))).toBeNull();
    expect(decideNudge(ctx({ ...late, alreadyNudged: ["gate"] }))).toBeNull();
  });

  it("fires only once per session", () => {
    expect(decideNudge(ctx({ alreadyNudged: ["gate"] }))).toBeNull();
  });

  it("does not fire on a non-tool event", () => {
    expect(decideNudge(ctx({ event: "SessionStart" }))).toBeNull();
  });
});

describe("decideNudge — the retry/dead_end nudge", () => {
  it("fires once repeated identical calls cross the threshold", () => {
    const n = decideNudge(ctx({ recentRetries: 5, recallFired: true }));
    expect(n?.kind).toBe("dead_end");
    expect(n?.text).toContain("`signal`");
  });

  it("tolerates an ordinary build/test loop below the threshold", () => {
    expect(decideNudge(ctx({ recentRetries: 4, recallFired: true }))).toBeNull();
  });

  it("fires only once per session", () => {
    expect(
      decideNudge(ctx({ recentRetries: 9, recallFired: true, alreadyNudged: ["dead_end"] })),
    ).toBeNull();
  });

  it("yields to the gate when both would fire — the gate is time-critical", () => {
    expect(decideNudge(ctx({ recentRetries: 9 }))?.kind).toBe("gate");
  });
});

describe("decideNudge — the journal nudge", () => {
  const base = { event: "UserPromptSubmit", sessionToolCalls: 30, recentSelfReports: 0 };

  it("fires in a long session that has recorded nothing", () => {
    const n = decideNudge(ctx(base));
    expect(n?.kind).toBe("journal");
  });

  it("names the scarce kinds rather than asking a generic question", () => {
    const text = decideNudge(ctx(base))!.text;
    for (const kind of ["abandoned_branch", "dead_end", "friction", "signal"]) {
      expect(text).toContain(kind);
    }
    expect(text).not.toMatch(/anything worth journaling/i);
  });

  it("stays silent once the session has recorded something", () => {
    expect(decideNudge(ctx({ ...base, recentSelfReports: 1 }))).toBeNull();
  });

  it("stays silent in a short session", () => {
    expect(decideNudge(ctx({ ...base, sessionToolCalls: 5 }))).toBeNull();
  });

  it("fires only once per session", () => {
    expect(decideNudge(ctx({ ...base, alreadyNudged: ["journal"] }))).toBeNull();
  });
});
