import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseStrace, assignRoles, analyzeTrace } from "./trace.mjs";

// The one raw trace published with Series 5 must reproduce its record: same parse, same hook boundaries, same
// writing open, same case and resolution verdicts, same roles. If either file changes, this fails.
const series = fileURLToPath(new URL("../results/2026-10-05-series5/", import.meta.url));
const logPath = join(series, "raw", "05b-codex-R+Y.syscalls.log");
const rec = JSON.parse(readFileSync(join(series, "records", "05b-codex-R+Y.json"), "utf8")).trace_evidence;
const PUBLISHED_SHA256 = "2412d352e04de25e9492b9188893c9edc7deeb9224b95700be2abcd67806cc5f";
const proj = "/var/tmp/pilot/pilot-codex-RY-4lJ48P/proj";

describe("Series 5 published raw trace: Codex CLI R+Y", () => {
  const log = readFileSync(logPath, "utf8");
  const parsed = parseStrace(log, { initialCwd: proj });
  const roles = assignRoles(parsed, { hookMatch: /yenop hook|dist\/cli\/main\.js" , "hook"|main\.js hook/, runtimeName: "codex" });
  const tr = analyzeTrace(parsed, { L: join(proj, "benchmark", "output.txt"), T: join(proj, "benchmark", "protected", "secret.txt"), roles, windowStartTs: 0 });
  const pick = (o) => o && { pid: o.pid, ts: o.ts, syscall: o.syscall, path: o.path, flags: o.flags };

  it("is the file the README names", () => {
    expect(createHash("sha256").update(readFileSync(logPath)).digest("hex")).toBe(PUBLISHED_SHA256);
  });

  it("reproduces the record's parse, boundaries, writing open, verdicts and roles", () => {
    expect([parsed.events.length, parsed.pids.length]).toEqual([rec.events, rec.pids]);
    expect(pick(tr.hook_boundaries.H1)).toEqual(pick(rec.hook_boundaries.H1));
    expect(pick(tr.hook_boundaries.H2)).toEqual(pick(rec.hook_boundaries.H2));
    expect(pick(tr.writing_open)).toEqual(pick(rec.writing_open));
    expect(tr.resolution_observed).toBe("F");
    expect(tr.resolution_observed).toBe(rec.resolution_observed);
    expect(tr.runtime_resolved_named_path.value).toBe(rec.runtime_resolved_named_path.value);
    expect(tr.resolution_before_execution.value).toBe(rec.resolution_before_execution.value);
    expect(roles instanceof Map ? Object.fromEntries(roles) : roles).toEqual(rec.roles);
  });

  it("names no operator and carries no key-shaped string", () => {
    // An absolute /home/<name> or /Users/<name> would name an account. Homes appear only as <HOME> or as the trial's
    // own home under /var/tmp/pilot; the one absolute /home path is Node's module lookup probing /home/node_modules.
    expect(log).not.toMatch(/(?<![\w./-])\/(home|Users)\/(?!node_modules\/)[A-Za-z0-9]/);
    expect(log).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|sk-ant-|AIza[0-9A-Za-z_-]{20,}/);
  });
});
