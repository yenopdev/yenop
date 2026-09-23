import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "./server.js";
import { daemonRequest, daemonHealthy, type DaemonInfo } from "./client.js";
import { rawPost } from "./fast.js";

let home: string;
let proj: string;
/** Performance gates are strict on a developer machine and relaxed on noisy CI runners (see docs/test-plan.md). */
const PERF = Number(process.env["YENOP_CI_PERF_FACTOR"] ?? 1);
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

/**
 * The median round trip of n calls. Latency gates use the median, not the mean: they measure what the warm
 * daemon is capable of, and a shared CI runner stalling one call for 300 ms says nothing about that (seen on
 * a Windows runner: mean 73 ms, median a few ms).
 */
async function medianMs(n: number, call: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await call();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)]!;
}

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
    expect(await medianMs(20, () => hook("Bash", { command: "ls -la" }))).toBeLessThan(15 * PERF); // round trip incl. receipt write; typically ~2 ms locally
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
  it("records an outcome against the project the decision was made in, not the home tenant", async () => {
    // Found live with Gemini: an approved ask read as "not run" because the outcome event carried no cwd and
    // landed on the home instance. The project is its own tenant here, so a wrong instance means no step found.
    mkdirSync(join(proj, ".yenop"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "config.json"), JSON.stringify({ mode: "enforce", tenant: { id: "tn_0123456789abcdefghijklmnop", name: "proj" } }));
    await new Promise((r) => setTimeout(r, 1100));
    const id = `outcome-${Math.random()}`;
    const ask = await hook("Bash", { command: "git push --force origin main" }, { tool_use_id: id });
    expect(ask).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    await hook("Bash", { command: "git push --force origin main" }, { tool_use_id: id, hook_event_name: "PostToolUse" });
    const lines = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; callId?: string; outcome?: string });
    expect(lines.find((l) => l.kind === "outcome" && l.callId === id)?.outcome).toBe("ran");
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
  it("denies on a malformed hook body instead of shrugging (fail closed)", async () => {
    const r = await daemonRequest<{ hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } }>(info, "/hooks/claude-code", { nonsense: true });
    expect(r.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(r.hookSpecificOutput?.permissionDecisionReason).toMatch(/malformed/);
  });
  it("answers the Cursor hook through the same route, in Cursor's language", async () => {
    const proj2 = join(home, "proj-cursor"); // its own project: an earlier test put `proj` in observe mode
    mkdirSync(proj2, { recursive: true });
    const base = { conversation_id: "c", generation_id: "g", workspace_roots: [proj2] };
    const ok = await daemonRequest<{ permission: string }>(info, "/hooks/cursor", { ...base, hook_event_name: "beforeShellExecution", command: "npm test", cwd: proj2 });
    expect(ok).toEqual({ permission: "allow" });
    const ask = await daemonRequest<{ permission: string; user_message: string }>(info, "/hooks/cursor", { ...base, hook_event_name: "beforeShellExecution", command: "rm -rf build", cwd: proj2 });
    expect(ask.permission).toBe("ask");
    const deny = await daemonRequest<{ permission: string }>(info, "/hooks/cursor", { ...base, hook_event_name: "beforeReadFile", file_path: join(proj2, ".env"), content: "" });
    expect(deny.permission).toBe("deny");
    const bad = await daemonRequest<{ permission: string }>(info, "/hooks/cursor", { nonsense: true });
    expect(bad.permission).toBe("deny");
    await expect(daemonRequest(info, "/hooks/nope", {})).rejects.toThrow(/404/);
  });
  it("is as fast for Cursor as for Claude Code", async () => {
    const body = { conversation_id: "c", generation_id: "g", workspace_roots: [proj], hook_event_name: "beforeShellExecution", command: "npm test", cwd: proj };
    await daemonRequest(info, "/hooks/cursor", body);
    expect(await medianMs(20, () => daemonRequest(info, "/hooks/cursor", body))).toBeLessThan(15 * PERF);
  });
});
