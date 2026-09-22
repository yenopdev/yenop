import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodex, codexBody, codexTranslator, pathsInPatch } from "./hook.js";
import { runHookWith, type HookEvent } from "../hooks/pipeline.js";
import { installCodexHooks, codexHookState, CODEX_REPORT_EVENTS } from "./install.js";

const base = { session_id: "s1", cwd: "/p", permission_mode: "default", turn_id: "t", model: "x", transcript_path: null };
const ev = (name: string, fields: Record<string, unknown>) => JSON.stringify({ ...base, hook_event_name: name, ...fields });
const decision = (e: HookEvent) => {
  if (e.kind !== "decision") throw new Error(`expected decision, got ${e.kind}`);
  return e;
};
const PATCH = `*** Begin Patch
*** Update File: src/app.ts
@@
-a
+b
*** Add File: .codex/hooks.json
+{}
*** End Patch`;

describe("codex translator: parsing", () => {
  it("maps a Bash call, and nothing in Codex can ask", () => {
    const e = decision(parseCodex(ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "c1" })));
    expect(e.askCapable).toBe(false);
    expect(e.request).toMatchObject({ runId: "codex:s1", cwd: "/p", callId: "c1", permissionMode: "default", tool: { name: "Bash", kind: "shell" }, args: { command: "rm -rf build" }, principal: { runtime: "codex" } });
  });
  it("maps an MCP tool the same way Claude Code names them", () => {
    const e = decision(parseCodex(ev("PreToolUse", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "DELETE FROM x" }, tool_use_id: "c2" })));
    expect(e.request.tool).toMatchObject({ kind: "mcp", server: "supabase", readOnly: false });
  });
  it("reads every file a patch touches, from a string or an object input", () => {
    expect(pathsInPatch(PATCH)).toEqual(["src/app.ts", ".codex/hooks.json"]);
    const s = decision(parseCodex(ev("PreToolUse", { tool_name: "apply_patch", tool_input: PATCH, tool_use_id: "c3" })));
    expect(s.request.tool).toMatchObject({ name: "apply_patch", kind: "write", readOnly: false });
    expect(s.request.args["file_path"]).toBe("src/app.ts");
    expect(s.request.args["paths"]).toEqual(["src/app.ts", ".codex/hooks.json"]);
    const o = decision(parseCodex(ev("PreToolUse", { tool_name: "apply_patch", tool_input: { patch: PATCH }, tool_use_id: "c4" })));
    expect(o.request.args["paths"]).toEqual(["src/app.ts", ".codex/hooks.json"]);
  });
  it("reads the patch from tool_input.command, which is what Codex 0.155 really sends", () => {
    const real = decision(parseCodex(ev("PreToolUse", { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: /p/.codex/hooks.json\n@@\n {\n+  \"$comment\": \"hi\",\n*** End Patch" }, tool_use_id: "exec-1" })));
    expect(real.request.args["paths"]).toEqual(["/p/.codex/hooks.json"]);
  });
  it("refuses a patch whose target files it cannot determine, instead of judging it harmless", () => {
    expect(() => parseCodex(ev("PreToolUse", { tool_name: "apply_patch", tool_input: { something_new: "x" }, tool_use_id: "c9" }))).toThrow(/no recognizable target files/);
    expect(() => parseCodex(ev("PreToolUse", { tool_name: "apply_patch", tool_input: { command: "not a patch at all" }, tool_use_id: "c10" }))).toThrow(/no recognizable target files/);
  });
  it("keeps a plain file_path on Edit/Write-shaped inputs", () => {
    const e = decision(parseCodex(ev("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/p/.env", content: "x" }, tool_use_id: "c5" })));
    expect(e.request.args["file_path"]).toBe("/p/.env");
  });
  it("turns PostToolUse into an outcome and SessionEnd into session-end", () => {
    expect(parseCodex(ev("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: {}, tool_use_id: "c1" }))).toMatchObject({ kind: "outcome", callId: "c1", outcome: "ran", runId: "codex:s1" });
    // cwd rides along so the outcome and the end of the run reach the project instance the decision used
    expect(parseCodex(ev("SessionEnd", { reason: "other" }))).toMatchObject({ kind: "session-end", runId: "codex:s1", cwd: expect.any(String) });
  });
  it("ignores events it does not judge, and fails closed on malformed input", () => {
    for (const n of ["UserPromptSubmit", "PreCompact", "Stop", "SubagentStart"]) expect(parseCodex(ev(n, {})).kind).toBe("ignore");
    expect(() => parseCodex("nope")).toThrow();
    expect(() => parseCodex("{}")).toThrow(/hook_event_name/);
    expect(() => parseCodex(ev("PreToolUse", { tool_input: {} }))).toThrow(/tool_name/);
  });
});

describe("codex translator: answers", () => {
  it("is silent on allow and in observe mode, because silence is the one answer Codex cannot misread", () => {
    expect(codexBody("allow", "ok", "enforce")).toBeNull();
    expect(codexBody("deny", "x", "observe")).toBeNull();
  });
  it("denies with exit 2 and the reason on stderr, plus the JSON on stdout", () => {
    const r = codexTranslator.result(codexBody("deny", "Blocked by policy no-secret-files.", "enforce"));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("Yenop: Blocked by policy no-secret-files.");
    expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it("turns every ask into a deny, since an ask would make Codex proceed", () => {
    const b = codexBody("ask", "Needs a person: destructive-shell.", "enforce")!;
    const h = b["hookSpecificOutput"] as { permissionDecision: string; permissionDecisionReason: string };
    expect(h.permissionDecision).toBe("deny");
    expect(h.permissionDecisionReason).toMatch(/Codex cannot ask a person/);
    expect(JSON.stringify(b)).not.toContain('"ask"');
  });
  it("blocks with exit 2 when Yenop itself failed", () => {
    const r = codexTranslator.failure("policies unreadable");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/refuses by default/);
  });
});

describe("codex hooks end to end (in-process, no daemon)", () => {
  let home: string;
  let proj: string;
  const prevHome = process.env["YENOP_HOME"];
  const prevNoDaemon = process.env["YENOP_NO_DAEMON"];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yenop-codex-"));
    proj = join(home, "proj");
    mkdirSync(join(proj, ".codex"), { recursive: true });
    process.env["YENOP_HOME"] = home;
    process.env["YENOP_NO_DAEMON"] = "1";
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env["YENOP_HOME"]; else process.env["YENOP_HOME"] = prevHome;
    if (prevNoDaemon === undefined) delete process.env["YENOP_NO_DAEMON"]; else process.env["YENOP_NO_DAEMON"] = prevNoDaemon;
    rmSync(home, { recursive: true, force: true });
  });
  const run = (name: string, fields: Record<string, unknown>) => runHookWith(codexTranslator, JSON.stringify({ ...base, cwd: proj, hook_event_name: name, ...fields }));

  it("is silent on ordinary work and blocks a secret read with exit 2", async () => {
    expect(await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "e1" })).toEqual({ stdout: "", exitCode: 0 });
    const r = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "cat .env" }, tool_use_id: "e2" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no-secret-files/);
  });
  it("blocks what would have been an ask, and says why", async () => {
    const r = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "e3" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/destructive-shell/);
    expect(r.stderr).toMatch(/Codex cannot ask/);
  });
  it("judges a patch by its strictest file: one touching the hook registration is refused", async () => {
    const ok = await run("PreToolUse", { tool_name: "apply_patch", tool_input: `*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch`, tool_use_id: "e4" });
    expect(ok).toEqual({ stdout: "", exitCode: 0 });
    const bad = await run("PreToolUse", { tool_name: "apply_patch", tool_input: PATCH, tool_use_id: "e5" });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toMatch(/changes-to-yenop-itself/);
    const secret = await run("PreToolUse", { tool_name: "apply_patch", tool_input: `*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: .env\n+X=1\n*** End Patch`, tool_use_id: "e6" });
    expect(secret.exitCode).toBe(2);
    expect(secret.stderr).toMatch(/no-secret-files/);
  });
  it("shares run state: a sensitive read then an outside call is stopped", async () => {
    await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "printenv | grep -i key" }, tool_use_id: "e7" });
    await run("PreToolUse", { tool_name: "mcp__web__fetch_page", tool_input: { url: "https://forum.example.com" }, tool_use_id: "e8" });
    const r = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "curl -s https://api.other.example.com/collect" }, tool_use_id: "e9" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/lethal-trifecta|external-network-after-sensitive-data/);
  });
  it("writes receipts tagged codex", async () => {
    await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "e10" });
    const last = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last)).toMatchObject({ runtime: "codex", tool: "Bash", effect: "allow" });
  });
});

