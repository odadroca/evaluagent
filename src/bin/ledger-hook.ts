#!/usr/bin/env node
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";
import { LedgerService } from "../service/ledger-service.js";
import { runHook } from "../hooks/cli.js";
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
    await runHook(input, service);
  } finally {
    await repo.close();
  }
}

// Exit 0 no matter what — a hook must never break the agent it observes.
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
