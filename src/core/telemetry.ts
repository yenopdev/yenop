/**
 * Opt-in, aggregate-only telemetry.
 *
 * Yenop's first promise is that your agents' actions stay on your machine. Telemetry must not bend that, so:
 *  - OFF by default. `yenop telemetry enable` turns it on; `disable` turns it off; `status` shows exactly what
 *    would be sent; `reset` issues a new install id.
 *  - What is sent is the report's numbers only: counts by verdict, by rule id, by runtime, by tool kind, plus
 *    the Yenop version and the operating system. NEVER a command, a path, a prompt, source, a hostname, a
 *    username, a project or tenant name, a receipt, or an MCP argument. The payload is built by an allow-list
 *    (`toTelemetry`), so a new field in the report cannot leak by accident; it is not sent until listed here.
 *  - The install id is random, generated when telemetry is enabled, stored locally, and replaceable with
 *    `reset`. It is not derived from hardware, the user, or the network. It exists only so that "how many
 *    installations are active" can be counted.
 *  - Sending never happens on the decision path. It is triggered by `yenop report --share` or by the daemon
 *    at most once a day, with a short timeout, and any failure is silent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { Report } from "./report.js";

export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.yenop.com/v1/report";
export const TELEMETRY_SCHEMA = 1;

export interface TelemetryState {
  enabled: boolean;
  installId?: string;
  endpoint?: string;
  lastSentAt?: string;
}

export function telemetryPath(home: string): string {
  return join(home, "telemetry.json");
}

export function readTelemetry(home: string): TelemetryState {
  const p = telemetryPath(home);
  if (!existsSync(p)) return { enabled: false };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as TelemetryState;
    return { enabled: s.enabled === true, ...(s.installId ? { installId: s.installId } : {}), ...(s.endpoint ? { endpoint: s.endpoint } : {}), ...(s.lastSentAt ? { lastSentAt: s.lastSentAt } : {}) };
  } catch {
    return { enabled: false };
  }
}

export function writeTelemetry(home: string, s: TelemetryState): void {
  const p = telemetryPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

export function enableTelemetry(home: string, endpoint?: string): TelemetryState {
  const prev = readTelemetry(home);
  const s: TelemetryState = { enabled: true, installId: prev.installId ?? newInstallId() };
  if (endpoint ?? prev.endpoint) s.endpoint = endpoint ?? prev.endpoint!;
  writeTelemetry(home, s);
  return s;
}
export function disableTelemetry(home: string): TelemetryState {
  const prev = readTelemetry(home);
  const s: TelemetryState = { ...prev, enabled: false };
  writeTelemetry(home, s);
  return s;
}
export function resetInstallId(home: string): TelemetryState {
  const prev = readTelemetry(home);
  const s: TelemetryState = { ...prev, installId: newInstallId() };
  writeTelemetry(home, s);
  return s;
}
function newInstallId(): string {
  return `inst_${randomBytes(12).toString("hex")}`;
}

/** The aggregate payload. An allow-list: only what is named here leaves the machine. */
export interface TelemetryPayload {
  schema: number;
  installId: string;
  sentAt: string;
  version: string;
  os: string;
  days: number;
  runs: number;
  actions: number;
  allow: number;
  ask: number;
  deny: number;
  observedOnly: number;
  askOutcomes: Record<string, number>;
  askApprovalRate?: number;
  askByRule: Record<string, { asked: number; allowed: number; refused: number }>;
  denyByRule: Record<string, number>;
  byRuntime: Record<string, number>;
  byToolKind: Record<string, number>;
  /** Which runtimes are hooked on this machine (names only). */
  hooked: string[];
}

export function toTelemetry(r: Report, installId: string, version: string, hooked: string[]): TelemetryPayload {
  // Rule ids are Yenop's own policy ids (baseline or the user's). A user's custom rule id could in principle be
  // descriptive; keep only ids that look like identifiers and cap their length, so a name never carries content.
  const safeKey = (k: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(k) ? k : "other");
  const fold = <T>(o: Record<string, T>, merge: (a: T, b: T) => T): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(o)) {
      const key = safeKey(k);
      out[key] = key in out ? merge(out[key]!, v) : v;
    }
    return out;
  };
  const p: TelemetryPayload = {
    schema: TELEMETRY_SCHEMA,
    installId,
    sentAt: new Date().toISOString(),
    version,
    os: `${platform()} ${release().split(".")[0] ?? ""}`.trim(),
    days: r.days,
    runs: r.runs,
    actions: r.actions,
    allow: r.allow,
    ask: r.ask,
    deny: r.deny,
    observedOnly: r.observedOnly,
    askOutcomes: { ...r.askOutcomes },
    askByRule: fold(r.askByRule, (a, b) => ({ asked: a.asked + b.asked, allowed: a.allowed + b.allowed, refused: a.refused + b.refused })),
    denyByRule: fold(r.denyByRule, (a, b) => a + b),
    byRuntime: fold(r.byRuntime, (a, b) => a + b),
    byToolKind: fold(r.byToolKind, (a, b) => a + b),
    hooked: hooked.filter((h) => /^[a-z-]{1,32}$/.test(h)),
  };
  if (r.askApprovalRate !== undefined) p.askApprovalRate = Math.round(r.askApprovalRate * 1000) / 1000;
  return p;
}

/** Send one payload. Short timeout, no retry, never throws: telemetry must never get in anyone's way. */
export async function sendTelemetry(endpoint: string, payload: TelemetryPayload, timeoutMs = 4000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Which runtimes have a Yenop hook registered: the user-level files always, the project's files when a
 * project directory is given. Names only; the paths looked at never leave this function.
 */
export function hookedRuntimes(cwd?: string): string[] {
  const has = (p: string, marker: string) => {
    try {
      return existsSync(p) && readFileSync(p, "utf8").includes(marker);
    } catch {
      return false;
    }
  };
  const roots = cwd ? [cwd, homedir()] : [homedir()];
  const files: [string, string, string][] = [
    ["claude-code", join(".claude", "settings.local.json"), "hook claude-code"],
    ["claude-code", join(".claude", "settings.json"), "hook claude-code"],
    ["cursor", join(".cursor", "hooks.json"), "hook cursor"],
    ["codex", join(".codex", "hooks.json"), "hook codex"],
    ["gemini", join(".gemini", "settings.json"), "hook gemini"],
  ];
  const out = new Set<string>();
  for (const [runtime, rel, marker] of files) if (roots.some((r) => has(join(r, rel), marker))) out.add(runtime);
  return [...out];
}

/**
 * The runtimes to report as hooked: the ones the hook files name (`hookedRuntimes`, user level and every project
 * directory the caller knows about) plus every runtime that actually delivered an action in the report. The file
 * check alone under-reports: the daemon restarts whenever the build changes and its list of served projects starts
 * empty, and a hook can live in a settings file the check does not read. A recorded action cannot be wrong about a
 * runtime being hooked. Names only, never paths; ids are validated the same way the receiver validates them.
 */
export function unionHooked(fromFiles: string[], byRuntime: Record<string, number>): string[] {
  const out = new Set<string>(fromFiles);
  for (const [k, n] of Object.entries(byRuntime)) if (n > 0 && /^[a-z][a-z-]{1,31}$/.test(k)) out.add(k);
  return [...out].sort();
}

/** Has it been at least a day since the last send? The daemon uses this so a send is at most daily. */
export function dueForDaily(s: TelemetryState, now = Date.now()): boolean {
  if (!s.enabled || !s.installId) return false;
  if (!s.lastSentAt) return true;
  return now - new Date(s.lastSentAt).getTime() >= 24 * 3600 * 1000;
}