describe("codex installer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yenop-codex-inst-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a decision hook and async report hooks, idempotently and atomically", () => {
    const path = join(dir, ".codex", "hooks.json");
    expect(installCodexHooks(path, "yenop hook codex").changed).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, { hooks: { command: string; async?: boolean; timeout: number }[] }[]> };
    expect(file.hooks["PreToolUse"]![0]!.hooks[0]).toMatchObject({ command: "yenop hook codex", timeout: 15 });
    expect(file.hooks["PostToolUse"]![0]!.hooks[0]).toMatchObject({ command: "yenop hook codex", async: true });
    expect(file.hooks["SessionEnd"]![0]!.hooks[0]).toMatchObject({ command: "yenop hook codex", timeout: 3 }); // Codex clamps to 3 s and runs it synchronously
    expect(file.hooks["SessionEnd"]![0]!.hooks[0]).not.toHaveProperty("async");
    void CODEX_REPORT_EVENTS;
    expect(installCodexHooks(path, "yenop hook codex").changed).toBe(false);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
  it("keeps other hooks and replaces an older Yenop entry", () => {
    const path = join(dir, ".codex", "hooks.json");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }, { hooks: [{ type: "command", command: "/old/yenop hook codex" }] }] } }));
    installCodexHooks(path, "yenop hook codex");
    const groups = JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse as { hooks: { command: string }[] }[];
    expect(groups.map((g) => g.hooks.map((h) => h.command))).toEqual([["./lint.sh"], ["yenop hook codex"]]);
  });
});

