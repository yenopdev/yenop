import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { DecisionRequest, PolicyBundle } from "./types.js";

/** Split a .cedar file into individual policies keyed by their @id annotation (or file:index). */
function splitPolicies(text: string, origin: string): Record<string, string> {
  const parts = cedar.policySetTextToParts(text);
  if (parts.type === "failure") {
    const msg = parts.errors.map((e) => e.message).join("; ");
    throw new Error(`yenop: cannot parse ${origin}: ${msg}`);
  }
  const out: Record<string, string> = {};
  parts.policies.forEach((p, i) => {
    let id = `${origin}#${i}`;
    const json = cedar.policyToJson(p);
    if (json.type === "success") {
      const ann = json.json.annotations as Record<string, string> | undefined;
      if (ann && typeof ann["id"] === "string" && ann["id"].length > 0) id = ann["id"];
    }
    if (out[id]) throw new Error(`yenop: duplicate policy id "${id}" in ${origin}`);
    out[id] = p;
  });
  return out;
}

function loadDir(dir: string, bundle: PolicyBundle, which: "permit" | "approve"): void {
  const sub = join(dir, which);
  if (!existsSync(sub)) return;
  for (const f of readdirSync(sub).filter((n) => n.endsWith(".cedar")).sort()) {
    const path = join(sub, f);
    const policies = splitPolicies(readFileSync(path, "utf8"), `${which}/${f}`);
    for (const [id, text] of Object.entries(policies)) {
      if (bundle[which][id]) throw new Error(`yenop: policy id "${id}" defined twice (${bundle.origins[id]} and ${path})`);
      bundle[which][id] = text;
      bundle.origins[id] = path;
    }
  }
}

/** Load permit/ and approve/ policies from each directory in order. */
export function loadPolicies(dirs: string[]): PolicyBundle {
  const bundle: PolicyBundle = { permit: {}, approve: {}, origins: {} };
  for (const d of dirs) {
    loadDir(d, bundle, "permit");
    loadDir(d, bundle, "approve");
  }
  return bundle;
}

/** Cedar only accepts integers as numbers; coerce anything else to a safe JSON shape. */
export function toCedarValue(v: unknown, depth = 0): cedar.CedarValueJson {
  if (depth > 8) return "[nested]";
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isInteger(v) ? v : String(v);
  if (typeof v === "bigint") return String(v);
  if (Array.isArray(v)) return v.map((x) => toCedarValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, cedar.CedarValueJson> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = toCedarValue(x, depth + 1);
    return out;
  }
  return String(v);
}

export interface EvalResult {
  decision: "allow" | "deny";
  reasons: string[];
  errors: string[];
}

export interface EvalInput {
  req: DecisionRequest;
  steps: number;
  /** Derived facts we compute so policies stay simple. */
  derived: Record<string, cedar.CedarValueJson>;
}

function buildCall(input: EvalInput, policies: Record<string, string>): cedar.AuthorizationCall {
  const { req } = input;
  const principal = { type: "Yenop::Agent", id: `${req.principal.runtime}/${req.principal.agent}` };
  const action = { type: "Yenop::Action", id: "call" };
  const resource = { type: "Yenop::Tool", id: req.tool.name };
  const toolAttrs: Record<string, cedar.CedarValueJson> = {
    name: req.tool.name,
    kind: req.tool.kind,
    readOnly: req.tool.readOnly,
  };
  if (req.tool.server) toolAttrs["server"] = req.tool.server;
  return {
    principal,
    action,
    resource,
    context: {
      args: toCedarValue(req.args),
      run: { steps: input.steps },
      cwd: req.cwd ?? "",
      permissionMode: req.permissionMode ?? "",
      derived: input.derived,
    },
    policies: { staticPolicies: policies },
    entities: [
      { uid: principal, attrs: { runtime: req.principal.runtime, agent: req.principal.agent, user: req.principal.user }, parents: [] },
      { uid: action, attrs: {}, parents: [] },
      { uid: resource, attrs: toolAttrs, parents: [] },
    ],
  };
}

/** Evaluate one policy set. Any evaluation error is reported; the engine fails closed on errors. */
export function evaluate(input: EvalInput, policies: Record<string, string>): EvalResult {
  if (Object.keys(policies).length === 0) return { decision: "deny", reasons: [], errors: [] };
  const answer = cedar.isAuthorized(buildCall(input, policies));
  if (answer.type === "failure") {
    return { decision: "deny", reasons: [], errors: answer.errors.map((e) => e.message) };
  }
  const { decision, diagnostics } = answer.response;
  return {
    decision,
    reasons: diagnostics.reason,
    errors: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`),
  };
}

/** Parse-check a bundle without evaluating. Throws with a readable message on the first problem. */
export function checkPolicies(bundle: PolicyBundle): void {
  for (const which of ["permit", "approve"] as const) {
    const r = cedar.checkParsePolicySet({ staticPolicies: bundle[which] });
    if (r.type === "failure") throw new Error(`yenop: ${which} policies do not parse: ${r.errors.map((e) => e.message).join("; ")}`);
  }
}
