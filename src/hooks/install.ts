/** One command hook in exec form (args passed unchanged — no shell tokenization). */
export interface HookCommand {
  type: "command";
  command: string;
  args: string[];
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksSnippet {
  hooks: Record<string, HookEntry[]>;
}

/**
 * Build the `.claude/settings.json` hooks snippet wired to the built hook binary.
 * Uses exec-form `args` (recommended by the Claude Code docs) so a binary path
 * containing spaces is passed as a single argument rather than shell-tokenized.
 * Includes `PostToolUseFailure` so failed tool calls are captured, not just
 * successful `PostToolUse` ones.
 */
export function buildHooksSnippet(hookBin: string): HooksSnippet {
  const cmd = (): HookCommand => ({ type: "command", command: "node", args: [hookBin] });
  const lifecycle = (): HookEntry[] => [{ hooks: [cmd()] }];
  const tool = (): HookEntry[] => [{ matcher: "*", hooks: [cmd()] }];
  return {
    hooks: {
      SessionStart: lifecycle(),
      UserPromptSubmit: lifecycle(),
      PreToolUse: tool(),
      PostToolUse: tool(),
      PostToolUseFailure: tool(),
      Stop: lifecycle(),
      SessionEnd: lifecycle(),
    },
  };
}