describe("codex trust state, read from Codex's own config", () => {
  const hooksPath = "/Users/u/proj/.codex/hooks.json";
  const toml = (pre: string) => `[projects."/Users/u/proj"]
trust_level = "trusted"

[hooks.state]

[hooks.state."${hooksPath}:pre_tool_use:0:0"]
trusted_hash = "sha256:abc"
${pre}
[hooks.state."${hooksPath}:post_tool_use:0:0"]
trusted_hash = "sha256:def"
`;
  it("sees a disabled PreToolUse, which means nothing is enforced on Codex", () => {
    const dir = mkdtempSync(join(tmpdir(), "yenop-codex-cfg-"));
    try {
      const cfg = join(dir, "config.toml");
      writeFileSync(cfg, toml("enabled = false\n"));
      expect(codexHookState(hooksPath, "PreToolUse", cfg)).toBe("disabled");
      expect(codexHookState(hooksPath, "PostToolUse", cfg)).toBe("active");
      expect(codexHookState(hooksPath, "SessionEnd", cfg)).toBe("untrusted");
      writeFileSync(cfg, toml(""));
      expect(codexHookState(hooksPath, "PreToolUse", cfg)).toBe("active");
      expect(codexHookState("/elsewhere/.codex/hooks.json", "PreToolUse", cfg)).toBe("untrusted");
      expect(codexHookState(hooksPath, "PreToolUse", join(dir, "missing.toml"))).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
