/**
 * Install the Yenop hooks into a Codex hooks.json (project: <root>/.codex/hooks.json, user: ~/.codex/hooks.json).
 * Same shape as Claude Code's settings: matcher groups, each with a list of command hooks. Idempotent: our
 * entries are replaced, anyone else's are kept. Written atomically, since a half-written file would make Codex
 * skip hooks entirely (it fails open).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CODEX_MARKER = "hook codex";
export const CODEX_DECISION_EVENT = "PreToolUse";
export const CODEX_REPORT_EVENTS = ["PostToolUse", "SessionEnd"] as const;

interface Hook {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
}
interface Group {
  matcher?: string;
  hooks: Hook[];
}
interface HooksFile {
  hooks?: Record<string, Group[]>;
  [k: string]: unknown;
}

export function codexHooksPath(scope: "project" | "user", projectDir?: string): string {
  return scope === "user" ? join(homedir(), ".codex", "hooks.json") : join(projectDir ?? process.cwd(), ".codex", "hooks.json");
}
export function codexDetected(projectDir: string): boolean {
  return existsSync(join(homedir(), ".codex")) || existsSync(join(projectDir, ".codex"));
}

const isOurs = (h: Hook) => typeof h.command === "string" && h.command.trim().endsWith(CODEX_MARKER);

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function installCodexHooks(path: string, command: string): { changed: boolean; path: string } {
  const file: HooksFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as HooksFile) : {};
  const before = JSON.stringify(file);
  file.hooks ??= {};
  const put = (event: string, hook: Hook) => {
    const groups = (file.hooks![event] ??= []);
    const mine = groups.find((g) => g.hooks?.some(isOurs));
    if (mine) mine.hooks = [...mine.hooks.filter((h) => !isOurs(h)), hook];
    else groups.push({ hooks: [hook] }); // no matcher: every tool
  };
  put(CODEX_DECISION_EVENT, { type: "command", command, timeout: 15, statusMessage: "Yenop is checking this action" });
  put("PostToolUse", { type: "command", command, timeout: 5, async: true });
  // Codex runs SessionEnd synchronously and clamps its timeout to 3 s; writing anything else earns a warning on every start
  put("SessionEnd", { type: "command", command, timeout: 3 });
  const after = JSON.stringify(file);
  if (after === before) return { changed: false, path };
  writeAtomic(path, JSON.stringify(file, null, 2) + "\n");
  return { changed: true, path };
}

/**
 * Codex decides per hook whether it is trusted and enabled, and writes that into ~/.codex/config.toml as
 * [hooks.state."<file>:<event>:<i>:<j>"] with trusted_hash and an optional `enabled = false`. A hook that is
 * untrusted or disabled never runs, and a disabled PreToolUse means Yenop is not enforcing on Codex at all,
 * silently. This reads that state so `yenop status` can say so. Found in the first live Codex session, where
 * PreToolUse was left disabled while the two report hooks ran.
 */
export type CodexHookState = "active" | "disabled" | "untrusted" | "unknown";
export function codexHookState(hooksPath: string, event: "PreToolUse" | "PostToolUse" | "SessionEnd", configPath = join(homedir(), ".codex", "config.toml")): CodexHookState {
  if (!existsSync(configPath)) return "unknown";
  const snake = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const key = `${hooksPath}:${snake}:`;
  const text = readFileSync(configPath, "utf8");
  // find the [hooks.state."<key>..."] table for this file+event and read its body
  const re = new RegExp(`\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"\\]([^[]*)`);
  const m = re.exec(text);
  if (!m) return "untrusted";
  const body = m[1] ?? "";
  if (/^\s*enabled\s*=\s*false/m.test(body)) return "disabled";
  if (/trusted_hash\s*=/.test(body)) return "active";
  return "untrusted";
}
