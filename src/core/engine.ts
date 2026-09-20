import { uuidv7 } from "./ids.js";
import { isAbsolute, resolve } from "node:path";
import type { BudgetLimits, Decision, DecisionRequest, Effect, FlowFacts, Outcome, OutcomeReceipt, PolicyBundle, Receipt, ReceiptSink, RunStateStore, StepRecord } from "./types.js";
import type { ShellFacts } from "./shell.js";
import { evaluate, type EvalInput } from "./policy.js";
import { summarizeCall, trimForReceipt } from "./receipts.js";
import { analyzeShell, isControlPlanePath, isInternalHost, matchesSecretPattern, normalizePath, FS_IGNORES_CASE } from "./shell.js";
import { RECEIPT_VERSION } from "./types.js";

export interface EngineDeps {
  tenant: import("./types.js").TenantRef;
  mode: "enforce" | "observe";
  /** Policies failed to load. Every decision is a deny until a person fixes them. */
  policyError?: string;
  secretPatterns: string[];
  sensitivePatterns?: string[];
  trustedServers?: string[];
  sensitiveServers?: string[];
  policies: PolicyBundle;
  budgets: BudgetLimits;
  state: RunStateStore;
  receipts: ReceiptSink;
  now?: () => Date;
}

/** Facts derived from the request so policies can stay declarative. */
function derive(req: DecisionRequest, secretPatterns: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const p = req.args["file_path"] ?? req.args["path"] ?? req.args["notebook_path"];
  if (typeof p === "string") {
    const abs = isAbsolute(p) ? p : resolve(req.cwd ?? process.cwd(), p);
    if (req.cwd) {
      // containment is decided on normalized paths, so separators and letter case never let a write "escape"
      const rootN = normalizePath(resolve(req.cwd), { foldCase: FS_IGNORES_CASE });
      const absN = normalizePath(abs, { foldCase: FS_IGNORES_CASE });
      out["insideProject"] = absN === rootN || absN.startsWith(rootN + "/");
    }
    out["absolutePath"] = abs;
    out["secretPath"] = matchesSecretPattern(abs, secretPatterns);
    out["controlPlanePath"] = isControlPlanePath(abs);
  }
  return out;
}

/**
 * What this call does, in terms that do not depend on the tool: does it take in outside content,
 * read data that should not travel, reach beyond this machine, send data out, change state.
 * Run-level rules are written against these, so a plan split across harmless-looking calls still adds up.
 */
function flowOf(deps: EngineDeps, req: DecisionRequest, derived: Record<string, string | number | boolean>, shell: ShellFacts | undefined): FlowFacts {
  const f: FlowFacts = { ingestsUntrusted: false, readsSensitive: false, usesNetwork: false, externalNetwork: false, sendsOut: false, changesState: false };
  const path = typeof derived["absolutePath"] === "string" ? (derived["absolutePath"] as string) : undefined;
  const sensitiveFile = path !== undefined && (derived["secretPath"] === true || matchesSecretPattern(path, deps.sensitivePatterns ?? []));
  switch (req.tool.kind) {
    case "shell":
      if (shell) {
        f.ingestsUntrusted = shell.download;
        f.readsSensitive = shell.sensitiveRead || shell.paths.some((p) => matchesSecretPattern(p, deps.sensitivePatterns ?? []));
        f.usesNetwork = shell.network;
        f.externalNetwork = shell.externalNetwork;
        f.sendsOut = shell.outbound;
        f.changesState = shell.destructive;
      }
      break;
    case "web": {
      f.usesNetwork = true;
      const url = typeof req.args["url"] === "string" ? (req.args["url"] as string) : undefined;
      let host: string | undefined;
      try {
        host = url ? new URL(url).hostname : undefined;
      } catch {
        host = undefined;
      }
      f.externalNetwork = host === undefined || !isInternalHost(host);
      if (req.tool.readOnly) f.ingestsUntrusted = f.externalNetwork;
      else f.sendsOut = true;
      break;
    }
    case "mcp": {
      const server = req.tool.server ?? "";
      const trusted = (deps.trustedServers ?? []).includes(server);
      f.usesNetwork = true;
      // A server the customer vouches for is neither an untrusted source nor a way out.
      f.externalNetwork = !trusted;
      if (req.tool.readOnly) {
        f.ingestsUntrusted = !trusted;
        f.readsSensitive = (deps.sensitiveServers ?? []).includes(server);
      } else {
        f.sendsOut = true;
        f.changesState = true;
      }
      break;
    }
    case "read":
      f.readsSensitive = sensitiveFile;
      break;
    case "write":
      f.changesState = true;
      break;
    case "unknown":
      break;
  }
  return f;
}

