/**
 * Cursor hooks adapter (`yenop hook cursor`).
 *
 * Cursor runs a command before acting and reads a JSON answer. The contract (cursor.com/docs/hooks, and what
 * Cursor 3.21 really sends, recorded 2026-09-23):
 *  - preToolUse            {tool_name, tool_input, tool_use_id, cwd}   → {permission: allow|deny, user_message}
 *                          fires FIRST, for EVERY tool: Shell, Read, Write, Edit, Delete, Grep, Task, MCP:<tool>...
 *  - beforeShellExecution  {command, cwd}                              → {permission: allow|ask|deny, user_message}
 *  - beforeMCPExecution    {tool_name, tool_input (JSON string), mcp_server_name, url?, command?}
 *                                                                       → {permission: allow|ask|deny, user_message}
 *  - beforeReadFile        {file_path, content, attachments}           → {permission: allow|deny, user_message}
 *  - postToolUse / postToolUseFailure                                   observe-only, carry tool_use_id
 *  - sessionEnd                                                         fire-and-forget
 *  Every event also carries conversation_id, generation_id, hook_event_name, workspace_roots, ...
 *
 * Security decisions baked in here:
 *  - A permission hook that prints invalid or empty JSON makes Cursor block (with failClosed), so for a decision
 *    we ALWAYS print a full answer, including in observe mode (where it is allow). Silence is never an answer.
 *    Found live: the first version ignored Shell in preToolUse, expecting beforeShellExecution to judge it, and
 *    Cursor blocked every command with "hook returned no output". Fail-closed held; the adapter was wrong.
 *  - preToolUse cannot ask. An ask there becomes a deny with a message saying why, never an allow. The
 *    specialised hooks that can ask fire only after preToolUse allowed, so deferring an ask to them is only
 *    safe once it is proven live that they fire; see DEFER_ASK_TO_SPECIALISED.
 *  - The same call reaches Yenop through preToolUse and then its specialised hook. Both derive the same call id
 *    from the conversation, generation and the command or path, so the second is a replay of the first: one
 *    decision, one receipt, and the outcome from postToolUse attaches to it.
 *  - Every tool name is judged. Known world-touching tools by what they do; a tool with no command, path or
 *    URL in its input is an internal tool (Task, Todo, ...) and judged as read-only rather than left silent.
 *  - tool_input on MCP events is a JSON string from the model's side of the fence: parsed defensively.
 *  - Malformed input throws; the pipeline turns that into a deny with exit 2. failClosed:true is set by the
 *    installer so a crash or timeout also blocks.
 */
import { createHash } from "node:crypto";
import { classifyTool, mcpToolRef } from "../../core/tools.js";
import type { DecisionRequest, ToolRef } from "../../core/types.js";
import type { Mode } from "../../core/config.js";
import { safeUser, type Effect, type HookEvent, type HookRunResult, type HookTranslator } from "../hooks/pipeline.js";

/**
 * Whether preToolUse may answer "allow" on an ask, leaving the ask to the specialised hook that follows and
 * can show a person a prompt. Only for a kind whose specialised hook has been SEEN to fire after preToolUse
 * allowed, in a live session; until then an ask in preToolUse is a deny, never an allow.
 *  - shell: proven 2026-09-23 with Cursor 3.21.18: preToolUse → beforeShellExecution → postToolUse, same call.
 *  - mcp: beforeMCPExecution is documented the same way but has not been seen live; stays strict.
 */
export const DEFER_ASK_TO_SPECIALISED: Record<"shell" | "mcp", boolean> = { shell: true, mcp: false };

interface CursorBase {
  conversation_id?: unknown;
  generation_id?: unknown;
  hook_event_name?: unknown;
  workspace_roots?: unknown;
  cwd?: unknown;
}

