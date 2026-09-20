/**
 * Codex CLI hooks adapter (`yenop hook codex`).
 *
 * Codex's hooks are modelled on Claude Code's (learn.chatgpt.com/docs/hooks): hooks.json in ~/.codex or
 * <repo>/.codex, a snake_case JSON event on stdin, a camelCase answer on stdout. PreToolUse fires for Bash,
 * for file edits made through `apply_patch`, for MCP tools (`mcp__server__tool`) and other local tools.
 *
 * Three facts about Codex shape the security decisions here:
 *  - Codex has no "ask". A hook answering `permissionDecision: "ask"` is recorded as a FAILED hook and the call
 *    proceeds. So every ask becomes a deny with a message; "ask" is never emitted.
 *  - A deny is honoured two ways: exit code 2 with the reason on stderr (the documented block path), or the
 *    JSON deny on stdout. We do both, so whichever Codex reads, it blocks.
 *  - A hook that crashes, times out, or prints invalid JSON FAILS OPEN in Codex, and there is no failClosed
 *    option. That is Codex's design; Yenop cannot change it. What Yenop can do is be reliable (daemon fast
 *    path, in-process fallback), print nothing at all on allow (silence is unambiguous), and say so in docs.
 *
 * apply_patch touches several files in one call. The patch text names them (`*** Update File: path` and
 * friends); every path is judged and the strictest verdict wins, through args.paths.
 */
import { classifyTool } from "../../core/tools.js";
import type { DecisionRequest, ToolRef } from "../../core/types.js";
import type { Mode } from "../../core/config.js";
import { safeUser, type Effect, type HookEvent, type HookRunResult, type HookTranslator } from "../hooks/pipeline.js";

interface CodexEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  permission_mode?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  turn_id?: unknown;
}

const PATCH_TOOL = /^(apply_patch|edit|write)$/i;
const PATCH_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/gm;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The files a patch touches, from its headers. Exported so a recorded apply_patch event can be checked against it. */
export function pathsInPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(PATCH_LINE)) out.add(m[1]!.trim());
  for (const m of patch.matchAll(PATCH_MOVE)) out.add(m[1]!.trim());
  return [...out];
}

function request(e: CodexEvent, tool: ToolRef, args: Record<string, unknown>): DecisionRequest {
  const req: DecisionRequest = {
    runId: `codex:${str(e.session_id) ?? "unknown"}`,
    principal: { runtime: "codex", agent: "main", user: safeUser() },
    tool,
    args,
  };
  const cwd = str(e.cwd);
  if (cwd !== undefined) req.cwd = cwd;
  const pm = str(e.permission_mode);
  if (pm !== undefined) req.permissionMode = pm;
  const id = str(e.tool_use_id);
  if (id !== undefined) req.callId = id;
  return req;
}

export function parseCodex(raw: string): HookEvent {
  const e = JSON.parse(raw) as CodexEvent; // throws → deny
  const event = str(e.hook_event_name);
  if (!event) throw new Error("codex hook event without hook_event_name");
  const runId = `codex:${str(e.session_id) ?? "unknown"}`;

  switch (event) {
    case "PreToolUse": {
      const name = str(e.tool_name);
      if (name === undefined) throw new Error("PreToolUse without tool_name");
      const input = e.tool_input;
      if (PATCH_TOOL.test(name)) {
        // apply_patch: Codex (recorded 2026-09-20, v0.155) sends the patch text as tool_input.command; older or
        // other shapes use a bare string, or `patch` / `input`. The files the patch names are the targets.
        const o = obj(input);
        const patch = typeof input === "string" ? input : (str(o["command"]) ?? str(o["patch"]) ?? str(o["input"]) ?? "");
        const paths = patch ? pathsInPatch(patch) : [];
        const single = str(o["file_path"]) ?? str(o["path"]);
        const all = single ? [single, ...paths] : paths;
        // A file edit whose targets cannot be determined must not slip past the path rules. Refuse it, loudly,
        // rather than judge an edit of unknown files as harmless: that is exactly how the hook file got edited.
        if (all.length === 0) throw new Error(`apply_patch with no recognizable target files (input keys: ${Object.keys(o).join(",") || typeof input})`);
        const tool: ToolRef = { name, kind: "write", readOnly: false };
        const args: Record<string, unknown> = { ...o, patch: patch.slice(0, 2000), file_path: all[0], paths: all };
        return { kind: "decision", event, askCapable: false, request: request(e, tool, args) };
      }
      return { kind: "decision", event, askCapable: false, request: request(e, classifyTool(name), obj(input)) };
    }
    case "PostToolUse": {
      const callId = str(e.tool_use_id);
      const tool = str(e.tool_name);
      if (!callId || !tool) return { kind: "ignore" };
      return { kind: "outcome", runId, callId, tool, outcome: "ran" };
    }
    case "SessionEnd":
      return { kind: "session-end", runId };
    default:
      return { kind: "ignore" };
  }
}

function denyBody(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function codexBody(effect: Effect, message: string, mode: Mode): Record<string, unknown> | null {
  if (mode === "observe" || effect === "allow") return null; // silence: Codex proceeds, and nothing can be misread
  if (effect === "deny") return denyBody(`Yenop: ${message}`);
  // ask: Codex cannot ask a person, and "ask" would make it proceed. Tighten, never loosen.
  return denyBody(`Yenop: ${message} Codex cannot ask a person for this step, so it is blocked: do it yourself, or allow it in policy.`);
}

function reasonOf(body: Record<string, unknown>): string {
  const h = body["hookSpecificOutput"] as { permissionDecisionReason?: string } | undefined;
  return h?.permissionDecisionReason ?? "blocked by Yenop";
}

export const codexTranslator: HookTranslator = {
  runtime: "codex",
  parse: parseCodex,
  body: (effect, message, mode) => codexBody(effect, message, mode),
  result(body): HookRunResult {
    if (body === null || Object.keys(body).length === 0) return { stdout: "", exitCode: 0 };
    // exit 2 + stderr is the block path Codex documents; the JSON on stdout serves anything that reads it instead
    return { stdout: JSON.stringify(body), stderr: reasonOf(body), exitCode: 2 };
  },
  failure(reason): HookRunResult {
    const text = `Yenop failed and refuses by default: ${reason}. Run "yenop status".`;
    return { stdout: JSON.stringify(denyBody(text)), stderr: text, exitCode: 2 };
  },
};
