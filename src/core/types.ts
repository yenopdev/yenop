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
  /** Hash of the previous receipt line: the tamper-evident chain. Absent on the first line and older files. */
  prev?: string;
  /** "decision" (absent on older lines). Outcome lines carry kind "outcome". */
  kind?: "decision";
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

/** What happened to a call after Yenop asked: it ran, it ran and failed, or the permission system refused it. */
export type Outcome = "ran" | "failed" | "denied";

/** One line of a run's history, kept so an approval can show how the run got here. */
export interface StepRecord {
  step: number;
  callId?: string;
  tool: string;
  /** Short, single-line description of the call: the command, path, URL or query. */
  summary: string;
  effect: Effect;
  ingestsUntrusted: boolean;
  readsSensitive: boolean;
  receiptId: string;
  outcome?: Outcome;
}

/** Written when the runtime reports what became of a call Yenop asked about. */
export interface OutcomeReceipt {
  v: number;
  /** Hash of the previous receipt line (the chain covers every line, decisions and outcomes). */
  prev?: string;
  kind: "outcome";
  id: string;
  ts: string;
  tenant: TenantRef;
  runId: string;
  callId: string;
  tool: string;
  outcome: Outcome;
  /** The decision receipt this answers. */
  decisionId: string;
  detail?: string;
}

export interface RunStateStore {
  /**
   * If the run has been idle longer than `idleMs`, forget its accumulated facts and history so the next call
   * starts a fresh run. A crashed or abandoned session must not taint a later one that reuses the same id.
   * Called once at the top of a decision. Returns true if a stale run was cleared.
   */
  expireIfIdle(tenant: string, runId: string, idleMs: number): boolean;
  /** End a run now (a runtime told us the session ended). The next call on this id starts fresh. */
  endRun(tenant: string, runId: string): void;
  /** Atomically records one call, folds its flow into the run, and returns the run's facts after it. */
  bump(tenant: string, runId: string, effect: Effect, flow?: FlowFacts): RunFacts;
  /** Read the run's facts without changing them. */
  peek(tenant: string, runId: string): RunFacts;
  /** Idempotency: the decision already made for this call id in this run, if any. */
  recallCall(tenant: string, runId: string, callId: string): Decision | undefined;
  /** Remember a decision so a repeated hook firing for the same call returns it unchanged. */
  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void;
  /** Append one step to the run's history. */
  recordStep(tenant: string, runId: string, step: StepRecord): void;
  /** The last `limit` steps of the run, oldest first. */
  recentSteps(tenant: string, runId: string, limit: number): StepRecord[];
  /** The steps that first made the run untrusted and sensitive, if any. */
  markSources(tenant: string, runId: string): { untrusted?: StepRecord; sensitive?: StepRecord };
  /** Record what became of a call. Returns the step if this is the first outcome for it, else undefined. */
  setOutcome(tenant: string, runId: string, callId: string, outcome: Outcome): StepRecord | undefined;
  close(): void;
}

export interface ReceiptSink {
  append(receipt: Receipt | OutcomeReceipt): void;
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
