import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { BudgetLimits, TenantRef } from "./types.js";
import { DEFAULT_SECRET_PATTERNS } from "./shell.js";

/** Config file format version. Files without `v` are treated as version 1. */
export const CONFIG_VERSION = 1;

export type Mode = "enforce" | "observe";

export interface PolicyLayer {
  /** baseline (shipped with Yenop), home (this machine or tenant), project (this repo). */
  name: "baseline" | "home" | "project";
  dir: string;
}

export interface YenopConfig {
  home: string;
  tenant: TenantRef;
  /** Secret-file patterns: the defaults plus anything added in config.json. */
  secretPatterns: string[];
  /** File patterns whose contents count as sensitive data for run-level rules (not blocked, but remembered). */
  sensitivePatterns: string[];
  /** MCP servers whose reads are trusted content. Everything else read over MCP counts as untrusted input. */
  trustedServers: string[];
  /** MCP servers whose reads count as sensitive data. */
  sensitiveServers: string[];
  /** enforce: decisions are returned to the runtime. observe: decisions are only recorded. */
  mode: Mode;
  budgets: BudgetLimits;
  /**
   * Policy layers, evaluated together. The baseline is always present and comes from the package;
   * home and project layers add to it. Cedar semantics: any forbid wins, permits add up.
   */
  policyLayers: PolicyLayer[];
  /** Baseline (or any) policy ids switched off in config.json, so customers never edit shipped files. */
  disabledPolicies: string[];
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
  type FileCfg = Partial<{
    v: number;
    tenant: string | Partial<TenantRef>;
    mode: Mode;
    budgets: Partial<BudgetLimits>;
    disabledPolicies: string[];
    secretPatterns: string[];
    sensitivePatterns: string[];
    trustedServers: string[];
    sensitiveServers: string[];
  }>;
  const readCfg = (path: string): FileCfg => {
    if (!existsSync(path)) return {};
    let cfg: FileCfg;
    try {
      cfg = JSON.parse(readFileSync(path, "utf8")) as FileCfg;
    } catch (e) {
      throw new Error(`yenop: cannot parse ${path}: ${(e as Error).message}`);
    }
    if (cfg.v !== undefined && cfg.v > CONFIG_VERSION) {
      throw new Error(`yenop: ${path} is config version ${cfg.v}; this Yenop understands up to ${CONFIG_VERSION}. Upgrade Yenop.`);
    }
    return cfg;
  };
  // precedence: YENOP_MODE env > <project>/.yenop/config.json > ~/.yenop/config.json > defaults
  const homeCfg = readCfg(join(home, "config.json"));
  const projectCfg = opts.cwd ? readCfg(join(opts.cwd, ".yenop", "config.json")) : {};
  const fileCfg: FileCfg = { ...homeCfg, ...projectCfg, budgets: { ...(homeCfg.budgets ?? {}), ...(projectCfg.budgets ?? {}) } };
  const envMode = process.env["YENOP_MODE"];
  const mode: Mode = envMode === "observe" || envMode === "enforce" ? envMode : (fileCfg.mode ?? "enforce");
  const policyLayers: PolicyLayer[] = [{ name: "baseline", dir: opts.builtinPoliciesDir }];
  const homePolicies = join(home, "policies");
  if (existsSync(homePolicies)) policyLayers.push({ name: "home", dir: homePolicies });
  if (opts.cwd) {
    const projectPolicies = join(opts.cwd, ".yenop", "policies");
    if (existsSync(projectPolicies)) policyLayers.push({ name: "project", dir: projectPolicies });
  }
  const disabledPolicies = [...new Set([...(homeCfg.disabledPolicies ?? []), ...(projectCfg.disabledPolicies ?? [])])];
  const secretPatterns = [...DEFAULT_SECRET_PATTERNS, ...(homeCfg.secretPatterns ?? []), ...(projectCfg.secretPatterns ?? [])];
  const tenant = resolveTenant(fileCfg.tenant);
  const both = (k: "sensitivePatterns" | "trustedServers" | "sensitiveServers") => [...new Set([...(homeCfg[k] ?? []), ...(projectCfg[k] ?? [])])];
  return {
    home,
    tenant,
    secretPatterns,
    sensitivePatterns: both("sensitivePatterns"),
    trustedServers: both("trustedServers"),
    sensitiveServers: both("sensitiveServers"),
    mode,
    budgets: { ...DEFAULT_BUDGETS, ...(fileCfg.budgets ?? {}) },
    policyLayers,
    disabledPolicies,
    receiptsPath: join(home, "receipts.jsonl"),
    statePath: join(home, "state.db"),
  };
}

/**
 * A tenant always has a stable id. Configs written by `init` carry one; older or hand-written
 * configs that only name the tenant get a deterministic id from this machine and user,
 * so receipts from the same place always agree.
 */
export function resolveTenant(raw: string | Partial<TenantRef> | undefined): TenantRef {
  const name = typeof raw === "string" ? raw : (raw?.name ?? "local");
  const id = typeof raw === "object" && raw?.id ? raw.id : localTenantId();
  if (!/^tn_[a-z0-9]{26}$/.test(id)) throw new Error(`yenop: tenant id "${id}" must look like tn_ followed by 26 lowercase letters or digits`);
  return { id, name };
}

export function localTenantId(): string {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  const h = createHash("sha256").update(`${hostname()}\u0000${user}`).digest();
  return "tn_" + BigInt("0x" + h.subarray(0, 16).toString("hex")).toString(32).padStart(26, "0").slice(0, 26);
}

export function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}
