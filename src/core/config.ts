import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetLimits } from "./types.js";

export interface YenopConfig {
  home: string;
  tenant: string;
  budgets: BudgetLimits;
  /** Policy directories searched in order; later ones add to earlier ones. */
  policyDirs: string[];
  receiptsPath: string;
  statePath: string;
}

export const DEFAULT_BUDGETS: BudgetLimits = {
  maxStepsPerRun: 1000,
  maxDeniesPerRun: 20,
};

/** Resolve configuration from YENOP_HOME (default ~/.yenop) and an optional project dir. */
export function loadConfig(opts: { cwd?: string; home?: string; builtinPoliciesDir: string }): YenopConfig {
  const home = opts.home ?? process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
  let fileCfg: Partial<{ tenant: string; budgets: Partial<BudgetLimits> }> = {};
  const cfgPath = join(home, "config.json");
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as typeof fileCfg;
    } catch (e) {
      throw new Error(`yenop: cannot parse ${cfgPath}: ${(e as Error).message}`);
    }
  }
  const policyDirs: string[] = [];
  const userPolicies = join(home, "policies");
  policyDirs.push(existsSync(userPolicies) ? userPolicies : opts.builtinPoliciesDir);
  if (opts.cwd) {
    const projectPolicies = join(opts.cwd, ".yenop", "policies");
    if (existsSync(projectPolicies)) policyDirs.push(projectPolicies);
  }
  return {
    home,
    tenant: fileCfg.tenant ?? "local",
    budgets: { ...DEFAULT_BUDGETS, ...(fileCfg.budgets ?? {}) },
    policyDirs,
    receiptsPath: join(home, "receipts.jsonl"),
    statePath: join(home, "state.db"),
  };
}

export function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}
