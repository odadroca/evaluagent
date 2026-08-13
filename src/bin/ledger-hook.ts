#!/usr/bin/env node
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";
import { LedgerService } from "../service/ledger-service.js";
import { hookOutput, runHook } from "../hooks/cli.js";
import { resolveDbPath, resolveProject } from "../config.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = await readStdin();
  const repo = new SqliteRepository(resolveDbPath());
  const service = new LedgerService({ repo, defaultProject: resolveProject() });
  try {
    const result = await runHook(input, service);
    let eventName = "";
    try {
      eventName = (JSON.parse(input) as { hook_event_name?: string }).hook_event_name ?? "";
    } catch {
      // already handled inside runHook; nothing to emit.
    }
    const out = hookOutput(eventName, result);
    // stdout to a pipe is ASYNCHRONOUS on Windows, so process.exit() can discard a queued
    // write. The fire-once marker is already committed by here, so a dropped nudge is never
    // re-emitted — wait for the flush before letting main() resolve.
    if (out) {
      await new Promise<void>((resolve) => {
        process.stdout.write(out, () => resolve());
      });
    }
  } finally {
    await repo.close();
  }
}

// Exit 0 no matter what — a hook must never break the agent it observes.
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
