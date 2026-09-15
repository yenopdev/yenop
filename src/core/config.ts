import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetLimits } from "./types.js";

export type Mode = "enforce" | "observe";

export interface YenopConfig {
  home: string;
  tenant: string;
  /** enforce: decisions are returned to the runtime. observe: decisions are only recorded. */
  mode: Mode;
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
  type FileCfg = Partial<{ tenant: string; mode: Mode; budgets: Partial<BudgetLimits> }>;
  const readCfg = (path: string): FileCfg => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as FileCfg;
    } catch (e) {
      throw new Error(`yenop: cannot parse ${path}: ${(e as Error).message}`);
    }
  };
  // precedence: YENOP_MODE env > <project>/.yenop/config.json > ~/.yenop/config.json > defaults
  const homeCfg = readCfg(join(home, "config.json"));
  const projectCfg = opts.cwd ? readCfg(join(opts.cwd, ".yenop", "config.json")) : {};
  const fileCfg: FileCfg = { ...homeCfg, ...projectCfg, budgets: { ...(homeCfg.budgets ?? {}), ...(projectCfg.budgets ?? {}) } };
  const envMode = process.env["YENOP_MODE"];
  const mode: Mode = envMode === "observe" || envMode === "enforce" ? envMode : (fileCfg.mode ?? "enforce");
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
    mode,
    budgets: { ...DEFAULT_BUDGETS, ...(fileCfg.budgets ?? {}) },
    policyDirs,
    receiptsPath: join(home, "receipts.jsonl"),
    statePath: join(home, "state.db"),
  };
}

export function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}
