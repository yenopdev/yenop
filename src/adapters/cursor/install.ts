/**
 * Install the Yenop hooks into a Cursor hooks.json (project: <root>/.cursor/hooks.json, user: ~/.cursor/hooks.json).
 *
 * Decision events get failClosed:true so a crash or timeout of the hook blocks the action instead of letting it
 * through; that is the only safe default for a guard. Report events are observe-only and left fail-open so a
 * hiccup never stalls the agent for a record-keeping call. Idempotent: our entries are replaced, anyone else's
 * are kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CURSOR_MARKER = "hook cursor";
export const CURSOR_DECISION_EVENTS = ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse"] as const;
export const CURSOR_REPORT_EVENTS = ["postToolUse", "postToolUseFailure", "sessionEnd"] as const;

interface CursorHookEntry {
  command: string;
  type?: string;
  timeout?: number;
  failClosed?: boolean;
  matcher?: string;
}
interface CursorHooksFile {
  version: number;
  hooks: Record<string, CursorHookEntry[]>;
}

export function cursorHooksPath(scope: "project" | "user", projectDir?: string): string {
  return scope === "user" ? join(homedir(), ".cursor", "hooks.json") : join(projectDir ?? process.cwd(), ".cursor", "hooks.json");
}

function readHooks(path: string): CursorHooksFile {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorHooksFile>;
  return { version: typeof parsed.version === "number" ? parsed.version : 1, hooks: parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {} };
}

function isOurs(e: CursorHookEntry): boolean {
  return typeof e.command === "string" && e.command.endsWith(CURSOR_MARKER);
}

/** Write the file atomically so a crash mid-write never leaves Cursor with a half file (which would fail open). */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function installCursorHooks(path: string, command: string): { changed: boolean; path: string } {
  const file = readHooks(path);
  const before = JSON.stringify(file);
  for (const ev of CURSOR_DECISION_EVENTS) {
    const rest = (file.hooks[ev] ?? []).filter((e) => !isOurs(e));
    file.hooks[ev] = [...rest, { command, type: "command", timeout: 15, failClosed: true }];
  }
  for (const ev of CURSOR_REPORT_EVENTS) {
    const rest = (file.hooks[ev] ?? []).filter((e) => !isOurs(e));
    file.hooks[ev] = [...rest, { command, type: "command", timeout: 5 }];
  }
  const after = JSON.stringify(file);
  if (after === before) return { changed: false, path };
  writeAtomic(path, JSON.stringify(file, null, 2) + "\n");
  return { changed: true, path };
}

/** Is Cursor present on this machine or in this project? Used by `yenop init` to decide what to hook. */
export function cursorDetected(projectDir: string): boolean {
  return existsSync(join(homedir(), ".cursor")) || existsSync(join(projectDir, ".cursor"));
}
