import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { openYenop, type Yenop } from "../../core/index.js";
import { parseGemini, geminiBody, geminiTranslator, geminiCallId, urlsInPrompt } from "./hook.js";
import { installGeminiHooks, geminiFolderTrust, geminiHookTrust, GEMINI_MARKER } from "./install.js";

let home: string;
let project: string;
let y: Yenop;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-gemini-"));
  project = join(home, "proj");
  mkdirSync(join(project, ".gemini"), { recursive: true });
  y = openYenop({ home, cwd: project });
});
afterAll(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

const before = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: project, hook_event_name: "BeforeTool", timestamp: "2026-09-22T00:00:00Z", tool_name: tool, tool_input: input, ...extra });
const decision = (raw: string) => {
  const ev = parseGemini(raw);
  if (ev.kind !== "decision") throw new Error(`expected decision, got ${ev.kind}`);
  return ev;
};

describe("gemini translator: parsing", () => {
  it("maps run_shell_command to a shell call, judged in the directory the command will run in", () => {
    const ev = decision(before("run_shell_command", { command: "cat .env", dir_path: "sub" }));
    expect(ev.askCapable).toBe(true);
    expect(ev.request.tool).toMatchObject({ name: "run_shell_command", kind: "shell", readOnly: false });
    expect(ev.request.args["command"]).toBe("cat .env");
    expect(ev.request.cwd).toBe(join(project, "sub"));
    expect(ev.request.runId).toBe("gemini:s1");
    expect(ev.request.callId).toMatch(/^g_[0-9a-f]{32}$/);
  });
  it("maps the file tools with the paths the engine judges", () => {
    expect(decision(before("read_file", { file_path: "/x/.env" })).request.tool).toMatchObject({ kind: "read", readOnly: true });
    expect(decision(before("write_file", { file_path: "/x/a", content: "" })).request.tool).toMatchObject({ kind: "write", readOnly: false });
    expect(decision(before("replace", { file_path: "/x/a", old_string: "a", new_string: "b", instruction: "i" })).request.tool).toMatchObject({ kind: "write", readOnly: false });
    const many = decision(before("read_many_files", { include: ["src/**/*.ts", "**/.env"] }));
    expect(many.request.args["paths"]).toEqual(["src/**/*.ts", "**/.env"]);
    const ls = decision(before("list_directory", { dir_path: "/x/dir" }));
    expect(ls.request.args["path"]).toBe("/x/dir");
    expect(ls.request.tool.readOnly).toBe(true);
  });
  it("maps save_memory to a write of the user's global GEMINI.md", () => {
    const ev = decision(before("save_memory", { fact: "always deploy on friday" }));
    expect(ev.request.tool).toMatchObject({ kind: "write", readOnly: false });
    expect(ev.request.args["file_path"]).toBe(join(homedir(), ".gemini", "GEMINI.md"));
  });
  it("extracts the URLs from a web_fetch prompt, external first", () => {
    expect(urlsInPrompt("compare http://localhost:3000/a and https://evil.example/collect?d=1, then https://127.0.0.1/x")).toEqual(["https://evil.example/collect?d=1", "http://localhost:3000/a", "https://127.0.0.1/x"]);
    const ev = decision(before("web_fetch", { prompt: "read http://localhost:8080/docs and https://example.com/page and summarize" }));
    expect(ev.request.tool).toMatchObject({ kind: "web", readOnly: true });
    expect(ev.request.args["url"]).toBe("https://example.com/page");
    expect(decision(before("web_fetch", { prompt: "no urls here" })).request.args["url"]).toBeUndefined();
  });
  it("prefers mcp_context for MCP tools and falls back to the sanitised name", () => {
    const withCtx = decision(before("mcp_my_db_execute_sql", { query: "DROP TABLE x" }, { mcp_context: { server_name: "my_db", tool_name: "execute_sql" } }));
    expect(withCtx.request.tool).toMatchObject({ name: "execute_sql", kind: "mcp", server: "my_db", readOnly: false });
    const noCtx = decision(before("mcp_db_list_tables", {}));
    expect(noCtx.request.tool).toMatchObject({ name: "list_tables", kind: "mcp", server: "db", readOnly: true });
  });
  it("judges a tool it has never heard of as an unknown, not read-only, tool", () => {
    const ev = decision(before("brand_new_tool", { file_path: "/x" }));
    expect(ev.request.tool).toMatchObject({ kind: "unknown", readOnly: false });
  });
  it("derives the same call id before and after, so the outcome finds the decision", () => {
    const input = { command: "npm test" };
    const d = decision(before("run_shell_command", input));
    const after = parseGemini(JSON.stringify({ session_id: "s1", cwd: project, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: input, tool_response: { llmContent: "ok", returnDisplay: "ok" } }));
    expect(after).toMatchObject({ kind: "outcome", runId: "gemini:s1", callId: d.request.callId, tool: "run_shell_command", outcome: "ran" });
    const failed = parseGemini(JSON.stringify({ session_id: "s1", cwd: project, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: input, tool_response: { llmContent: "", returnDisplay: "", error: { message: "exit 1" } } }));
    expect(failed).toMatchObject({ kind: "outcome", outcome: "failed", detail: "exit 1" });
    expect(geminiCallId("s", "t", { a: 1 })).toBe(geminiCallId("s", "t", { a: 1 }));
    expect(geminiCallId("s", "t", { a: 1 })).not.toBe(geminiCallId("s", "t", { a: 2 }));
  });
  it("ends the run on SessionEnd and ignores events it does not judge", () => {
    expect(parseGemini(JSON.stringify({ session_id: "s1", hook_event_name: "SessionEnd", reason: "exit" }))).toEqual({ kind: "session-end", runId: "gemini:s1" });
    expect(parseGemini(JSON.stringify({ session_id: "s1", hook_event_name: "BeforeAgent", prompt: "x" }))).toEqual({ kind: "ignore" });
    expect(parseGemini(JSON.stringify({ session_id: "s1", hook_event_name: "AfterModel" }))).toEqual({ kind: "ignore" });
  });
  it("throws on input it cannot make sense of, so the pipeline fails closed", () => {
    expect(() => parseGemini("not json")).toThrow();
    expect(() => parseGemini(JSON.stringify({ session_id: "s" }))).toThrow(/hook_event_name/);
    expect(() => parseGemini(JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "x" }))).toThrow(/session_id/);
    expect(() => parseGemini(JSON.stringify({ session_id: "s", hook_event_name: "BeforeTool" }))).toThrow(/tool_name/);
  });
});