/**
 * The person deciding cannot see the model's reasoning, so an ask carries the run's history instead:
 * which earlier steps made the run untrusted or sensitive, and what it did just before this call.
 */
function explainAsk(deps: EngineDeps, runId: string, before: { untrusted: boolean; sensitive: boolean }): string {
  // Claude Code shows this as plain text in a small box. Keep it to a glance: short summaries, nothing said twice.
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  const parts: string[] = [];
  const cited = new Set<number>();
  const src = deps.state.markSources(deps.tenant.id, runId);
  const at = (s: StepRecord) => {
    cited.add(s.step);
    return `step ${s.step} (${s.tool}: ${clip(s.summary, 40)})`;
  };
  if (before.untrusted && src.untrusted) parts.push(`took in outside content at ${at(src.untrusted)}`);
  if (before.sensitive && src.sensitive) parts.push(`touched sensitive data at ${at(src.sensitive)}`);
  const recent = deps.state.recentSteps(deps.tenant.id, runId, 3).filter((s) => !cited.has(s.step));
  let text = "";
  if (parts.length) text += ` Earlier in this run the agent ${parts.join(" and ")}.`;
  if (recent.length) text += ` Just before: ${recent.map((s) => `${s.step} ${s.tool} ${clip(s.summary, 32)}`).join("; ")}.`;
  return text;
}

/**
 * Record what the runtime reports about a call after the fact. Only asks are tracked: the question an auditor
 * has is "what did the person answer", and an allowed call that ran answers nothing.
 */
export function recordOutcome(deps: EngineDeps, runId: string, callId: string, tool: string, outcome: Outcome, detail?: string): OutcomeReceipt | undefined {
  const step = deps.state.setOutcome(deps.tenant.id, runId, callId, outcome);
  if (!step || step.effect !== "ask") return undefined;
  const r: OutcomeReceipt = {
    v: RECEIPT_VERSION,
    kind: "outcome",
    id: uuidv7(),
    ts: (deps.now ?? (() => new Date()))().toISOString(),
    tenant: deps.tenant,
    runId,
    callId,
    tool,
    outcome,
    decisionId: step.receiptId,
  };
  if (detail) r.detail = detail.slice(0, 300);
  deps.receipts.append(r);
  return r;
}

/**
 * The decision path, in order:
 *   1. budget breakers (cheapest, stops runaway loops)
 *   2. permit policies: may this happen at all? (Cedar default deny; errors fail closed)
 *   3. approval policies: must a person see it first? (a permit here means ask)
 *   4. receipt, always
 */
