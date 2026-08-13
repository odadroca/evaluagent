import { describe, it, expect } from "vitest";
import { buildHooksSnippet } from "./install.js";

const HOOK_BIN = "/Users/alice/My Projects/evaluagent/dist/bin/ledger-hook.js";

describe("buildHooksSnippet", () => {
  const hooks = buildHooksSnippet(HOOK_BIN).hooks;

  it("registers every lifecycle + tool event, including the failure event", () => {
    expect(Object.keys(hooks).sort()).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("registers UserPromptSubmit — without it the journal nudge can never fire", () => {
    // Regression: the nudge shipped wired only in a hand-edited settings.json, so anyone
    // installing from this snippet got a nudge path that was silently dead.
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.UserPromptSubmit![0]!.hooks[0]!.args).toEqual([HOOK_BIN]);
  });

  it("uses exec-form args (no shell tokenization) so a path with spaces is safe", () => {
    const entry = hooks.SessionStart![0]!.hooks[0]!;
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual([HOOK_BIN]);
  });

  it("uses a wildcard matcher on the tool events", () => {
    expect(hooks.PreToolUse![0]!.matcher).toBe("*");
    expect(hooks.PostToolUse![0]!.matcher).toBe("*");
    expect(hooks.PostToolUseFailure![0]!.matcher).toBe("*");
  });

  it("does not put a matcher on lifecycle events", () => {
    expect(hooks.SessionStart![0]!.matcher).toBeUndefined();
    expect(hooks.Stop![0]!.matcher).toBeUndefined();
  });
});
