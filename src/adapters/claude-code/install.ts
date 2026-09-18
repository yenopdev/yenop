import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

interface HookEntry {
  type: "command" | "http";
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  statusMessage?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Any command that ends in this is ours, whatever path the CLI lives at. */
export const YENOP_HOOK_MARKER = "hook claude-code";

/**
 * The command Claude Code should run. When `yenop` on PATH is this very build (a global npm
 * install or `npm link`), use the short form so the settings file carries no machine path.
 * Otherwise fall back to node plus the absolute path of this build.
 */
export function hookCommandFor(cliPath: string): string {
  try {
    const which = execFileSync("sh", ["-lc", "command -v yenop"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (which && realpathSync(which) === realpathSync(cliPath)) return "yenop hook claude-code";
  } catch {
    /* not on PATH */
  }
  return `node ${JSON.stringify(cliPath)} hook claude-code`;
}

/**
 * Add the Yenop PreToolUse hook to a Claude Code settings file.
 * Project scope uses .claude/settings.local.json so the machine-specific command path is never committed.
 * Idempotent: an existing Yenop entry is replaced, other hooks are left alone.
 */
function isOurs(h: HookEntry): boolean {
  if (h.type === "http") return (h.url ?? "").includes("/hooks/claude-code");
  return (h.command ?? "").trim().endsWith(YENOP_HOOK_MARKER);
}

/**
 * Install the HTTP form of the hook: Claude Code posts straight to the daemon, no process spawn.
 * The token lives in the settings file, which is why this form belongs in settings.local.json or the user file.
 */
export function installClaudeCodeHttpHook(settingsPath: string, port: number, token: string): { changed: boolean; path: string } {
  const entry: HookEntry = {
    type: "http",
    url: `http://127.0.0.1:${port}/hooks/claude-code`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10,
    statusMessage: "Yenop is checking this action",
  };
  return installEntry(settingsPath, entry);
}

export function installClaudeCodeHook(settingsPath: string, command: string): { changed: boolean; path: string } {
  const entry: HookEntry = { type: "command", command, timeout: 15, statusMessage: "Yenop is checking this action" };
  return installEntry(settingsPath, entry);
}

function installEntry(settingsPath: string, entry: HookEntry): { changed: boolean; path: string } {
  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  } else {
    mkdirSync(join(settingsPath, ".."), { recursive: true });
  }
  settings.hooks ??= {};
  const groups = (settings.hooks["PreToolUse"] ??= []);
  const existing = groups.find((g) => g.hooks.some(isOurs));
  if (existing) {
    const same = existing.matcher === "*" && existing.hooks.length === 1 && JSON.stringify(existing.hooks[0]) === JSON.stringify(entry);
    if (same) return { changed: false, path: settingsPath };
    existing.matcher = "*";
    existing.hooks = [entry];
  } else {
    groups.push({ matcher: "*", hooks: [entry] });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { changed: true, path: settingsPath };
}
