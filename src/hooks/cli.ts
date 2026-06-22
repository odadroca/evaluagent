import { mapHookEvent, type HookEvent } from "../domain/spine.js";
import type { LedgerService } from "../service/ledger-service.js";

export interface RunHookResult {
  written: number;
}

/**
 * Process one Claude Code hook payload (raw JSON on stdin) into spine entries.
 * Never throws: malformed input is ignored and a failed write is swallowed, so
 * the bridge can never break the agent it observes.
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
  return { written };
}
