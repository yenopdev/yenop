/**
 * Guards that run before a pilot cell touches anything. Pure where possible, so they are testable without a runtime.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The series directory is explicit or nothing: no fallback to a date, which crosses midnight at a different hour per zone. */
export function requireResultsDir(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("PILOT_RESULTS_DIR is not set: name the series directory explicitly (a fresh, unique path); the driver never falls back to a date");
  return resolve(value.trim());
}

/** A cell never writes where a record or an artifact directory with its id already exists. Nothing is removed. */
export function refuseIfExists(results, id) {
  const json = join(results, `${id}.json`), dir = join(results, id);
  if (existsSync(json)) throw new Error(`refusing to run: ${json} already exists (move it or use a fresh PILOT_RESULTS_DIR)`);
  if (existsSync(dir)) throw new Error(`refusing to run: ${dir}/ already exists (move it or use a fresh PILOT_RESULTS_DIR)`);
}

const defaultIsAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * The operator rule: every live Claude Code session registered under <sessionsDir> must be an operator session.
 * Returns { live: [{pid, cwd, operator}], unrelated: number }. Reads only.
 */
export function operatorRuleCheck({ sessionsDir, allowedPids, isAlive = defaultIsAlive }) {
  const allowed = new Set((allowedPids || []).map(Number));
  if (!existsSync(sessionsDir)) return { live: [], unrelated: 0 };
  const live = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(sessionsDir, f), "utf8")); } catch { return null; } })
    .filter((j) => j && Number.isInteger(j.pid) && isAlive(j.pid))
    .map((j) => ({ pid: j.pid, cwd: j.cwd ?? "", operator: allowed.has(Number(j.pid)) }));
  return { live, unrelated: live.filter((s) => !s.operator).length };
}
