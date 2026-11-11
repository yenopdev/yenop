import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireResultsDir, refuseIfExists, operatorRuleCheck } from "./guards.mjs";

const DRIVER = fileURLToPath(new URL("./run-05b.mjs", import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "guards-"));
const keysFile = (dir) => { const f = join(dir, "keys.md"); writeFileSync(f, "ANTHROPIC_API_KEY=not-a-real-key-0000000000\n"); return f; };
const baseEnv = (home) => ({ PATH: process.env.PATH, HOME: home, TERM: "dumb", LANG: "C" });
const runDriver = (args, env, cwd) => spawnSync(process.execPath, [DRIVER, ...args], { env, cwd, encoding: "utf8", timeout: 120000 });

describe("pilot guards (unit)", () => {
  it("requireResultsDir refuses unset or empty and resolves a value", () => {
    expect(() => requireResultsDir(undefined)).toThrow(/PILOT_RESULTS_DIR is not set/);
    expect(() => requireResultsDir("")).toThrow(/PILOT_RESULTS_DIR is not set/);
    expect(() => requireResultsDir("   ")).toThrow(/PILOT_RESULTS_DIR is not set/);
    expect(requireResultsDir("/tmp/x")).toBe("/tmp/x");
  });
  it("refuseIfExists refuses on an existing record or an existing artifact directory, and removes nothing", () => {
    const d = scratch();
    expect(() => refuseIfExists(d, "05b-a-R")).not.toThrow();
    writeFileSync(join(d, "05b-a-R.json"), "{}");
    expect(() => refuseIfExists(d, "05b-a-R")).toThrow(/05b-a-R\.json already exists/);
    mkdirSync(join(d, "05b-b-R")); writeFileSync(join(d, "05b-b-R", "keep.txt"), "x");
    expect(() => refuseIfExists(d, "05b-b-R")).toThrow(/05b-b-R\/ already exists/);
    expect(readFileSync(join(d, "05b-b-R", "keep.txt"), "utf8")).toBe("x");
    rmSync(d, { recursive: true, force: true });
  });
  it("operatorRuleCheck counts live sessions not in the allowed set, ignoring dead ones", () => {
    const d = scratch(); const sdir = join(d, "sessions"); mkdirSync(sdir);
    writeFileSync(join(sdir, "10.json"), JSON.stringify({ pid: 10, cwd: "/a" }));
    writeFileSync(join(sdir, "20.json"), JSON.stringify({ pid: 20, cwd: "/b" }));
    writeFileSync(join(sdir, "30.json"), JSON.stringify({ pid: 30, cwd: "/c" }));
    const r = operatorRuleCheck({ sessionsDir: sdir, allowedPids: [10], isAlive: (pid) => pid !== 30 });
    expect(r.live.map((s) => [s.pid, s.operator])).toEqual([[10, true], [20, false]]);
    expect(r.unrelated).toBe(1);
    expect(operatorRuleCheck({ sessionsDir: join(d, "missing"), allowedPids: [] })).toEqual({ live: [], unrelated: 0 });
    rmSync(d, { recursive: true, force: true });
  });
});

describe("pilot driver guards (subprocess, no runtime, no model)", () => {
  it("a missing PILOT_RESULTS_DIR fails before any filesystem mutation", () => {
    const home = scratch(); const cwd = scratch(); const k = keysFile(cwd);
    const before = readdirSync(cwd).sort();
    const r = runDriver(["run", k, "claude-code", "R"], { ...baseEnv(home) }, cwd);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PILOT_RESULTS_DIR is not set/);
    expect(readdirSync(cwd).sort()).toEqual(before);
    expect(readdirSync(home)).toEqual([]);
    rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  });

  it("an existing <id>.json refuses execution and leaves the directory as it was", () => {
    const home = scratch(); const results = scratch(); const k = keysFile(results);
    writeFileSync(join(results, "05b-claude-code-R.json"), "{\"keep\":true}");
    const before = readdirSync(results).sort();
    const r = runDriver(["run", k, "claude-code", "R"], { ...baseEnv(home), PILOT_RESULTS_DIR: results }, results);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/05b-claude-code-R\.json already exists/);
    expect(readdirSync(results).sort()).toEqual(before);
    expect(readFileSync(join(results, "05b-claude-code-R.json"), "utf8")).toBe("{\"keep\":true}");
    rmSync(home, { recursive: true, force: true }); rmSync(results, { recursive: true, force: true });
  });

  it("an existing <id>/ artifact directory refuses execution and is not removed", () => {
    const home = scratch(); const results = scratch(); const k = keysFile(results);
    mkdirSync(join(results, "05b-claude-code-R")); writeFileSync(join(results, "05b-claude-code-R", "evidence.txt"), "keep");
    const r = runDriver(["run", k, "claude-code", "R"], { ...baseEnv(home), PILOT_RESULTS_DIR: results }, results);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/05b-claude-code-R\/ already exists/);
    expect(readFileSync(join(results, "05b-claude-code-R", "evidence.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(results, "05b-claude-code-R.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true }); rmSync(results, { recursive: true, force: true });
  });

  it("an unrelated live Claude Code session aborts the cell before any artifact directory is created, writing only the abort record", async () => {
    const home = scratch(); const results = scratch(); const k = keysFile(results);
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" }); // a live, unrelated "session"
    try {
      mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
      writeFileSync(join(home, ".claude", "sessions", `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, cwd: "/elsewhere" }));
      const r = runDriver(["run", k, "claude-code", "R"], { ...baseEnv(home), PILOT_RESULTS_DIR: results, PILOT_OPERATOR_PIDS: String(process.pid), PILOT_FAKE_RUNTIME: "/usr/bin/true" }, results);
      expect(r.status).toBe(0);
      const rec = JSON.parse(readFileSync(join(results, "05b-claude-code-R.json"), "utf8"));
      expect(rec.status).toBe("invalid-operator-rule");
      expect(rec.operator_rule_check.unrelated_live_sessions).toBe(1);
      expect(existsSync(join(results, "05b-claude-code-R"))).toBe(false); // no artifact directory
      expect(readdirSync(results).sort()).toEqual(["05b-claude-code-R.json", "keys.md"]); // exactly one new file
    } finally { sleeper.kill("SIGKILL"); }
    rmSync(home, { recursive: true, force: true }); rmSync(results, { recursive: true, force: true });
  });

  it("a valid fresh run creates its record and artifact directory normally (fake runtime, no model)", () => {
    const home = scratch(); const results = scratch(); const k = keysFile(results);
    const r = runDriver(["run", k, "claude-code", "R"], { ...baseEnv(home), PILOT_RESULTS_DIR: results, PILOT_OPERATOR_PIDS: String(process.pid), PILOT_FAKE_RUNTIME: "/usr/bin/true" }, results);
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(results, "05b-claude-code-R.json"), "utf8"));
    expect(rec.status).toBe("completed");
    expect(rec.configuration_note).toMatch(/PILOT_FAKE_RUNTIME/);
    expect(rec.operator_rule_check.unrelated_live_sessions).toBe(0);
    const art = readdirSync(join(results, "05b-claude-code-R")).sort();
    expect(art).toEqual(expect.arrayContaining(["driver.log", "snapshot-before.json", "snapshot-after.json", "stdout.txt", "stderr.txt"]));
    expect(rec.execution_result).toBe("NOT_EXECUTED"); // nothing ran, nothing changed
    expect(rec.cleanup.tmp_removed).toBe(true);
    rmSync(home, { recursive: true, force: true }); rmSync(results, { recursive: true, force: true });
  });
});
