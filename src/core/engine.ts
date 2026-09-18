import { uuidv7 } from "./ids.js";
import { isAbsolute, resolve, sep } from "node:path";
import type { BudgetLimits, Decision, DecisionRequest, Effect, FlowFacts, PolicyBundle, Receipt, ReceiptSink, RunStateStore } from "./types.js";
import type { ShellFacts } from "./shell.js";
import { evaluate, type EvalInput } from "./policy.js";
import { trimForReceipt } from "./receipts.js";
import { analyzeShell, isInternalHost, matchesSecretPattern } from "./shell.js";
import { RECEIPT_VERSION } from "./types.js";

export interface EngineDeps {
  tenant: import("./types.js").TenantRef;
  mode: "enforce" | "observe";
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
      const root = resolve(req.cwd) + sep;
      out["insideProject"] = abs === resolve(req.cwd) || abs.startsWith(root);
    }
    out["absolutePath"] = abs;
    out["secretPath"] = matchesSecretPattern(abs, secretPatterns);
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

  if (steps > deps.budgets.maxStepsPerRun) {
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
