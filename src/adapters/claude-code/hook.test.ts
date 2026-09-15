import { describe, it, expect } from "vitest";
import { renderHookResult, toDecisionRequest } from "./hook.js";

describe("claude code adapter", () => {
  it("maps the hook event to a decision request", () => {
    const r = toDecisionRequest(
      { session_id: "s1", cwd: "/p", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
      "local",
    );
    expect(r).toMatchObject({ runId: "claude-code:s1", cwd: "/p", callId: "t1", tool: { name: "Bash", kind: "shell" }, args: { command: "ls" } });
  });
  it("prints nothing on allow so Claude Code's own flow applies", () => {
    expect(renderHookResult("allow", "ok")).toEqual({ stdout: "", exitCode: 0 });
  });
  it("asks with the reason on ask", () => {
    const r = renderHookResult("ask", "Needs a person: destructive-shell.");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Yenop: Needs a person: destructive-shell." },
    });
  });
  it("blocks with exit 2 on deny", () => {
    const r = renderHookResult("deny", "Blocked by policy no-secret-files-in-shell.");
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
