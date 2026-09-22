/**
 * Claude Code PreToolUse adapter.
 * stdin: the hook JSON Claude Code sends. stdout: a hook decision, or nothing to defer to Claude Code's own flow.
 * Yenop only ever tightens: on allow it prints nothing, on ask it asks, on deny it blocks (exit 2 + JSON reason).
 */
import { classifyTool } from "../../core/tools.js";
import type { DecisionRequest } from "../../core/types.js";
import type { Mode } from "../../core/config.js";
import { runHookWith, safeUser, readStdin as readStdinShared, type HookEvent, type HookRunResult, type HookTranslator } from "../hooks/pipeline.js";

export interface ClaudeCodeHookInput {
  session_id: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  /** PermissionDenied only. */
  denial_reason?: string;
}

/** Events Claude Code sends after the decision, and what each says about the call. */
export const OUTCOME_EVENTS: Record<string, "ran" | "failed" | "denied"> = {
  PostToolUse: "ran",
  PostToolUseFailure: "failed",
  PermissionDenied: "denied",
};

export function runIdOf(input: ClaudeCodeHookInput): string {
  return `claude-code:${input.session_id}`;
}

export interface ClaudeCodeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

export function toDecisionRequest(input: ClaudeCodeHookInput): DecisionRequest {
  const req: DecisionRequest = {
    runId: runIdOf(input),
    principal: {
      runtime: "claude-code",
      agent: input.agent_type ? `subagent:${input.agent_type}` : "main",
      user: safeUser(),
    },
    tool: classifyTool(input.tool_name),
    args: input.tool_input ?? {},
  };
  if (input.cwd !== undefined) req.cwd = input.cwd;
  if (input.permission_mode !== undefined) req.permissionMode = input.permission_mode;
  if (input.tool_use_id !== undefined) req.callId = input.tool_use_id;
  return req;
}


export type { HookRunResult };

/**
 * The JSON Claude Code should receive, or null when Yenop has nothing to say
 * (allow, or observe mode). Shared by the command hook and the daemon's HTTP hook.
 */
export function hookDecisionBody(effect: "allow" | "deny" | "ask", message: string, mode: "enforce" | "observe"): ClaudeCodeHookOutput | null {
  if (mode === "observe" || effect === "allow") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: effect,
      permissionDecisionReason: `Yenop: ${message}`,
    },
  };
}

/** Command-hook rendering: nothing on allow, JSON on ask, JSON plus exit 2 on deny. */
export function renderHookResult(effect: "allow" | "deny" | "ask", message: string, mode: "enforce" | "observe" = "enforce"): HookRunResult {
  const body = hookDecisionBody(effect, message, mode);
  if (!body) return { stdout: "", exitCode: 0 };
  return { stdout: JSON.stringify(body), exitCode: effect === "deny" ? 2 : 0 };
}

function renderFromBody(body: ClaudeCodeHookOutput | Record<string, never>): HookRunResult {
  if (!("hookSpecificOutput" in body)) return { stdout: "", exitCode: 0 };
  return { stdout: JSON.stringify(body), exitCode: body.hookSpecificOutput.permissionDecision === "deny" ? 2 : 0 };
}

/**
 * Parse a Claude Code hook event. Throws on input that is not Claude Code's JSON, so the pipeline fails closed:
 * a permission hook that cannot read its input must block, not shrug.
 */
export function parseClaudeCode(raw: string): HookEvent {
  const input = JSON.parse(raw) as ClaudeCodeHookInput; // throws → deny
  if (typeof input.tool_name !== "string" || typeof input.session_id !== "string") throw new Error("claude-code hook event without tool_name/session_id");
  const outcome = OUTCOME_EVENTS[input.hook_event_name ?? ""];
  if (outcome) {
    if (!input.tool_use_id) return { kind: "ignore" };
    const ev: HookEvent = { kind: "outcome", runId: runIdOf(input), callId: input.tool_use_id, tool: input.tool_name, outcome };
    if (input.denial_reason !== undefined) ev.detail = input.denial_reason;
    if (input.cwd !== undefined) ev.cwd = input.cwd;
    return ev;
  }
  if (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse") return { kind: "ignore" };
  return { kind: "decision", event: "PreToolUse", askCapable: true, request: toDecisionRequest(input) };
}

export const claudeCodeTranslator: HookTranslator = {
  runtime: "claude-code",
  parse: parseClaudeCode,
  body: (effect: "allow" | "ask" | "deny", message: string, mode: Mode) => hookDecisionBody(effect, message, mode) as Record<string, unknown> | null,
  result: (body) => renderFromBody((body ?? {}) as ClaudeCodeHookOutput | Record<string, never>),
  failure: (reason) => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Yenop failed and refuses by default: ${reason}. Run "yenop status".` } }),
    exitCode: 2,
  }),
};

/** Command hook entry point: the shared pipeline with the Claude Code translator. */
export function runHook(raw: string): Promise<HookRunResult> {
  return runHookWith(claudeCodeTranslator, raw);
}

export const readStdin = readStdinShared;
