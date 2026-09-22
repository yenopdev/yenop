/**
 * Install the Yenop hooks into a Gemini CLI settings.json (project: <root>/.gemini/settings.json, user:
 * ~/.gemini/settings.json). Hooks live under the top-level "hooks" key: event → [{ matcher?, hooks: [...] }],
 * timeouts in milliseconds. Idempotent: our entries are replaced, anyone else's are kept, every other setting
 * in the file is untouched. Written atomically, since a half-written settings.json would make Gemini skip its
 * hooks, and Gemini fails open.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const GEMINI_MARKER = "hook gemini";
export const GEMINI_DECISION_EVENT = "BeforeTool";
export const GEMINI_REPORT_EVENTS = ["AfterTool", "SessionEnd"] as const;
export const GEMINI_HOOK_NAME = "yenop";

interface Hook {
  type?: string;
  command?: string;
  name?: string;
  timeout?: number;
  description?: string;
}
interface Group {
  matcher?: string;
  sequential?: boolean;
  hooks: Hook[];
}
interface Settings {
  hooks?: Record<string, Group[]>;
  [k: string]: unknown;
}

export function geminiSettingsPath(scope: "project" | "user", projectDir?: string): string {
  return scope === "user" ? join(homedir(), ".gemini", "settings.json") : join(projectDir ?? process.cwd(), ".gemini", "settings.json");
}
export function geminiDetected(projectDir: string): boolean {
  return existsSync(join(homedir(), ".gemini")) || existsSync(join(projectDir, ".gemini"));
}

const isOurs = (h: Hook) => typeof h.command === "string" && h.command.trim().endsWith(GEMINI_MARKER);

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function installGeminiHooks(path: string, command: string): { changed: boolean; path: string } {
  const file: Settings = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Settings) : {};
  const before = JSON.stringify(file);
  file.hooks ??= {};
  const put = (event: string, hook: Hook) => {
    const groups = (file.hooks![event] ??= []);
    const mine = groups.find((g) => g.hooks?.some(isOurs));
    if (mine) mine.hooks = [...mine.hooks.filter((h) => !isOurs(h)), hook];
    else groups.push({ hooks: [hook] }); // no matcher: every tool, built-in or MCP
  };
  // The hook's name is part of the key Gemini records when a person acknowledges it; keep it stable.
  put(GEMINI_DECISION_EVENT, { type: "command", name: GEMINI_HOOK_NAME, command, timeout: 15000, description: "Yenop decides whether this action is allowed" });
  put("AfterTool", { type: "command", name: `${GEMINI_HOOK_NAME}-outcome`, command, timeout: 5000, description: "Yenop records what became of the call" });
  put("SessionEnd", { type: "command", name: `${GEMINI_HOOK_NAME}-session`, command, timeout: 3000, description: "Yenop closes the run" });
  const after = JSON.stringify(file);
  if (after === before) return { changed: false, path };
  writeAtomic(path, JSON.stringify(file, null, 2) + "\n");
  return { changed: true, path };
}

/**
 * Gemini keeps two switches that decide whether a project's hooks run at all, both under ~/.gemini:
 *  - trustedFolders.json: when folder trust is enabled, project hooks are skipped entirely in a folder that
 *    is not trusted ("Project hooks disabled because the folder is not trusted").
 *  - trusted_hooks.json: { "<project path>": ["<name>:<command>", ...] }; a project hook not listed there is
 *    shown to the person with a warning before it runs, and listed once acknowledged.
 * `yenop status` reads both so "installed" is never mistaken for "enforcing". Found the hard way with Codex.
 */
export type GeminiTrust = "trusted" | "untrusted" | "unknown";

function norm(p: string): string {
  const r = resolve(p);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

export function geminiFolderTrust(projectDir: string, file = join(homedir(), ".gemini", "trustedFolders.json")): GeminiTrust {
  if (!existsSync(file)) return "unknown";
  let entries: Record<string, unknown>;
  try {
    entries = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  const dir = norm(projectDir);
  let verdict: GeminiTrust = "unknown";
  for (const [p, v] of Object.entries(entries)) {
    if (typeof v !== "string") continue;
    const at = v === "TRUST_PARENT" ? dirname(norm(p)) : norm(p);
    const covers = dir === at || dir.startsWith(at + sep);
    if (!covers) continue;
    if (v === "DO_NOT_TRUST") {
      if (dir === norm(p)) return "untrusted";
    } else if (v === "TRUST_FOLDER" || v === "TRUST_PARENT") verdict = "trusted";
  }
  return verdict;
}

export function geminiHookTrust(projectDir: string, command: string, file = join(homedir(), ".gemini", "trusted_hooks.json")): GeminiTrust {
  if (!existsSync(file)) return "unknown";
  let entries: Record<string, unknown>;
  try {
    entries = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  const dir = norm(projectDir);
  const key = `${GEMINI_HOOK_NAME}:${command}`;
  for (const [p, keys] of Object.entries(entries)) {
    if (norm(p) !== dir || !Array.isArray(keys)) continue;
    return keys.includes(key) ? "trusted" : "untrusted";
  }
  return "untrusted";
}
