import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openYenop, type Yenop } from "./index.js";
import { buildReport, renderReport } from "./report.js";
import { toTelemetry, readTelemetry, enableTelemetry, disableTelemetry, resetInstallId, dueForDaily, unionHooked } from "./telemetry.js";

let home: string;
let y: Yenop;
const req = (runId: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  runId, principal: { runtime: "claude-code", agent: "main", user: "ertunc" }, tool: { name: tool, kind: tool === "Bash" ? ("shell" as const) : ("write" as const), readOnly: false }, args, callId: `${runId}-${Math.random()}`, ...extra,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-report-"));
  y = openYenop({ home, cwd: home });
  y.decide(req("r1", "Bash", { command: "npm test" }));
  y.decide(req("r1", "Bash", { command: "cat .env" }));
  const ask1 = y.decide(req("r1", "Bash", { command: "rm -rf build" }));
  y.recordOutcome("r1", (ask1 as { replayed?: boolean }).replayed ? "x" : "unused", "Bash", "ran"); // no matching call id: ignored
  y.decide(req("r2", "Bash", { command: "git push --force origin main" }));
});
afterEach(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

describe("yenop report", () => {
  it("aggregates verdicts, runs, rules and runtimes from the receipts", () => {
    const r = buildReport(y.config, { days: 7 });
    expect(r.runs).toBe(2);
    expect(r.actions).toBe(4);
    expect(r.allow).toBe(1);
    expect(r.deny).toBe(1);
    expect(r.ask).toBe(2);
    expect(r.denyByRule["no-secret-files"]).toBe(1);
    expect(r.askByRule["destructive-shell"]?.asked).toBeGreaterThanOrEqual(1);
    expect(r.byRuntime["claude-code"]).toBe(4);
    expect(r.byToolKind["shell"]).toBe(4);
    expect(r.askApprovalRate).toBeUndefined(); // nothing answered yet
  });
  it("computes the ask calibration once asks are answered", () => {
    // approve the forced push: record that it ran
    const lines = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { effect: string; callId?: string; runId: string; kind?: string });
    const push = lines.find((l) => l.kind === "decision" && l.effect === "ask" && l.runId === "r2")!;
    y.recordOutcome("r2", push.callId!, "Bash", "ran");
    const r = buildReport(y.config, { days: 7 });
    expect(r.askOutcomes["approved, ran"]).toBe(1);
    expect(r.askByRule["outbound-writes-from-shell"]?.allowed ?? r.askByRule["destructive-shell"]?.allowed).toBeGreaterThanOrEqual(1);
    expect(r.askApprovalRate).toBeDefined();
  });
  it("renders as readable text and says so when empty", () => {
    const text = renderReport(buildReport(y.config, { days: 7 }));
    expect(text).toMatch(/ALLOW\s+1/);
    expect(text).toMatch(/DENY\s+1/);
    expect(text).toMatch(/no-secret-files/);
    const fresh = mkdtempSync(join(tmpdir(), "yenop-report-empty-"));
    const y2 = openYenop({ home: fresh, cwd: fresh, dryRun: true });
    try {
      expect(renderReport(buildReport(y2.config, { days: 7 }))).toMatch(/No actions recorded/);
    } finally {
      y2.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("telemetry", () => {
  it("is off by default, and enable issues a random install id that reset replaces", () => {
    expect(readTelemetry(home)).toEqual({ enabled: false });
    const on = enableTelemetry(home);
    expect(on.enabled).toBe(true);
    expect(on.installId).toMatch(/^inst_[0-9a-f]{24}$/);
    const again = enableTelemetry(home);
    expect(again.installId).toBe(on.installId); // stable across enables
    const reset = resetInstallId(home);
    expect(reset.installId).not.toBe(on.installId);
    expect(disableTelemetry(home).enabled).toBe(false);
    expect(readTelemetry(home).installId).toBe(reset.installId); // kept, but nothing is sent while off
  });
  it("the payload is an allow-list: numbers and ids only, never content or identity", () => {
    const r = buildReport(y.config, { days: 7 });
    const p = toTelemetry(r, "inst_abc", "0.0.2", ["claude-code", "codex"]);
    const text = JSON.stringify(p);
    for (const forbidden of ["npm test", "cat .env", ".env", "rm -rf", "git push", home, "ertunc", "claude-code:", "playground", "local"]) {
      expect(text, `payload must not contain ${JSON.stringify(forbidden)}`).not.toContain(forbidden === "local" ? '"scope"' : forbidden);
    }
    expect(text).not.toContain("scope");
    expect(text).not.toContain("tenant");
    expect(p.actions).toBe(4);
    expect(p.denyByRule["no-secret-files"]).toBe(1);
    expect(p.hooked).toEqual(["claude-code", "codex"]);
    expect(p.os).toMatch(/^(darwin|linux|win32)/);
  });
  it("folds a rule id that could carry content into 'other'", () => {
    const r = buildReport(y.config, { days: 7 });
    r.denyByRule["my secret project name with spaces"] = 3;
    r.askByRule["x".repeat(80)] = { asked: 1, allowed: 0, refused: 1 };
    const p = toTelemetry(r, "inst_abc", "0.0.2", []);
    expect(p.denyByRule["other"]).toBe(3);
    expect(Object.keys(p.askByRule).every((k) => k.length <= 64)).toBe(true);
  });
  it("is due daily, not more often, and never while off", () => {
    expect(dueForDaily({ enabled: false, installId: "i" })).toBe(false);
    expect(dueForDaily({ enabled: true, installId: "i" })).toBe(true);
    const justSent = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(dueForDaily({ enabled: true, installId: "i", lastSentAt: justSent })).toBe(false);
    const yesterday = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    expect(dueForDaily({ enabled: true, installId: "i", lastSentAt: yesterday })).toBe(true);
  });
});

describe("unionHooked", () => {
  it("adds every runtime that delivered an action to the ones found in hook files", () => {
    expect(unionHooked(["gemini"], { "claude-code": 63, cursor: 2 })).toEqual(["claude-code", "cursor", "gemini"]);
  });
  it("ignores runtimes with no actions, ids the receiver would reject, and duplicates", () => {
    expect(unionHooked(["cursor"], { cursor: 5, codex: 0, t: 2, "Bad Id": 9, "": 1 })).toEqual(["cursor"]);
  });
  it("is the file list alone when nothing ran", () => {
    expect(unionHooked(["codex", "gemini"], {})).toEqual(["codex", "gemini"]);
  });
});