export function decide(deps: EngineDeps, req: DecisionRequest): Decision {
  const t0 = process.hrtime.bigint();
  if (req.callId !== undefined) {
    const seen = deps.state.recallCall(deps.tenant.id, req.runId, req.callId);
    if (seen) return { ...seen, replayed: true };
  }
  const before = deps.state.peek(deps.tenant.id, req.runId);
  const steps = before.steps + 1;
  const reasons: string[] = [];
  const errors: string[] = [];
  let effect: Effect;
  let message: string;
  const derived = derive(req, deps.secretPatterns);
  const cmd = req.args["command"];
  const shell = req.tool.kind === "shell" && typeof cmd === "string" ? analyzeShell(cmd, { secretPatterns: deps.secretPatterns }) : undefined;
  const flow = flowOf(deps, req, derived, shell);

  if (deps.policyError !== undefined) {
    effect = "deny";
    reasons.push("breaker:policies-invalid");
    errors.push(deps.policyError);
    message = `Yenop cannot load its policies, so every action is refused until a person fixes them. Run "yenop check". ${deps.policyError.split("\n").slice(0, 2).join(" ")}`;
  } else if (steps > deps.budgets.maxStepsPerRun) {
    effect = "deny";
    reasons.push("breaker:max-steps");
    message = `Run exceeded ${deps.budgets.maxStepsPerRun} tool calls; Yenop stopped it.`;
  } else if (before.denies >= deps.budgets.maxDeniesPerRun) {
    effect = "deny";
    reasons.push("breaker:max-denies");
    message = `Run hit ${deps.budgets.maxDeniesPerRun} denied calls; Yenop halted further actions.`;
  } else {
    const input: EvalInput = { req, run: { ...before, steps }, flow, derived };
    if (shell) input.shell = shell;
    const permit = evaluate(input, deps.policies.permit);
    errors.push(...permit.errors);
    if (permit.decision === "deny" || permit.errors.length > 0) {
      effect = "deny";
      reasons.push(...permit.reasons);
      message =
        permit.errors.length > 0
          ? `Policy evaluation error; Yenop fails closed (${permit.errors[0]}).`
          : permit.reasons.length > 0
            ? `Blocked by policy ${permit.reasons.join(", ")}.`
            : `No policy permits ${req.tool.name}.`;
    } else {
      reasons.push(...permit.reasons);
      const approve = evaluate(input, deps.policies.approve);
      errors.push(...approve.errors);
      if (approve.errors.length > 0) {
        effect = "deny";
        message = `Approval policy evaluation error; Yenop fails closed (${approve.errors[0]}).`;
      } else if (approve.decision === "allow") {
        effect = "ask";
        reasons.push(...approve.reasons.map((r) => `approve:${r}`));
        message = `Needs a person: ${approve.reasons.join(", ")}.`;
      } else {
        effect = "allow";
        message = `Permitted by ${permit.reasons.join(", ")}.`;
      }
    }
  }

  const after = deps.state.bump(deps.tenant.id, req.runId, effect, flow);
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const receipt: Receipt = {
    v: RECEIPT_VERSION,
    kind: "decision",
    id: uuidv7(),
    ts: (deps.now ?? (() => new Date()))().toISOString(),
    tenant: deps.tenant,
    runId: req.runId,
    runtime: req.principal.runtime,
    agent: req.principal.agent,
    user: req.principal.user,
    tool: req.tool.name,
    toolKind: req.tool.kind,
    args: trimForReceipt(req.args),
    mode: deps.mode,
    enforced: deps.mode === "enforce" && req.permissionMode !== "bypassPermissions",
    effect,
    reasons,
    errors,
    steps: after.steps,
    flow,
    runBefore: { untrusted: before.untrusted, sensitive: before.sensitive, outbound: before.outbound, destructive: before.destructive },
    latencyMs: Math.round(latencyMs * 100) / 100,
  };
  if (req.callId !== undefined) receipt.callId = req.callId;
  if (req.cwd !== undefined) receipt.cwd = req.cwd;
  if (req.permissionMode !== undefined) receipt.permissionMode = req.permissionMode;
  deps.receipts.append(receipt);

  if (effect === "ask") message += explainAsk(deps, req.runId, before);
  const stepRecord: StepRecord = {
    step: after.steps,
    tool: req.tool.name,
    summary: summarizeCall(req.args),
    effect,
    ingestsUntrusted: flow.ingestsUntrusted,
    readsSensitive: flow.readsSensitive,
    receiptId: receipt.id,
  };
  if (req.callId !== undefined) stepRecord.callId = req.callId;
  deps.state.recordStep(deps.tenant.id, req.runId, stepRecord);

  const decision: Decision = {
    effect,
    reasons,
    message,
    errors,
    budget: {
      steps: after.steps,
      denies: after.denies,
      asks: after.asks,
      maxSteps: deps.budgets.maxStepsPerRun,
      maxDenies: deps.budgets.maxDeniesPerRun,
    },
    receiptId: receipt.id,
    latencyMs: receipt.latencyMs,
    mode: deps.mode,
  };
  if (req.callId !== undefined) deps.state.rememberCall(deps.tenant.id, req.runId, req.callId, decision);
  return decision;
}