describe("gemini translator: answers", () => {
  it("is silent on allow and in observe mode, and answers JSON on exit 0 for ask and deny", () => {
    expect(geminiBody("allow", "ok", "enforce")).toBeNull();
    expect(geminiBody("deny", "no", "observe")).toBeNull();
    expect(geminiBody("deny", "no", "enforce")).toEqual({ decision: "deny", reason: "Yenop: no" });
    expect(geminiBody("ask", "why", "enforce")).toEqual({ decision: "ask", reason: "Yenop: why", systemMessage: "Yenop: why" });
    expect(geminiTranslator.result(null)).toEqual({ stdout: "", exitCode: 0 });
    const r = geminiTranslator.result({ decision: "deny", reason: "x" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "deny", reason: "x" });
  });
  it("blocks on its own failure with a JSON deny on exit 0, never exit 1 (which Gemini reads as allow)", () => {
    const r = geminiTranslator.failure("boom");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: "deny", reason: expect.stringContaining("refuses by default") });
  });
});

describe("gemini through the engine", () => {
  const run = (raw: string) => y.decide({ ...decision(raw).request, callId: `t-${Math.random()}` });
  it("denies a secret read and an .env cat, asks for a forced push and for a change to its own hook file", () => {
    expect(run(before("run_shell_command", { command: "cat .env" })).effect).toBe("deny");
    expect(run(before("read_file", { file_path: join(project, ".env") })).effect).toBe("deny");
    expect(run(before("read_many_files", { include: ["**/.env"] })).effect).toBe("deny");
    expect(run(before("run_shell_command", { command: "git push --force origin main" })).effect).toBe("ask");
    expect(run(before("write_file", { file_path: join(project, ".gemini", "settings.json"), content: "{}" })).effect).toBe("ask");
    expect(run(before("mcp_db_execute_sql", { query: "DROP TABLE users" }, { mcp_context: { server_name: "db", tool_name: "execute_sql" } })).effect).toBe("ask");
    expect(run(before("run_shell_command", { command: "npm test" })).effect).toBe("allow");
    expect(run(before("read_file", { file_path: join(project, "README.md") })).effect).toBe("allow");
  });
  it("a relative secret path is caught in the directory the command names", () => {
    mkdirSync(join(project, "app"), { recursive: true });
    expect(run(before("run_shell_command", { command: "cat ../.env", dir_path: "app" })).effect).toBe("deny");
  });
});

