/**
 * Guards that run before a pilot cell touches anything. Pure where possible, so they are testable without a runtime.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The redaction every artifact passes through before it is written: API keys become `<REDACTED>`, the operator's home
 * directory `<HOME>`, the user name `<user>`. strace caps each string at `-s` bytes and marks the cut with `"...`, so a
 * value can survive as a prefix the whole-value replacement never matches (seen: `/home/<user prefix>"...` in a
 * Series 5 trace). A prefix that ends exactly at a truncation marker is replaced too, from `minPrefix` characters for a
 * key, and for the home directory once it runs past its parent (`/home/` plus at least one character).
 */
export function makeRedactor({ secrets = [], home = "", user = "" }) {
  const rules = [];
  for (const v of secrets) if (v.length >= 8) rules.push({ value: v, label: "<REDACTED>", minPrefix: 8 });
  if (home.length > 1) rules.push({ value: home, label: "<HOME>", minPrefix: home.lastIndexOf("/") + 2 });
  if (user.length >= 4) rules.push({ value: user, label: "<user>", minPrefix: 4 });
  const TRUNC = '"...';
  return (input) => {
    let t = String(input ?? "");
    for (const r of rules) t = t.split(r.value).join(r.label);
    if (!t.includes(TRUNC)) return t;
    let out = "";
    let from = 0;
    for (let at = t.indexOf(TRUNC); at >= 0; at = t.indexOf(TRUNC, at + TRUNC.length)) {
      let head = t.slice(from, at);
      for (const r of rules) {
        for (let k = Math.min(r.value.length - 1, head.length); k >= r.minPrefix; k--) {
          if (head.endsWith(r.value.slice(0, k))) { head = head.slice(0, head.length - k) + r.label; break; }
        }
      }
      out += head + TRUNC;
      from = at + TRUNC.length;
    }
    return out + t.slice(from);
  };
}

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
