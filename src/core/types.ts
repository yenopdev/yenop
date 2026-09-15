/** Yenop core types. Everything the decision engine reads or writes. */

export type Effect = "allow" | "deny" | "ask";

export type ToolKind = "read" | "write" | "shell" | "web" | "mcp" | "unknown";

export interface ToolRef {
  /** Tool name as the runtime reports it, e.g. "Bash", "mcp__github__create_issue". */
  name: string;
  kind: ToolKind;
  readOnly: boolean;
  /** MCP server name when the tool is an MCP tool. */
  server?: string;
}

export interface Principal {
  /** Which runtime is acting, e.g. "claude-code". */
  runtime: string;
  /** Stable agent identifier inside that runtime. */
  agent: string;
  /** The human the agent is acting for. */
  user: string;
}

export interface DecisionRequest {
  tenant: string;
  /** One run is one agent session; budgets are scoped to it. */
  runId: string;
  principal: Principal;
  tool: ToolRef;
  /** The exact arguments the runtime is about to pass to the tool. */
  args: Record<string, unknown>;
  /** Working directory of the runtime, when known. */
  cwd?: string;
  /** Runtime permission mode, if the runtime exposes one. */
  permissionMode?: string;
  /** Runtime-specific correlation id for this single call. */
  callId?: string;
}

export interface BudgetSnapshot {
  steps: number;
  denies: number;
  asks: number;
  maxSteps: number;
  maxDenies: number;
}

export interface Decision {
  effect: Effect;
  /** Policy ids or breaker names that produced the effect. */
  reasons: string[];
  /** Human-readable one-liner suitable for showing to a person. */
  message: string;
  /** Evaluation errors, if any. Errors always fail closed to deny. */
  errors: string[];
  budget: BudgetSnapshot;
  receiptId: string;
  latencyMs: number;
  /** enforce: the runtime is expected to honor this. observe: recorded only. */
  mode: "enforce" | "observe";
  /** True when this call id was already decided in this run and the earlier decision was returned. */
  replayed?: boolean;
}

export interface Receipt {
  id: string;
  ts: string;
  tenant: string;
  runId: string;
  callId?: string;
  runtime: string;
  agent: string;
  user: string;
  tool: string;
  toolKind: ToolKind;
  args: unknown;
  cwd?: string;
  permissionMode?: string;
  mode: "enforce" | "observe";
  /** False in observe mode, or when the runtime said it ignores decisions (e.g. bypassPermissions). */
  enforced: boolean;
  effect: Effect;
  reasons: string[];
  errors: string[];
  steps: number;
  latencyMs: number;
}

export interface BudgetLimits {
  maxStepsPerRun: number;
  maxDeniesPerRun: number;
}

export interface RunStateStore {
  /** Atomically records one call and returns the counters after it. */
  bump(tenant: string, runId: string, effect: Effect): { steps: number; denies: number; asks: number };
  /** Read counters without changing them. */
  peek(tenant: string, runId: string): { steps: number; denies: number; asks: number };
  /** Idempotency: the decision already made for this call id in this run, if any. */
  recallCall(tenant: string, runId: string, callId: string): Decision | undefined;
  /** Remember a decision so a repeated hook firing for the same call returns it unchanged. */
  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void;
  close(): void;
}

export interface ReceiptSink {
  append(receipt: Receipt): void;
  close(): void;
}

export interface PolicyBundle {
  /** Policies answering "may this happen at all". Cedar default is deny. */
  permit: Record<string, string>;
  /** Policies answering "must a person see this first". A permit here means ask. */
  approve: Record<string, string>;
  /** Where each policy id came from, for receipts and error messages. */
  origins: Record<string, string>;
}
