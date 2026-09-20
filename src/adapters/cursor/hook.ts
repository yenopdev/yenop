/**
 * Cursor hooks adapter (`yenop hook cursor`).
 *
 * Cursor runs a command before acting and reads a JSON answer. The contract (cursor.com/docs/hooks):
 *  - beforeShellExecution  {command, cwd}                         → {permission: allow|ask|deny, user_message}
 *  - beforeMCPExecution    {tool_name, tool_input (JSON string), mcp_server_name, url?, command?}
 *                                                                  → {permission: allow|ask|deny, user_message}
 *  - beforeReadFile        {file_path, content, attachments}      → {permission: allow|deny, user_message}
 *  - preToolUse            {tool_name, tool_input, tool_use_id}   → {permission: allow|deny, user_message, ...}
 *  - postToolUse / postToolUseFailure                              observe-only, carry tool_use_id
 *  - sessionEnd                                                    fire-and-forget
 *  Every event also carries conversation_id, generation_id, hook_event_name, workspace_roots, ...
 *
 * Security decisions baked in here:
 *  - A permission hook that prints invalid or empty JSON makes Cursor block, so for a decision we ALWAYS print a
 *    full answer, including in observe mode (where it is allow). Silence is never an answer to Cursor.
 *  - beforeReadFile and preToolUse cannot ask. An ask there becomes a deny with a message saying why, never an
 *    allow. Yenop only ever tightens.
 *  - preToolUse judges only file-mutation tools; shell and MCP are judged by their dedicated hooks, so a call
 *    is never decided twice. Unknown tool names are left to Cursor rather than guessed at.
 *  - tool_input on MCP events is a JSON string from the model's side of the fence: parsed defensively.
 *  - Malformed input throws; the pipeline turns that into a deny with exit 2. failClosed:true is set by the
 *    installer so a crash or timeout also blocks.
 *
 * Coverage note: Cursor has no blocking hook for its own file writes except preToolUse, and its exact built-in
 * tool names are not all documented. The mutation check below is by name pattern plus a path-bearing input, and
 * is a thing to verify against a live Cursor before relying on it in a pilot.
 */
import { classifyTool, mcpToolRef } from "../../core/tools.js";
import type { DecisionRequest, ToolRef } from "../../core/types.js";
import type { Mode } from "../../core/config.js";
import { safeUser, type Effect, type HookEvent, type HookRunResult, type HookTranslator } from "../hooks/pipeline.js";

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

function request(base: CursorBase, tool: ToolRef, args: Record<string, unknown>, callId?: string): DecisionRequest {
  const conv = str(base.conversation_id) ?? "unknown";
  const req: DecisionRequest = { runId: `cursor:${conv}`, principal: { runtime: "cursor", agent: "main", user: safeUser() }, tool, args };
  const cwd = str(base.cwd) ?? firstRoot(base.workspace_roots);
  if (cwd !== undefined) req.cwd = cwd;
  if (callId !== undefined) req.callId = callId;
  return req;
}

export function parseCursor(raw: string): HookEvent {
  const m = JSON.parse(raw) as CursorBase & Record<string, unknown>; // throws → deny
  const event = str(m.hook_event_name);
  if (!event) throw new Error("cursor hook event without hook_event_name");

  switch (event) {
    case "beforeShellExecution": {
      const command = str(m["command"]);
      if (command === undefined) throw new Error("beforeShellExecution without command");
      return { kind: "decision", event, askCapable: true, request: request(m, classifyTool("Bash"), { command }) };
    }
    case "beforeMCPExecution": {
      const name = str(m["tool_name"]);
      const server = str(m["mcp_server_name"]) ?? "mcp";
      if (name === undefined) throw new Error("beforeMCPExecution without tool_name");
      return { kind: "decision", event, askCapable: true, request: request(m, mcpToolRef(server, name), jsonArgs(m["tool_input"])) };
    }
    case "beforeReadFile": {
      const file = str(m["file_path"]);
      if (file === undefined) throw new Error("beforeReadFile without file_path");
      return { kind: "decision", event, askCapable: false, request: request(m, classifyTool("Read"), { file_path: file }) };
    }
    case "preToolUse": {
      const name = str(m["tool_name"]);
      if (name === undefined) throw new Error("preToolUse without tool_name");
      if (SHELL_TOOL.test(name) || READ_TOOL.test(name)) return { kind: "ignore" }; // judged by their own hooks
      const input = obj(m["tool_input"]);
      const path = str(input["file_path"]) ?? str(input["path"]) ?? str(input["target_file"]);
      if (!MUTATING_TOOL.test(name) || path === undefined) return { kind: "ignore" };
      const tool: ToolRef = { name, kind: "write", readOnly: false };
      const args: Record<string, unknown> = { ...input, file_path: path };
      return { kind: "decision", event, askCapable: false, request: request(m, tool, args, str(m["tool_use_id"])) };
    }
    case "postToolUse":
    case "postToolUseFailure": {
      const callId = str(m["tool_use_id"]);
      const tool = str(m["tool_name"]);
      if (!callId || !tool) return { kind: "ignore" };
      const conv = str(m.conversation_id) ?? "unknown";
      const failed = event === "postToolUseFailure";
      const out: HookEvent = { kind: "outcome", runId: `cursor:${conv}`, callId, tool, outcome: failed ? "failed" : "ran" };
      const detail = str(m["error_message"]);
      if (failed && detail) out.detail = detail;
      return out;
    }
    case "sessionEnd":
      return { kind: "session-end", runId: `cursor:${str(m["session_id"]) ?? str(m.conversation_id) ?? "unknown"}` };
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
