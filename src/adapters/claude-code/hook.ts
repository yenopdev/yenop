/**
 * Claude Code PreToolUse adapter.
 * stdin: the hook JSON Claude Code sends. stdout: a hook decision, or nothing to defer to Claude Code's own flow.
 * Yenop only ever tightens: on allow it prints nothing, on ask it asks, on deny it blocks (exit 2 + JSON reason).
 */
import { classifyTool, openYenop, type DecisionRequest } from "../../core/index.js";
import { userInfo } from "node:os";

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
}

export interface ClaudeCodeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

export function toDecisionRequest(input: ClaudeCodeHookInput, tenant: string): DecisionRequest {
  const req: DecisionRequest = {
    tenant,
    runId: `claude-code:${input.session_id}`,
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

/** Pure mapping from a Yenop decision to what Claude Code should see. */
export function renderHookResult(effect: "allow" | "deny" | "ask", message: string): HookRunResult {
  if (effect === "allow") return { stdout: "", exitCode: 0 };
  const out: ClaudeCodeHookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: effect,
      permissionDecisionReason: `Yenop: ${message}`,
    },
  };
  return { stdout: JSON.stringify(out), exitCode: effect === "deny" ? 2 : 0 };
}

export async function runHook(raw: string): Promise<HookRunResult> {
  let input: ClaudeCodeHookInput;
  try {
    input = JSON.parse(raw) as ClaudeCodeHookInput;
  } catch {
    // Not our JSON. Never block on a parse problem; let Claude Code's own flow apply.
    return { stdout: "", exitCode: 0 };
  }
  if (!input.tool_name || !input.session_id) return { stdout: "", exitCode: 0 };
  const yenop = openYenop(input.cwd !== undefined ? { cwd: input.cwd } : {});
  try {
    const decision = yenop.decide(toDecisionRequest(input, yenop.config.tenant));
    // Observe mode: the decision and receipt exist, but the runtime is never told.
    if (yenop.config.mode === "observe") return { stdout: "", exitCode: 0 };
    return renderHookResult(decision.effect, decision.message);
  } finally {
    yenop.close();
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