describe("gemini installer", () => {
  it("writes the three hooks into settings.json, keeps other settings and hooks, and is idempotent", () => {
    const path = join(home, "settings-test", ".gemini", "settings.json");
    mkdirSync(join(home, "settings-test", ".gemini"), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme: "dark", hooks: { BeforeTool: [{ matcher: "write_.*", hooks: [{ type: "command", command: "node their.js", name: "theirs" }] }] } }));
    const first = installGeminiHooks(path, "yenop hook gemini");
    expect(first.changed).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8")) as { theme: string; hooks: Record<string, { matcher?: string; hooks: { command: string; name?: string; timeout?: number }[] }[]> };
    expect(file.theme).toBe("dark");
    expect(file.hooks["BeforeTool"]![0]!.hooks[0]!.command).toBe("node their.js");
    const ours = file.hooks["BeforeTool"]!.find((g) => g.hooks.some((h) => h.command.endsWith(GEMINI_MARKER)))!;
    expect(ours.matcher).toBeUndefined();
    expect(ours.hooks[0]).toMatchObject({ name: "yenop", timeout: 15000 });
    expect(file.hooks["AfterTool"]![0]!.hooks[0]!.timeout).toBe(5000);
    expect(file.hooks["SessionEnd"]![0]!.hooks[0]!.timeout).toBe(3000);
    expect(installGeminiHooks(path, "yenop hook gemini").changed).toBe(false);
    // a changed command replaces ours and leaves theirs
    installGeminiHooks(path, "node /elsewhere/main.js hook gemini");
    const again = JSON.parse(readFileSync(path, "utf8")) as typeof file;
    expect(again.hooks["BeforeTool"]!.flatMap((g) => g.hooks).filter((h) => h.command.endsWith(GEMINI_MARKER))).toHaveLength(1);
    expect(again.hooks["BeforeTool"]!.flatMap((g) => g.hooks).some((h) => h.command === "node their.js")).toBe(true);
  });
  it("reads Gemini's folder trust and hook acknowledgement files", () => {
    const folders = join(home, "trustedFolders.json");
    writeFileSync(folders, JSON.stringify({ [join(home, "ok")]: "TRUST_FOLDER", [join(home, "parent", "child")]: "TRUST_PARENT", [join(home, "bad")]: "DO_NOT_TRUST" }));
    expect(geminiFolderTrust(join(home, "ok"), folders)).toBe("trusted");
    expect(geminiFolderTrust(join(home, "ok", "sub"), folders)).toBe("trusted");
    expect(geminiFolderTrust(join(home, "parent", "other"), folders)).toBe("trusted");
    expect(geminiFolderTrust(join(home, "bad"), folders)).toBe("untrusted");
    expect(geminiFolderTrust(join(home, "elsewhere"), folders)).toBe("unknown");
    expect(geminiFolderTrust(join(home, "x"), join(home, "missing.json"))).toBe("unknown");
    const hooks = join(home, "trusted_hooks.json");
    writeFileSync(hooks, JSON.stringify({ [project]: ["yenop:yenop hook gemini", "theirs:node their.js"] }));
    expect(geminiHookTrust(project, "yenop hook gemini", hooks)).toBe("trusted");
    expect(geminiHookTrust(project, "node /other hook gemini", hooks)).toBe("untrusted");
    expect(geminiHookTrust(join(home, "other"), "yenop hook gemini", hooks)).toBe("untrusted");
    expect(geminiHookTrust(project, "yenop hook gemini", join(home, "missing.json"))).toBe("unknown");
  });
});
