import type { ToolRef } from "./types.js";

/** Claude Code built-in tools and what they can do. Unknown tools are treated as not read-only. */
const CLAUDE_CODE_TOOLS: Record<string, { kind: ToolRef["kind"]; readOnly: boolean }> = {
  Read: { kind: "read", readOnly: true },
  Glob: { kind: "read", readOnly: true },
  Grep: { kind: "read", readOnly: true },
  LS: { kind: "read", readOnly: true },
  TodoWrite: { kind: "read", readOnly: true },
  // Orchestration and UI tools: they act inside the runtime, not on outside systems.
  // A subagent's own tool calls come back through the hook individually.
  Task: { kind: "read", readOnly: true },
  Agent: { kind: "read", readOnly: true },
  Skill: { kind: "read", readOnly: true },
  ToolSearch: { kind: "read", readOnly: true },
  AskUserQuestion: { kind: "read", readOnly: true },
  EnterPlanMode: { kind: "read", readOnly: true },
  ExitPlanMode: { kind: "read", readOnly: true },
  BashOutput: { kind: "read", readOnly: true },
  KillShell: { kind: "read", readOnly: true },
  Monitor: { kind: "read", readOnly: true },
  TaskOutput: { kind: "read", readOnly: true },
  TaskStop: { kind: "read", readOnly: true },
  ListAgents: { kind: "read", readOnly: true },
  SendMessage: { kind: "read", readOnly: true },
  ScheduleWakeup: { kind: "read", readOnly: true },
  ReportFindings: { kind: "read", readOnly: true },
  EnterWorktree: { kind: "read", readOnly: true },
  ExitWorktree: { kind: "read", readOnly: true },
  WebFetch: { kind: "web", readOnly: true },
  WebSearch: { kind: "web", readOnly: true },
  // Publishes outside the machine.
  Artifact: { kind: "web", readOnly: false },
  Edit: { kind: "write", readOnly: false },
  MultiEdit: { kind: "write", readOnly: false },
  Write: { kind: "write", readOnly: false },
  NotebookEdit: { kind: "write", readOnly: false },
  Bash: { kind: "shell", readOnly: false },
};

const MCP_READ_HINT = /(^|_)(get|list|read|search|query|fetch|describe|show|find|lookup|view)(_|$)/i;

/** Classify a tool name into a ToolRef. Conservative: anything unknown is not read-only. */
export function classifyTool(name: string): ToolRef {
  const known = CLAUDE_CODE_TOOLS[name];
  if (known) return { name, ...known };
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const server = mcp[1] ?? "";
    const tool = mcp[2] ?? "";
    return { name, kind: "mcp", readOnly: MCP_READ_HINT.test(tool), server };
  }
  return { name, kind: "unknown", readOnly: false };
}
