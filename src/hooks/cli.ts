import { mapHookEvent, type HookEvent } from "../domain/spine.js";
import type { LedgerService } from "../service/ledger-service.js";
import { decideNudge, type Nudge, type NudgeKind } from "./nudge.js";

export interface RunHookResult {
  written: number;
  /** Guidance to inject back into the agent, if this event earned one. */
  nudge?: Nudge;
}

/** Events where injecting context is both supported and useful. */
const NUDGEABLE = new Set(["PreToolUse", "UserPromptSubmit"]);

/**
 * Process one Claude Code hook payload (raw JSON on stdin) into spine entries,
 * and decide whether to inject guidance back into the agent.
 *
 * Never throws: malformed input is ignored and every failure is swallowed, so
 * the bridge can neither break nor block the agent it observes. A nudge that
 * cannot be computed is simply not emitted.
 */
export async function runHook(
  rawInput: string,
  service: LedgerService,
  project?: string,
): Promise<RunHookResult> {
  let event: HookEvent;
  try {
    event = JSON.parse(rawInput) as HookEvent;
  } catch {
    return { written: 0 };
  }

  let written = 0;
  for (const write of mapHookEvent(event)) {
    try {
      await service.recordSpine(write, project);
      written++;
    } catch {
      // observational: a telemetry write must never propagate into the agent.
    }
  }

  const eventName = event.hook_event_name ?? "";
  if (!NUDGEABLE.has(eventName)) return { written };

  // No session id ⇒ no fire-once bookkeeping is possible, so a nudge here would repeat
  // on every event forever. Staying silent is the only safe behaviour.
  const sessionId = event.session_id ?? null;
  if (!sessionId) return { written };

  try {
    const counts = await service.getNudgeCounts(project, sessionId);
    const nudge = decideNudge({
      event: eventName,
      toolName: event.tool_name ?? null,
      projectEntryCount: counts.projectEntryCount,
      recentSelfReports: counts.recentSelfReports,
      sessionToolCalls: counts.sessionToolCalls,
      recentRetries: counts.recentRetries,
      recallFired: counts.recallFired,
      alreadyNudged: counts.alreadyNudged as NudgeKind[],
    });
    if (!nudge) return { written };
    await service.markNudged(project, sessionId, nudge.kind);
    return { written, nudge };
  } catch {
    return { written };
  }
}

/** The stdout payload Claude Code reads, or null when there is nothing to say. */
export function hookOutput(eventName: string, result: RunHookResult): string | null {
  if (!result.nudge) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: result.nudge.text,
    },
  });
}