const MUTATING_TOOL = /(write|edit|create|delete|remove|replace|move|rename|patch|apply)/i;
const SHELL_TOOL = /^(shell|bash|terminal|run_terminal|run_terminal_cmd|runterminal)$/i;
const READ_TOOL = /^(read|read_file|readfile)$/i;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
/** MCP tool_input arrives as a JSON string. A string that is not JSON becomes an empty object, never a crash. */
function jsonArgs(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return obj(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return obj(v);
}
function firstRoot(v: unknown): string | undefined {
  return Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}
function cwdOf(base: CursorBase, input?: Record<string, unknown>): string | undefined {
  return (input && str(input["cwd"])) ?? str(base.cwd) ?? firstRoot(base.workspace_roots);
}

/** One id for one call, whichever hook carries it: preToolUse, the specialised hook, and the outcome agree. */
export function cursorCallId(base: CursorBase, kind: "shell" | "read" | "mcp", key: string): string {
  return "c_" + createHash("sha256").update(str(base.conversation_id) ?? "").update("\0").update(str(base.generation_id) ?? "").update("\0").update(kind).update("\0").update(key).digest("hex").slice(0, 32);
}

function request(base: CursorBase, tool: ToolRef, args: Record<string, unknown>, callId?: string, cwd?: string): DecisionRequest {
  const conv = str(base.conversation_id) ?? "unknown";
  const req: DecisionRequest = { runId: `cursor:${conv}`, principal: { runtime: "cursor", agent: "main", user: safeUser() }, tool, args };
  const at = cwd ?? cwdOf(base);
  if (at !== undefined) req.cwd = at;
  if (callId !== undefined) req.callId = callId;
  return req;
}

/** preToolUse: what this tool is, from its name and what its input names. Never silent. */
function preToolUse(m: CursorBase, name: string, input: Record<string, unknown>, useId: string | undefined): HookEvent {
  const event = "preToolUse";
  if (SHELL_TOOL.test(name)) {
    const command = str(input["command"]);
    if (command === undefined) throw new Error("preToolUse Shell without command");
    return { kind: "decision", event, askCapable: false, request: request(m, classifyTool("Bash"), { ...input, command }, cursorCallId(m, "shell", command), cwdOf(m, input)) };
  }
  const path = str(input["file_path"]) ?? str(input["path"]) ?? str(input["target_file"]);
  if (READ_TOOL.test(name)) {
    if (path === undefined) throw new Error("preToolUse Read without file_path");
    return { kind: "decision", event, askCapable: false, request: request(m, classifyTool("Read"), { ...input, file_path: path }, cursorCallId(m, "read", path)) };
  }
  const mcp = /^MCP:(.+)$/.exec(name);
  if (mcp) {
    const args = jsonArgs(input["args"] ?? input["arguments"] ?? input);
    return { kind: "decision", event, askCapable: false, request: request(m, mcpToolRef(str(input["server"]) ?? str(input["mcp_server_name"]) ?? "mcp", mcp[1]!), args, cursorCallId(m, "mcp", mcp[1]! + JSON.stringify(args))) };
  }
  if (MUTATING_TOOL.test(name) && path !== undefined) {
    const tool: ToolRef = { name, kind: "write", readOnly: false };
    return { kind: "decision", event, askCapable: false, request: request(m, tool, { ...input, file_path: path }, useId) };
  }
  const url = str(input["url"]);
  if (url !== undefined) return { kind: "decision", event, askCapable: false, request: request(m, { name, kind: "web", readOnly: !MUTATING_TOOL.test(name) }, input, useId) };
  // Grep, Glob, ListDir, Search, Task, Todo, ...: reads inside the workspace or Cursor's own bookkeeping.
  const tool: ToolRef = { name, kind: "read", readOnly: true };
  return { kind: "decision", event, askCapable: false, request: request(m, tool, path !== undefined ? { ...input, file_path: path } : input, useId) };
}

export function parseCursor(raw: string): HookEvent {
  const m = JSON.parse(raw) as CursorBase & Record<string, unknown>; // throws → deny
  const event = str(m.hook_event_name);
  if (!event) throw new Error("cursor hook event without hook_event_name");

  switch (event) {
    case "beforeShellExecution": {
      const command = str(m["command"]);
      if (command === undefined) throw new Error("beforeShellExecution without command");
      return { kind: "decision", event, askCapable: true, request: request(m, classifyTool("Bash"), { command }, cursorCallId(m, "shell", command)) };
    }
    case "beforeMCPExecution": {
      const name = str(m["tool_name"]);
      const server = str(m["mcp_server_name"]) ?? "mcp";
      if (name === undefined) throw new Error("beforeMCPExecution without tool_name");
      const args = jsonArgs(m["tool_input"]);
      return { kind: "decision", event, askCapable: true, request: request(m, mcpToolRef(server, name), args, cursorCallId(m, "mcp", name + JSON.stringify(args))) };
    }
    case "beforeReadFile": {
      const file = str(m["file_path"]);
      if (file === undefined) throw new Error("beforeReadFile without file_path");
      return { kind: "decision", event, askCapable: false, request: request(m, classifyTool("Read"), { file_path: file }, cursorCallId(m, "read", file)) };
    }
    case "preToolUse": {
      const name = str(m["tool_name"]);
      if (name === undefined) throw new Error("preToolUse without tool_name");
      return preToolUse(m, name, obj(m["tool_input"]), str(m["tool_use_id"]));
    }
    case "postToolUse":
    case "postToolUseFailure": {
      const useId = str(m["tool_use_id"]);
      const tool = str(m["tool_name"]);
      if (!useId || !tool) return { kind: "ignore" };
      const input = obj(m["tool_input"]);
      const command = str(input["command"]);
      const path = str(input["file_path"]) ?? str(input["path"]) ?? str(input["target_file"]);
      const callId = SHELL_TOOL.test(tool) && command !== undefined ? cursorCallId(m, "shell", command) : READ_TOOL.test(tool) && path !== undefined ? cursorCallId(m, "read", path) : useId;
      const conv = str(m.conversation_id) ?? "unknown";
      const failed = event === "postToolUseFailure";
      const denied = failed && str(m["failure_type"]) === "permission_denied";
      const out: HookEvent = { kind: "outcome", runId: `cursor:${conv}`, callId, tool, outcome: denied ? "denied" : failed ? "failed" : "ran" };
      const detail = str(m["error_message"]);
      if (failed && detail) out.detail = detail;
      const cwd = cwdOf(m, input);
      if (cwd !== undefined) out.cwd = cwd;
      return out;
    }
    case "afterShellExecution": {
      // Fires after a shell command actually executed (to be confirmed live: Cursor's postToolUse also fires for
      // a command the person skipped). Carries the command and, when known, its exit code.
      const command = str(m["command"]) ?? str(obj(m["tool_input"])["command"]);
      if (command === undefined) return { kind: "ignore" };
      const code = m["exit_code"] ?? m["exitCode"] ?? obj(m["result"])["exitCode"];
      const failed = typeof code === "number" && code !== 0;
      const conv = str(m.conversation_id) ?? "unknown";
      const out: HookEvent = { kind: "outcome", runId: `cursor:${conv}`, callId: cursorCallId(m, "shell", command), tool: "Shell", outcome: failed ? "failed" : "ran" };
      if (failed) out.detail = `exit code ${code}`;
      const cwd = cwdOf(m);
      if (cwd !== undefined) out.cwd = cwd;
      return out;
    }
    case "sessionEnd": {
      const end: HookEvent = { kind: "session-end", runId: `cursor:${str(m["session_id"]) ?? str(m.conversation_id) ?? "unknown"}` };
      const cwd = cwdOf(m);
      if (cwd !== undefined) end.cwd = cwd;
      return end;
    }
    default:
      return { kind: "ignore" };
  }
}

function answer(permission: "allow" | "ask" | "deny", message?: string): Record<string, unknown> {
  return message ? { permission, user_message: message } : { permission };
}

export function cursorBody(effect: Effect, message: string, mode: Mode, ev: Extract<HookEvent, { kind: "decision" }>): Record<string, unknown> {
  if (mode === "observe") return answer("allow"); // recorded, never blocked; and Cursor needs a real answer
  if (effect === "allow") return answer("allow");
  if (effect === "deny") return answer("deny", `Yenop: ${message}`);
  if (ev.askCapable) return answer("ask", `Yenop: ${message}`);
  const kind = ev.request.tool.kind;
  if (ev.event === "preToolUse" && (kind === "shell" || kind === "mcp") && DEFER_ASK_TO_SPECIALISED[kind]) return answer("allow"); // the hook that can ask comes next, with the same call id
  return answer("deny", `Yenop: ${message} Cursor cannot ask a person for this step, so it is blocked: do it yourself, or allow it in policy.`);
}

export const cursorTranslator: HookTranslator = {
  runtime: "cursor",
  parse: parseCursor,
  body: cursorBody,
  result(body): HookRunResult {
    if (body === null || Object.keys(body).length === 0) return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify(body), exitCode: 0 };
  },
  failure(reason): HookRunResult {
    return { stdout: JSON.stringify(answer("deny", `Yenop failed and refuses by default: ${reason}. Run "yenop status".`)), exitCode: 2 };
  },
};
