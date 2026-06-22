import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Resolve the SQLite path: env override, else ~/.evaluagent/ledger.db (dir ensured). */
export function resolveDbPath(): string {
  const env = process.env.EVALUAGENT_DB_PATH ?? process.env.RLX_DB_PATH;
  if (env) return env;
  const dir = path.join(os.homedir(), ".evaluagent");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ledger.db");
}

/** Resolve the default project scope: env override, else the current dir name. */
export function resolveProject(cwd: string = process.cwd()): string {
  return process.env.EVALUAGENT_PROJECT ?? process.env.RLX_PROJECT ?? path.basename(cwd);
}
