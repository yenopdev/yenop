/**
 * Gemini CLI hooks adapter (`yenop hook gemini`).
 *
 * Gemini CLI runs a command before and after every tool call and reads a JSON answer from stdout. The contract
 * (geminicli.com/docs/hooks/reference, checked against @google/gemini-cli-core 0.60.0):
 *  - BeforeTool  {session_id, cwd, tool_name, tool_input, mcp_context?}    → {decision: allow|ask|deny, reason, systemMessage}
 *  - AfterTool   {..., tool_response: {llmContent, returnDisplay, error?}}  observe-only
 *  - SessionEnd  {session_id, reason}                                        fire-and-forget
 *  Every event also carries hook_event_name, transcript_path and timestamp.
 *
 * What Gemini does with the answer, from its source rather than its docs:
 *  - `ask` forces Gemini's own confirmation prompt, even in an auto-approve mode, and shows systemMessage.
 *    So Gemini can ask a person, like Claude Code and unlike Codex.
 *  - `deny` skips the tool; the model receives "Tool execution blocked: <reason>".
 *  - Exit code 0 with JSON is the answer it prefers. Exit 1 means "warning, proceed" (an allow!), any other
 *    non-zero exit is a deny. A hook that times out or cannot be spawned is logged and IGNORED: the runtime
 *    is fail-open, like Codex. Yenop therefore answers with exit 0 and JSON for every verdict, including a
 *    deny and its own failure, which is the one path that is honoured unambiguously; it never exits 1.
 *
 * Security decisions baked in here:
 *  - Every world-touching tool is mapped by name to what it can do; a name Yenop does not know is judged as
 *    an unknown tool (not read-only), never ignored.
 *  - Gemini gives no per-call id, so one is derived from session, tool and arguments; that is what lets the
 *    AfterTool outcome attach to the decision. Two identical calls inside the replay window get one verdict,
 *    which is the same verdict they would get anyway.
 *  - MCP tools arrive as `mcp_<server>_<tool>` after Gemini sanitises the name, which is ambiguous when names
 *    contain underscores. mcp_context carries the exact server and tool and is preferred; the name is the
 *    fallback, with the whole remainder treated as the tool.
 *  - run_shell_command may name a directory to run in; the decision is made relative to it, so a relative
 *    path in the command resolves the way the shell will resolve it.
 *  - web_fetch takes URLs inside a prose prompt. Every URL is extracted and the first external one is judged
 *    as the call's destination.
 *  - Malformed input throws; the pipeline turns that into a deny.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { classifyTool, mcpToolRef } from "../../core/tools.js";
import { isInternalHost } from "../../core/shell.js";
import type { DecisionRequest, ToolRef } from "../../core/types.js";
import type { Mode } from "../../core/config.js";
import { safeUser, type Effect, type HookEvent, type HookRunResult, type HookTranslator } from "../hooks/pipeline.js";

interface GeminiBase {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  mcp_context?: unknown;
  tool_response?: unknown;
}

/** Gemini's built-in tools (packages/core/src/tools/tool-names.ts) and what each can do. */
const BUILTIN: Record<string, { kind: ToolRef["kind"]; readOnly: boolean }> = {
  run_shell_command: { kind: "shell", readOnly: false },
  read_file: { kind: "read", readOnly: true },
  read_many_files: { kind: "read", readOnly: true },
  list_directory: { kind: "read", readOnly: true },
  glob: { kind: "read", readOnly: true },
  grep_search: { kind: "read", readOnly: true },
  search_file_content: { kind: "read", readOnly: true }, // legacy alias of grep_search
  write_file: { kind: "write", readOnly: false },
  replace: { kind: "write", readOnly: false },
  save_memory: { kind: "write", readOnly: false },
  web_fetch: { kind: "web", readOnly: true },
  google_web_search: { kind: "web", readOnly: true },
  read_mcp_resource: { kind: "mcp", readOnly: true },
  // Tools that act inside Gemini itself, not on outside systems. Judged (cheap) rather than ignored.
  write_todos: { kind: "read", readOnly: true },
  ask_user: { kind: "read", readOnly: true },
  activate_skill: { kind: "read", readOnly: true },
  enter_plan_mode: { kind: "read", readOnly: true },
  exit_plan_mode: { kind: "read", readOnly: true },
  update_topic: { kind: "read", readOnly: true },
  complete_task: { kind: "read", readOnly: true },
  get_internal_docs: { kind: "read", readOnly: true },
  list_mcp_resources: { kind: "read", readOnly: true },
  invoke_agent: { kind: "read", readOnly: true },
  tracker_create_task: { kind: "read", readOnly: true },
  tracker_update_task: { kind: "read", readOnly: true },
  tracker_get_task: { kind: "read", readOnly: true },
  tracker_list_tasks: { kind: "read", readOnly: true },
  tracker_add_dependency: { kind: "read", readOnly: true },
  tracker_visualize: { kind: "read", readOnly: true },
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function runIdOf(m: GeminiBase): string {
  return `gemini:${str(m.session_id) ?? "unknown"}`;
}

/** Gemini sends no call id. Derive one from what identifies the call, so the AfterTool outcome finds its decision. */
export function geminiCallId(sessionId: string, tool: string, input: unknown): string {
  return "g_" + createHash("sha256").update(sessionId).update("\0").update(tool).update("\0").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 32);
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
/** The URLs named in a web_fetch prompt, external ones first, so the judged `url` is the one that leaves the machine. */
export function urlsInPrompt(prompt: string): string[] {
  const found = (prompt.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")); // prose punctuation after a URL is not part of it
  const external: string[] = [];
  const internal: string[] = [];
  for (const u of found) {
    let host: string | undefined;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    (isInternalHost(host) ? internal : external).push(u);
  }
  return [...external, ...internal];
}

/** Map one Gemini tool call to what Yenop judges. */
function toolAndArgs(m: GeminiBase, name: string, input: Record<string, unknown>): { tool: ToolRef; args: Record<string, unknown>; cwd?: string } {
  const ctx = obj(m.mcp_context);
  const server = str(ctx["server_name"]);
  const cwd = str(m.cwd);
  if (server !== undefined) return { tool: mcpToolRef(server, str(ctx["tool_name"]) ?? name), args: input, ...(cwd !== undefined ? { cwd } : {}) };

  const known = BUILTIN[name];
  if (known) {
    const tool: ToolRef = { name, ...known };
    switch (name) {
      case "run_shell_command": {
        const dir = str(input["dir_path"]);
        const at = dir !== undefined && cwd !== undefined ? resolve(cwd, dir) : dir !== undefined ? resolve(dir) : cwd;
        return { tool, args: input, ...(at !== undefined ? { cwd: at } : {}) };
      }
      case "read_many_files":
        return { tool, args: { ...input, paths: strings(input["include"]) }, ...(cwd !== undefined ? { cwd } : {}) };
      case "list_directory":
      case "glob":
      case "grep_search":
      case "search_file_content": {
        const dir = str(input["dir_path"]);
        return { tool, args: dir !== undefined ? { ...input, path: dir } : input, ...(cwd !== undefined ? { cwd } : {}) };
      }
      case "save_memory":
        // Persists into the user's global GEMINI.md: a write outside every project, and a persistence vector.
        return { tool, args: { ...input, file_path: join(homedir(), ".gemini", "GEMINI.md"), content: input["fact"] ?? "" }, ...(cwd !== undefined ? { cwd } : {}) };
      case "web_fetch": {
        const urls = urlsInPrompt(str(input["prompt"]) ?? "");
        return { tool, args: { ...input, urls, ...(urls[0] !== undefined ? { url: urls[0] } : {}) }, ...(cwd !== undefined ? { cwd } : {}) };
      }
      case "read_mcp_resource": {
        const uri = str(input["uri"]);
        let host = "unknown";
        try {
          if (uri) host = new URL(uri).hostname || "unknown";
        } catch {
          /* not a URL */
        }
        return { tool: { ...tool, server: host }, args: input, ...(cwd !== undefined ? { cwd } : {}) };
      }
      default:
        return { tool, args: input, ...(cwd !== undefined ? { cwd } : {}) };
    }
  }

  // An MCP tool without mcp_context: mcp_<server>_<tool>, sanitised. The split is a guess; the server is taken
  // as the first segment and everything after it as the tool, which errs towards an unfamiliar (untrusted) server.
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp) return { tool: mcpToolRef(mcp[1]!, mcp[2]!), args: input, ...(cwd !== undefined ? { cwd } : {}) };
  return { tool: classifyTool(name), args: input, ...(cwd !== undefined ? { cwd } : {}) };
}

export function parseGemini(raw: string): HookEvent {
  const m = JSON.parse(raw) as GeminiBase; // throws → deny
  const event = str(m.hook_event_name);
  if (!event) throw new Error("gemini hook event without hook_event_name");
  const session = str(m.session_id);
  if (!session) throw new Error("gemini hook event without session_id");

  switch (event) {
    case "BeforeTool": {
      const name = str(m.tool_name);
      if (name === undefined) throw new Error("BeforeTool without tool_name");
      const input = obj(m.tool_input);
      const { tool, args, cwd } = toolAndArgs(m, name, input);
      const request: DecisionRequest = { runId: runIdOf(m), principal: { runtime: "gemini", agent: "main", user: safeUser() }, tool, args, callId: geminiCallId(session, name, m.tool_input) };
      if (cwd !== undefined) request.cwd = cwd;
      return { kind: "decision", event, askCapable: true, request };
    }
    case "AfterTool": {
      const name = str(m.tool_name);
      if (name === undefined) return { kind: "ignore" };
      const resp = obj(m.tool_response);
      const failed = resp["error"] !== undefined && resp["error"] !== null;
      const out: HookEvent = { kind: "outcome", runId: runIdOf(m), callId: geminiCallId(session, name, m.tool_input), tool: name, outcome: failed ? "failed" : "ran" };
      const err = resp["error"];
      const detail = typeof err === "string" ? err : err && typeof err === "object" ? str((err as Record<string, unknown>)["message"]) : undefined;
      if (failed && detail) out.detail = detail;
      const cwd = str(m.cwd);
      if (cwd !== undefined) out.cwd = cwd;
      return out;
    }
    case "SessionEnd": {
      const end: HookEvent = { kind: "session-end", runId: runIdOf(m) };
      const cwd = str(m.cwd);
      if (cwd !== undefined) end.cwd = cwd;
      return end;
    }
    default:
      return { kind: "ignore" };
  }
}

export function geminiBody(effect: Effect, message: string, mode: Mode): Record<string, unknown> | null {
  if (mode === "observe" || effect === "allow") return null; // silence with exit 0 is an allow
  if (effect === "deny") return { decision: "deny", reason: `Yenop: ${message}` };
  return { decision: "ask", reason: `Yenop: ${message}`, systemMessage: `Yenop: ${message}` };
}

export const geminiTranslator: HookTranslator = {
  runtime: "gemini",
  parse: parseGemini,
  body: (effect, message, mode) => geminiBody(effect, message, mode),
  result(body): HookRunResult {
    if (body === null || Object.keys(body).length === 0) return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify(body), exitCode: 0 };
  },
  // Exit 0 on purpose: a JSON deny on exit 0 is honoured; a non-zero exit is a path Gemini may treat as a
  // failed hook, and a failed hook is ignored.
  failure(reason): HookRunResult {
    return { stdout: JSON.stringify({ decision: "deny", reason: `Yenop failed and refuses by default: ${reason}. Run "yenop status".` }), exitCode: 0 };
  },
};
