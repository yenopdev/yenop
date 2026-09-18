/**
 * Claude Code PreToolUse adapter.
 * stdin: the hook JSON Claude Code sends. stdout: a hook decision, or nothing to defer to Claude Code's own flow.
 * Yenop only ever tightens: on allow it prints nothing, on ask it asks, on deny it blocks (exit 2 + JSON reason).
 */
import { classifyTool } from "../../core/tools.js";
import type { DecisionRequest } from "../../core/types.js";
import { userInfo, homedir } from "node:os";
import { join } from "node:path";

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

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

export interface HookRunResult {
  stdout: string;
  exitCode: number;
}

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
 * Command hook entry point. Fast path: forward to the resident daemon (~1 ms plus Node startup).
 * Fallback: decide in this process, then start a daemon for next time.
 */
export async function runHook(raw: string): Promise<HookRunResult> {
  let input: ClaudeCodeHookInput;
  try {
    input = JSON.parse(raw) as ClaudeCodeHookInput;
  } catch {
    // Not our JSON. Never block on a parse problem; let Claude Code's own flow apply.
    return { stdout: "", exitCode: 0 };
  }
  if (!input.tool_name || !input.session_id) return { stdout: "", exitCode: 0 };

  const home = process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
  const useDaemon = process.env["YENOP_NO_DAEMON"] !== "1";
  if (useDaemon) {
    const { readDaemonInfoFast, rawPost } = await import("../../daemon/fast.js");
    const info = readDaemonInfoFast(home);
    if (info) {
      try {
        const r = await rawPost(info, "/hooks/claude-code", raw, 1500);
        if (r.status === 200) return renderFromBody(JSON.parse(r.body) as ClaudeCodeHookOutput | Record<string, never>);
      } catch {
        /* daemon not reachable: fall through and decide here */
      }
    }
  }

  const { openYenop } = await import("../../core/index.js");
  const yenop = openYenop(input.cwd !== undefined ? { cwd: input.cwd } : {});
  try {
    const outcome = OUTCOME_EVENTS[input.hook_event_name ?? ""];
    if (outcome) {
      if (input.tool_use_id) yenop.recordOutcome(runIdOf(input), input.tool_use_id, input.tool_name, outcome, input.denial_reason);
      return { stdout: "", exitCode: 0 };
    }
    const decision = yenop.decide(toDecisionRequest(input));
    return renderHookResult(decision.effect, decision.message, yenop.config.mode);
  } finally {
    yenop.close();
    if (useDaemon) {
      const { startDaemonDetached } = await import("../../daemon/client.js");
      try {
        startDaemonDetached(home);
      } catch {
        /* next call will try again */
      }
    }
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
