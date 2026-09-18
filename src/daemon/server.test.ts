import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "./server.js";
import { daemonRequest, daemonHealthy, type DaemonInfo } from "./client.js";
import { rawPost } from "./fast.js";

let home: string;
let proj: string;
let d: RunningDaemon;
let info: DaemonInfo;
const logs: string[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "yenop-daemon-"));
  proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  d = await startDaemon({ home, port: 0, register: false, log: (l) => logs.push(l) });
  info = d.info;
});
afterAll(async () => {
  await d.close();
  rmSync(home, { recursive: true, force: true });
});

const hook = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  daemonRequest<Record<string, unknown>>(info, "/hooks/claude-code", { session_id: "s", cwd: proj, tool_name: tool, tool_input: input, tool_use_id: `t${Math.random()}`, ...extra });

describe("daemon", () => {
  it("reports health without a token", async () => {
    const h = await daemonHealthy(info);
    expect(h?.ok).toBe(true);
    expect(h?.buildId).toBeTruthy();
  });
  it("refuses decisions without the token", async () => {
    const bad = { ...info, token: "nope" };
    await expect(daemonRequest(bad, "/decide", { request: {} })).rejects.toThrow(/401/);
  });
  it("answers the Claude Code hook: silent on allow, ask and deny as hook JSON", async () => {
    expect(await hook("Bash", { command: "npm test" })).toEqual({});
    const ask = await hook("Bash", { command: "terraform destroy" });
    expect(ask).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const deny = await hook("Bash", { command: "cat ~/.ssh/id_ed25519" });
    expect(deny).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it("is fast once warm", async () => {
    await hook("Bash", { command: "ls" });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await hook("Bash", { command: "ls -la" });
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(15); // round trip incl. receipt write; typically ~2 ms
  });
  it("writes receipts and counts decisions", async () => {
    const h = await daemonHealthy(info);
    expect(h?.decisions).toBeGreaterThan(20);
    const lines = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(20);
  });
  it("picks up a policy change on disk without a restart", async () => {
    expect(await hook("Bash", { command: "echo hello" })).toEqual({});
    mkdirSync(join(proj, ".yenop", "policies", "approve"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "policies", "approve", "echo.cedar"), `@id("no-echo") permit (principal, action, resource) when { context has shell && context.shell.programs.contains("echo") };`);
    await new Promise((r) => setTimeout(r, 1100)); // fingerprint is re-checked at most once per second
    expect(await hook("Bash", { command: "echo hello" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });
  it("stays silent in observe mode", async () => {
    mkdirSync(join(proj, ".yenop"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "config.json"), JSON.stringify({ mode: "observe" }));
    await new Promise((r) => setTimeout(r, 1100));
    expect(await hook("Bash", { command: "cat ~/.ssh/id_ed25519" })).toEqual({});
  });
  it("serves /decide for other adapters", async () => {
    const r = await daemonRequest<{ effect: string }>(info, "/decide", {
      cwd: proj,
      request: { runId: "r", principal: { runtime: "test", agent: "m", user: "u" }, tool: { name: "Bash", kind: "shell", readOnly: false }, args: { command: "rm -rf /tmp/x" } },
    });
    expect(r.effect).toBe("ask");
  });
  it("answers the raw-socket client the command hook uses", async () => {
    const r = await rawPost(info, "/hooks/claude-code", JSON.stringify({ session_id: "raw", cwd: join(home, "other"), tool_name: "Bash", tool_input: { command: "git push --force" }, tool_use_id: "raw1" }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const bad = await rawPost({ ...info, token: "x" }, "/hooks/claude-code", "{}");
    expect(bad.status).toBe(401);
  });
  it("denies everything in a project whose policies are invalid, then recovers once fixed", async () => {
    const p2 = join(home, "proj2");
    mkdirSync(join(p2, ".yenop", "policies", "approve"), { recursive: true });
    const f = join(p2, ".yenop", "policies", "approve", "bad.cedar");
    writeFileSync(f, `@id("bad") permit (principal, action == Action::"Bash", resource);`);
    const call = () => daemonRequest<Record<string, { permissionDecision?: string; permissionDecisionReason?: string }>>(info, "/hooks/claude-code", { session_id: "p2", cwd: p2, tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: `p${Math.random()}` });
    const denied = await call();
    expect(denied["hookSpecificOutput"]?.permissionDecision).toBe("deny");
    expect(denied["hookSpecificOutput"]?.permissionDecisionReason).toMatch(/cannot load its policies/);
    writeFileSync(f, `@id("bad") permit (principal, action == Yenop::Action::"call", resource) when { context has shell && context.shell.sudo };`);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await call()).toEqual({});
  });
  it("records the outcome events Claude Code sends after an ask", async () => {
    const p3 = join(home, "proj3");
    mkdirSync(p3, { recursive: true });
    const base = { session_id: "out", cwd: p3, tool_name: "Bash", tool_input: { command: "rm -rf dist" }, tool_use_id: "toolu_out_1" };
    expect(await daemonRequest<Record<string, unknown>>(info, "/hooks/claude-code", { ...base, hook_event_name: "PreToolUse" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await daemonRequest<Record<string, unknown>>(info, "/hooks/claude-code", { ...base, hook_event_name: "PostToolUse", tool_response: "ok" })).toEqual({});
    const lines = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; callId?: string; outcome?: string });
    expect(lines.filter((l) => l.kind === "outcome" && l.callId === "toolu_out_1")).toEqual([expect.objectContaining({ outcome: "ran" })]);
  });
  it("never blocks on a malformed hook body", async () => {
    const r = await daemonRequest<Record<string, unknown>>(info, "/hooks/claude-code", { nonsense: true });
    expect(r).toEqual({});
  });
});
