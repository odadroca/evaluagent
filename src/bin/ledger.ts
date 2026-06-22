#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SqliteRepository } from "../repo/sqlite/sqlite-repository.js";
import { LedgerService } from "../service/ledger-service.js";
import { createLedgerServer } from "../mcp/server.js";
import { resolveDbPath, resolveProject } from "../config.js";
import { buildHooksSnippet } from "../hooks/install.js";

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

/** Print a .claude/settings.json hooks snippet wired to the built hook binary. */
function hooksInstall(): void {
  const hookBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "ledger-hook.js");
  process.stdout.write(
    "# Merge this into .claude/settings.json to feed the behavioral spine into the ledger:\n",
  );
  process.stdout.write(`${JSON.stringify(buildHooksSnippet(hookBin), null, 2)}\n`);
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "serve") {
  serve().catch((e: unknown) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
} else if (cmd === "hooks-install") {
  hooksInstall();
} else {
  process.stderr.write(`unknown command: ${cmd}\nusage: evaluagent <serve|hooks-install>\n`);
  process.exit(2);
}
