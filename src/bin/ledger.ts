#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";
import { LedgerService } from "../service/ledger-service.js";
import { createLedgerServer } from "../mcp/server.js";

function resolveDbPath(): string {
  const env = process.env.EVALUAGENT_DB_PATH ?? process.env.RLX_DB_PATH;
  if (env) return env;
  const dir = path.join(os.homedir(), ".evaluagent");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ledger.db");
}

function resolveProject(): string {
  return (
    process.env.EVALUAGENT_PROJECT ??
    process.env.RLX_PROJECT ??
    path.basename(process.cwd())
  );
}

async function serve(): Promise<void> {
  const dbPath = resolveDbPath();
  const project = resolveProject();
  const repo = new SqliteRepository(dbPath);
  const service = new LedgerService({ repo, defaultProject: project });
  const server = createLedgerServer(service);
  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel; status goes to stderr.
  process.stderr.write(
    `evaluagent ledger MCP server on stdio (db=${dbPath}, project=${project})\n`,
  );
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "serve") {
  serve().catch((e: unknown) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`unknown command: ${cmd}\nusage: evaluagent serve\n`);
  process.exit(2);
}
