import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, ensureHome, type YenopConfig } from "./config.js";
import { loadPolicies } from "./policy.js";
import { SqliteRunState, MemoryRunState } from "./state.js";
import { JsonlReceipts, NullReceipts } from "./receipts.js";
import { decide, type EngineDeps } from "./engine.js";
import type { Decision, DecisionRequest, ReceiptSink, RunStateStore } from "./types.js";

export * from "./types.js";
export { classifyTool } from "./tools.js";
export { loadConfig, DEFAULT_BUDGETS, type Mode, type YenopConfig, type PolicyLayer } from "./config.js";
export { loadPolicies, checkPolicies, evaluate, toCedarValue } from "./policy.js";
export { RECEIPT_VERSION } from "./types.js";
export { decide } from "./engine.js";
export { uuidv7, uuidv7Time, newTenantId } from "./ids.js";
export { analyzeShell, matchesSecretPattern, isInternalHost, DEFAULT_SECRET_PATTERNS, type ShellFacts } from "./shell.js";
export { loadSchema, validateAgainstSchema } from "./policy.js";
export { CONFIG_VERSION, resolveTenant, localTenantId } from "./config.js";
export { STATE_VERSION } from "./state.js";
export { SqliteRunState, MemoryRunState } from "./state.js";
export { JsonlReceipts, NullReceipts, readReceipts } from "./receipts.js";

/** Directory of the default policy pack shipped with the package. */
export function builtinPoliciesDir(): string {
  // dist/core/index.js -> ../../policies ; src/core/index.ts -> ../../policies
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policies");
}

export interface Yenop {
  config: YenopConfig;
  decide(req: DecisionRequest): Decision;
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
  const deps: EngineDeps = {
    tenant: config.tenant,
    mode: config.mode,
    policies: loadPolicies(config.policyLayers, { disabled: config.disabledPolicies }),
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
    decide: (req) => decide(deps, req),
    close: () => {
      deps.state.close();
      deps.receipts.close();
    },
  };
}
