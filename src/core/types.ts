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

export interface TenantRef {
  /** Stable identifier, e.g. "tn_01a0a6f042c9720fbfd6279348". Never changes once issued. */
  id: string;
  /** Display name; may change. */
  name: string;
}

export interface DecisionRequest {
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

export const RECEIPT_VERSION = 1;

export interface Receipt {
  /** Receipt format version. Parsers must reject versions they do not know. */
  v: number;
  id: string;
  ts: string;
  tenant: TenantRef;
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
  /** What this call does. */
  flow?: FlowFacts;
  /** What the run had already done when this call was decided. */
  runBefore?: { untrusted: boolean; sensitive: boolean; outbound: number; destructive: number };
  latencyMs: number;
}

export interface BudgetLimits {
  maxStepsPerRun: number;
  maxDeniesPerRun: number;
}

/** What a run has done so far. Flags are sticky: once true, true for the rest of the run. */
export interface RunFacts {
  steps: number;
  denies: number;
  asks: number;
  /** The run has taken in content from outside: web pages, downloads, untrusted MCP reads. */
  untrusted: boolean;
  /** The run has touched data that should not travel. */
  sensitive: boolean;
  /** Calls that sent data out. */
  outbound: number;
  /** Destructive calls that were not denied. */
  destructive: number;
}

/** What one call does, independent of which tool did it. */
export interface FlowFacts {
  ingestsUntrusted: boolean;
  readsSensitive: boolean;
  usesNetwork: boolean;
  externalNetwork: boolean;
  sendsOut: boolean;
  changesState: boolean;
}

export interface RunStateStore {
  /** Atomically records one call, folds its flow into the run, and returns the run's facts after it. */
  bump(tenant: string, runId: string, effect: Effect, flow?: FlowFacts): RunFacts;
  /** Read the run's facts without changing them. */
  peek(tenant: string, runId: string): RunFacts;
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
  /** Where each policy id came from (layer and file), for receipts and error messages. */
  origins: Record<string, string>;
  /** Validation warnings (not errors) from checking policies against the schema. */
  warnings: string[];
  /** Ids that were switched off through config, with the layer they came from. */
  disabled: Record<string, string>;
  /** Per-layer counts, for `yenop check` and `yenop status`. */
  layers: { name: string; dir: string; permit: number; approve: number }[];
}
