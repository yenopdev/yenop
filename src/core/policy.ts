import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { DecisionRequest, PolicyBundle } from "./types.js";
import type { PolicyLayer } from "./config.js";
import type { ShellFacts } from "./shell.js";

/** The policy vocabulary, shipped next to the baseline policies. */
export function loadSchema(baselineDir: string): string {
  return readFileSync(join(baselineDir, "schema.cedarschema"), "utf8");
}

/** Validate a policy set against the vocabulary. Errors are returned as readable strings. */
export function validateAgainstSchema(schema: string, policies: Record<string, string>): { errors: string[]; warnings: string[] } {
  if (Object.keys(policies).length === 0) return { errors: [], warnings: [] };
  const r = cedar.validate({ schema, policies: { staticPolicies: policies }, validationSettings: { mode: "strict" } });
  if (r.type === "failure") return { errors: r.errors.map((e) => e.message), warnings: [] };
  const fmt = (v: cedar.ValidationError) => `${v.policyId}: ${v.error.message}${v.error.help ? ` (${v.error.help})` : ""}`;
  // A policy that can never apply is a mistake (usually a misspelled attribute behind a `has` guard).
  const impossible = r.validationWarnings.filter((w) => /impossible/i.test(w.error.message));
  const rest = r.validationWarnings.filter((w) => !/impossible/i.test(w.error.message));
  return {
    errors: [...r.validationErrors.map(fmt), ...impossible.map((w) => `${fmt(w)} (check the attribute names against the vocabulary)`)],
    warnings: rest.map(fmt),
  };
}

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

/** Structural equality: formatting and comments do not count. */
function samePolicy(a: string, b: string): boolean {
  const ja = cedar.policyToJson(a);
  const jb = cedar.policyToJson(b);
  if (ja.type !== "success" || jb.type !== "success") return a === b;
  return JSON.stringify(ja.json) === JSON.stringify(jb.json);
}

function loadDir(layer: PolicyLayer, bundle: PolicyBundle, which: "permit" | "approve", disabled: Set<string>): number {
  const sub = join(layer.dir, which);
  if (!existsSync(sub)) return 0;
  let count = 0;
  for (const f of readdirSync(sub).filter((n) => n.endsWith(".cedar")).sort()) {
    const path = join(sub, f);
    const policies = splitPolicies(readFileSync(path, "utf8"), `${which}/${f}`);
    for (const [id, text] of Object.entries(policies)) {
      const origin = `${layer.name}:${path}`;
      if (disabled.has(id)) {
        bundle.disabled[id] = origin;
        continue;
      }
      const existing = bundle[which][id];
      if (existing !== undefined) {
        // A copy of a policy already loaded (typically an old init that copied the baseline) is harmless.
        if (samePolicy(existing, text)) continue;
        throw new Error(
          `yenop: policy id "${id}" is defined in ${bundle.origins[id]} and again, differently, in ${origin}. ` +
            `Give the new one its own @id, or switch the first one off with "disabledPolicies": ["${id}"] in config.json.`,
        );
      }
      bundle[which][id] = text;
      bundle.origins[id] = origin;
      count++;
    }
  }
  return count;
}

/**
 * Load every layer, in order. The baseline ships with the package and is always first;
 * customer layers add to it. Ids listed in `disabled` are skipped wherever they appear.
 */
export function loadPolicies(layers: PolicyLayer[], opts: { disabled?: string[]; validate?: boolean } = {}): PolicyBundle {
  const disabled = new Set(opts.disabled ?? []);
  const bundle: PolicyBundle = { permit: {}, approve: {}, origins: {}, disabled: {}, layers: [], warnings: [] };
  for (const layer of layers) {
    const permit = loadDir(layer, bundle, "permit", disabled);
    const approve = loadDir(layer, bundle, "approve", disabled);
    bundle.layers.push({ name: layer.name, dir: layer.dir, permit, approve });
  }
  if (opts.validate !== false) {
    const baseline = layers.find((l) => l.name === "baseline");
    if (baseline) {
      const schema = loadSchema(baseline.dir);
      for (const which of ["permit", "approve"] as const) {
        const { errors, warnings } = validateAgainstSchema(schema, bundle[which]);
        if (errors.length) {
          const where = errors.map((e) => `  ${e}  [${bundle.origins[e.split(":")[0] ?? ""] ?? which}]`).join("\n");
          throw new Error(`yenop: ${which} policies do not match the policy vocabulary (policies/schema.cedarschema):\n${where}`);
        }
        bundle.warnings.push(...warnings);
      }
    }
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
  /** Parsed shell facts when the tool runs a shell command. */
  shell?: ShellFacts;
}

/** Every argument as a string tag on the Call entity, for policies on tools with untyped arguments. */
function argTags(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    out[k] = s.length > 4000 ? s.slice(0, 4000) : s;
  }
  return out;
}

function buildCall(input: EvalInput, policies: Record<string, string>): cedar.AuthorizationCall {
  const { req } = input;
  const principal = { type: "Yenop::Agent", id: `${req.principal.runtime}/${req.principal.agent}` };
  const action = { type: "Yenop::Action", id: "call" };
  const resource = { type: "Yenop::Tool", id: req.tool.name };
  const call = { type: "Yenop::Call", id: req.callId ?? "call" };
  const toolAttrs: Record<string, cedar.CedarValueJson> = {
    name: req.tool.name,
    kind: req.tool.kind,
    readOnly: req.tool.readOnly,
  };
  if (req.tool.server) toolAttrs["server"] = req.tool.server;
  const context: Record<string, cedar.CedarValueJson> = {
    args: toCedarValue(req.args),
    call: { __entity: call },
    run: { steps: input.steps },
    cwd: req.cwd ?? "",
    permissionMode: req.permissionMode ?? "",
    derived: input.derived,
  };
  if (input.shell) context["shell"] = { ...input.shell };
  return {
    principal,
    action,
    resource,
    context,
    policies: { staticPolicies: policies },
    entities: [
      { uid: principal, attrs: { runtime: req.principal.runtime, agent: req.principal.agent, user: req.principal.user }, parents: [] },
      { uid: action, attrs: {}, parents: [] },
      { uid: resource, attrs: toolAttrs, parents: [] },
      { uid: call, attrs: {}, parents: [], tags: argTags(req.args) },
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
