/**
 * Decide whether a hook event should inject guidance back into the agent.
 *
 * Pure on purpose: every input is a plain count, so the rules are unit-testable
 * without a database or a live session. The hook bridge gathers the counts and
 * calls this; nothing here does I/O.
 */

export type NudgeKind = "gate" | "dead_end" | "journal";

export interface NudgeContext {
  /** Claude Code hook event name, e.g. "PreToolUse" / "UserPromptSubmit". */
  event: string;
  /** Tool about to run (PreToolUse only). */
  toolName?: string | null;
  /** self_report entries in the resolved project scope. 0 = cold project. */
  projectEntryCount: number;
  /** self-reports written to this project recently (proxy: sessions do not join). */
  recentSelfReports: number;
  /** spine tool invocations already recorded for this session. */
  sessionToolCalls: number;
  /** repeated identical tool calls in the recent window — "stuck right now". */
  recentRetries: number;
  /** whether recall_reasoning has been called in this session. */
  recallFired: boolean;
  /** nudge kinds already emitted this session (fire-once bookkeeping). */
  alreadyNudged: readonly NudgeKind[];
}

export interface Nudge {
  kind: NudgeKind;
  text: string;
}

/** Tool calls into a session after which the gate is no longer "before the work". */
const GATE_WINDOW = 2;
/**
 * Tools that mean planning is starting. The gate fires on these regardless of how
 * far into the session we are: the early-tool-call window catches the common case,
 * but a session that works for a while and only then starts planning would slip
 * past it, which is exactly the case the original plan-mode triggers existed for.
 */
const PLANNING_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode", "Skill", "Task"]);
/**
 * Repeated identical tool calls, within a short window, that suggest being stuck.
 * Raised from 3: a normal TDD loop legitimately repeats `vitest`/`git status` calls,
 * and at 3 this fired on an ordinary edit-build-test cycle.
 */
const RETRY_THRESHOLD = 5;
/** Tool calls that make a session substantial enough that recording nothing is notable. */
const JOURNAL_MIN_TOOL_CALLS = 25;

const GATE_TEXT =
  "EVALUAGENT GATE — this project has %n stored lesson(s) and recall has not run this session. " +
  "Call mcp__evaluagent__recall_reasoning now, before you derive anything, and fold what it " +
  "returns into your approach. Firing now rather than at plan time is deliberate: a gate that " +
  "triggers after the reasoning is done cannot change it.";

const DEAD_END_TEXT =
  "EVALUAGENT — %n repeated identical tool calls in the last few minutes. That can be the shape " +
  "of a dead end. If you are simply re-running a build or test loop, or are still mid-attempt, " +
  "ignore this. Otherwise consider recording a `dead_end` (not a `surprise`): what approach " +
  "failed, why, and critically its `signal` — what should have tipped you off, and when.";

const JOURNAL_TEXT =
  "EVALUAGENT — %n tool calls this session and nothing recorded yet. Not every session earns an " +
  "entry, so ignore this if nothing genuine came up. But do not reach for `surprise` by default: " +
  "did you abandon a line of work (`abandoned_branch`), pursue something that failed " +
  "(`dead_end`, with its `signal`), or fight the tooling (`friction`)? Those are the kinds that " +
  "go unrecorded, and they are the reason this ledger exists.";

/**
 * At most one nudge per event. Order is deliberate: the gate is time-critical
 * (it stops being useful within a couple of tool calls), the dead-end nudge is
 * mid-task, and the journal nudge is the fallback that only fires in a long
 * session that produced nothing.
 */
export function decideNudge(ctx: NudgeContext): Nudge | null {
  const fired = (k: NudgeKind): boolean => ctx.alreadyNudged.includes(k);

  if (ctx.event === "PreToolUse") {
    // Cold projects get no gate: recall against an empty corpus is pure ceremony.
    const earlyEnough = ctx.sessionToolCalls <= GATE_WINDOW;
    const planningStarting = PLANNING_TOOLS.has(ctx.toolName ?? "");
    if (
      !fired("gate") &&
      !ctx.recallFired &&
      ctx.projectEntryCount > 0 &&
      (earlyEnough || planningStarting)
    ) {
      return { kind: "gate", text: GATE_TEXT.replace("%n", String(ctx.projectEntryCount)) };
    }

    if (!fired("dead_end") && ctx.recentRetries >= RETRY_THRESHOLD) {
      return { kind: "dead_end", text: DEAD_END_TEXT.replace("%n", String(ctx.recentRetries)) };
    }
  }

  if (ctx.event === "UserPromptSubmit") {
    if (
      !fired("journal") &&
      ctx.recentSelfReports === 0 &&
      ctx.sessionToolCalls >= JOURNAL_MIN_TOOL_CALLS
    ) {
      return { kind: "journal", text: JOURNAL_TEXT.replace("%n", String(ctx.sessionToolCalls)) };
    }
  }

  return null;
}
