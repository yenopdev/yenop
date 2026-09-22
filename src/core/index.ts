import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, ensureHome, type YenopConfig } from "./config.js";
import { loadPolicies } from "./policy.js";
import { SqliteRunState, MemoryRunState, RUN_IDLE_MS } from "./state.js";
import { JsonlReceipts, NullReceipts } from "./receipts.js";
import { decide, recordOutcome, type EngineDeps } from "./engine.js";
import type { Decision, DecisionRequest, Outcome, OutcomeReceipt, PolicyBundle, ReceiptSink, RunStateStore } from "./types.js";

export * from "./types.js";
export { classifyTool } from "./tools.js";
export { loadConfig, DEFAULT_BUDGETS, type Mode, type YenopConfig, type PolicyLayer } from "./config.js";
export { loadPolicies, checkPolicies, evaluate, toCedarValue } from "./policy.js";
export { RECEIPT_VERSION } from "./types.js";
export { decide } from "./engine.js";
export { uuidv7, uuidv7Time, newTenantId } from "./ids.js";
export { analyzeShell, matchesSecretPattern, isInternalHost, isControlPlanePath, DEFAULT_SECRET_PATTERNS, type ShellFacts } from "./shell.js";
export { loadSchema, validateAgainstSchema } from "./policy.js";
export { CONFIG_VERSION, resolveTenant, localTenantId } from "./config.js";
export { STATE_VERSION, REPLAY_WINDOW_MS } from "./state.js";
export { SqliteRunState, MemoryRunState } from "./state.js";
export { buildReport, renderReport, type Report } from "./report.js";
export { readTelemetry, writeTelemetry, enableTelemetry, disableTelemetry, resetInstallId, toTelemetry, sendTelemetry, dueForDaily, hookedRuntimes, DEFAULT_TELEMETRY_ENDPOINT, type TelemetryState, type TelemetryPayload } from "./telemetry.js";
export { JsonlReceipts, NullReceipts, readReceipts, readAllReceipts, answersFor, isOutcome, summarizeCall, verifyReceipts, RECEIPT_GENESIS, type ChainCheck } from "./receipts.js";

/** Directory of the default policy pack shipped with the package. */
export function builtinPoliciesDir(): string {
  // dist/core/index.js -> ../../policies ; src/core/index.ts -> ../../policies
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policies");
}

export interface Yenop {
  config: YenopConfig;
  /** Set when the policies could not be loaded or do not match the vocabulary. Every decision is then a deny. */
  policyError?: string;
  decide(req: DecisionRequest): Decision;
  /** Record what the runtime reported about a call Yenop asked about: it ran, failed, or was refused. */
  recordOutcome(runId: string, callId: string, tool: string, outcome: Outcome, detail?: string): OutcomeReceipt | undefined;
  /** End a run now, because the runtime said the session ended. The next call on this id starts fresh. */
  endRun(runId: string): void;
  close(): void;
}

/** Wire the local, single-machine configuration: SQLite state, JSONL receipts, policies from disk. */
export interface OpenOptions {
  cwd?: string;
  home?: string;
  /** Dry run: same policies and config, but nothing is counted or recorded. */
  dryRun?: boolean;
  state?: RunStateStore;
  receipts?: ReceiptSink;
}

export function openYenop(opts: OpenOptions = {}): Yenop {
  const cfgOpts: Parameters<typeof loadConfig>[0] = { builtinPoliciesDir: builtinPoliciesDir() };
  if (opts.cwd !== undefined) cfgOpts.cwd = opts.cwd;
  if (opts.home !== undefined) cfgOpts.home = opts.home;
  const config = loadConfig(cfgOpts);
  ensureHome(config.home);
  // A guard that cannot read its rules must not wave everything through. Load errors become a standing deny,
  // and the instance still opens so `yenop check`, `status` and `receipts` can show a person what is wrong.
  let policies: PolicyBundle = { permit: {}, approve: {}, origins: {}, disabled: {}, layers: [], warnings: [] };
  let policyError: string | undefined;
  try {
    policies = loadPolicies(config.policyLayers, { disabled: config.disabledPolicies });
  } catch (e) {
    policyError = (e as Error).message.replace(/^yenop: /, "");
  }
  const idleMs = config.runIdleMs ?? RUN_IDLE_MS;
  const deps: EngineDeps = {
    idleMs,
    tenant: config.tenant,
    mode: config.mode,
    policies,
    ...(policyError !== undefined ? { policyError } : {}),
    secretPatterns: config.secretPatterns,
    sensitivePatterns: config.sensitivePatterns,
    trustedServers: config.trustedServers,
    sensitiveServers: config.sensitiveServers,
    budgets: config.budgets,
    state: opts.state ?? (opts.dryRun ? new MemoryRunState() : new SqliteRunState(config.statePath)),
    receipts: opts.receipts ?? (opts.dryRun ? new NullReceipts() : new JsonlReceipts(config.receiptsPath)),
  };
  return {
    config,
    ...(policyError !== undefined ? { policyError } : {}),
    decide: (req) => decide(deps, req),
    recordOutcome: (runId, callId, tool, outcome, detail) => recordOutcome(deps, runId, callId, tool, outcome, detail),
    endRun: (runId) => deps.state.endRun(deps.tenant.id, runId),
    close: () => {
      deps.state.close();
      deps.receipts.close();
    },
  };
}
