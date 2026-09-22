/**
 * `yenop report`: what your agents did, in aggregate, from the receipts on this machine.
 *
 * Two audiences. A developer reads it after a week in observe mode to see what would have been stopped, and
 * whether the asks were the right asks. And, with the person's explicit consent, the same numbers with every
 * piece of content removed are what Yenop's telemetry sends. The report is built once; telemetry is the
 * report minus everything that could identify a project, a file, a command, or a person.
 *
 * The number that matters most is the ASK calibration: of the calls Yenop held for a person, how many did the
 * person then allow? Near 100 % means the baseline asks too often (fatigue); near 0 % means the asks were
 * real. That ratio, per rule, is how the baseline gets tuned by evidence instead of opinion.
 */
import type { YenopConfig } from "./config.js";
import { readAllReceipts, answersFor, isOutcome, type Answer } from "./receipts.js";
import type { Receipt } from "./types.js";

export interface Report {
  /** ISO timestamps bounding the period, and the number of days requested. */
  from: string;
  to: string;
  days: number;
  /** Which tenant's receipts, or "all". Never sent in telemetry. */
  scope: string;
  runs: number;
  actions: number;
  allow: number;
  ask: number;
  deny: number;
  /** What became of the asks. */
  askOutcomes: Record<Answer, number>;
  /** Of asks that got an answer, the share the person allowed. undefined when no ask was answered. */
  askApprovalRate?: number;
  /** Approval rule id -> {asked, allowed, refused}; the calibration table. */
  askByRule: Record<string, { asked: number; allowed: number; refused: number }>;
  /** Deny rule id -> count. */
  denyByRule: Record<string, number>;
  /** Runtime -> action count (claude-code, cursor, codex, mcp, ...). */
  byRuntime: Record<string, number>;
  /** Tool kind -> action count (shell, write, read, mcp, web, unknown). */
  byToolKind: Record<string, number>;
  /** Observe-mode share of actions: how much of this was recorded without being enforced. */
  observedOnly: number;
}

const APPROVE = "approve:";

export function buildReport(config: YenopConfig, opts: { days?: number; all?: boolean } = {}): Report {
  const days = Math.max(1, Math.floor(opts.days ?? 7));
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  const everything = readAllReceipts(config.receiptsPath);
  const answers = answersFor(everything);
  const mine = config.tenant;
  let rows = everything.filter((r): r is Receipt => !isOutcome(r));
  if (!opts.all) rows = rows.filter((r) => (typeof r.tenant === "string" ? r.tenant === mine.name : r.tenant.id === mine.id));
  rows = rows.filter((r) => r.ts >= from.toISOString() && r.ts <= to.toISOString());

  const report: Report = {
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    scope: opts.all ? "all" : mine.name,
    runs: new Set(rows.map((r) => r.runId)).size,
    actions: rows.length,
    allow: 0,
    ask: 0,
    deny: 0,
    askOutcomes: { "approved, ran": 0, "approved, failed": 0, "refused by the permission system": 0, "not run: rejected or abandoned": 0, "awaiting an answer": 0 },
    askByRule: {},
    denyByRule: {},
    byRuntime: {},
    byToolKind: {},
    observedOnly: 0,
  };

  let answered = 0;
  let allowedByPerson = 0;
  for (const r of rows) {
    report[r.effect]++;
    report.byRuntime[r.runtime] = (report.byRuntime[r.runtime] ?? 0) + 1;
    report.byToolKind[r.toolKind] = (report.byToolKind[r.toolKind] ?? 0) + 1;
    if (r.mode === "observe" || !r.enforced) report.observedOnly++;
    if (r.effect === "ask") {
      const a = answers.get(r.id);
      if (a) report.askOutcomes[a]++;
      const allowed = a === "approved, ran" || a === "approved, failed";
      const refused = a === "refused by the permission system" || a === "not run: rejected or abandoned";
      if (allowed || refused) {
        answered++;
        if (allowed) allowedByPerson++;
      }
      for (const reason of r.reasons.filter((x) => x.startsWith(APPROVE))) {
        const id = reason.slice(APPROVE.length);
        const cell = (report.askByRule[id] ??= { asked: 0, allowed: 0, refused: 0 });
        cell.asked++;
        if (allowed) cell.allowed++;
        if (refused) cell.refused++;
      }
    }
    if (r.effect === "deny") {
      for (const reason of r.reasons.filter((x) => !x.startsWith(APPROVE))) report.denyByRule[reason] = (report.denyByRule[reason] ?? 0) + 1;
    }
  }
  if (answered > 0) report.askApprovalRate = allowedByPerson / answered;
  return report;
}

function pct(n: number, of: number): string {
  return of === 0 ? "–" : `${((100 * n) / of).toFixed(1)}%`;
}
function top(o: Record<string, number>, n = 6): [string, number][] {
  return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** The report as a person reads it. */
export function renderReport(r: Report): string {
  const L: string[] = [];
  L.push(`Yenop report — last ${r.days} day${r.days === 1 ? "" : "s"}${r.scope === "all" ? ", every project" : ` for "${r.scope}"`}`);
  L.push("");
  if (r.actions === 0) {
    L.push("No actions recorded in this period. Run an agent with Yenop installed, or try: yenop demo");
    return L.join("\n");
  }
  L.push(`Runs      ${String(r.runs).padStart(7)}`);
  L.push(`Actions   ${String(r.actions).padStart(7)}${r.observedOnly ? `   (${r.observedOnly} recorded in observe mode, not enforced)` : ""}`);
  L.push("");
  L.push(`ALLOW     ${String(r.allow).padStart(7)}   ${pct(r.allow, r.actions).padStart(6)}`);
  L.push(`ASK       ${String(r.ask).padStart(7)}   ${pct(r.ask, r.actions).padStart(6)}`);
  L.push(`DENY      ${String(r.deny).padStart(7)}   ${pct(r.deny, r.actions).padStart(6)}`);
  if (r.ask > 0) {
    L.push("");
    L.push("What became of the asks");
    for (const [k, v] of Object.entries(r.askOutcomes)) if (v) L.push(`  ${k.padEnd(34)} ${String(v).padStart(5)}`);
    if (r.askApprovalRate !== undefined) {
      const p = r.askApprovalRate;
      const verdict = p >= 0.9 ? "most asks were approved: the baseline may be asking too often" : p <= 0.3 ? "most asks were refused: these were real catches" : "a mix: some rules earn their asks, some may not";
      L.push(`  approval rate ${pct(Math.round(p * 1000), 1000).padStart(6)}   ${verdict}`);
    }
    const rules = Object.entries(r.askByRule).sort((a, b) => b[1].asked - a[1].asked).slice(0, 8);
    if (rules.length) {
      L.push("");
      L.push("Asks by rule                              asked  allowed  refused");
      for (const [id, c] of rules) L.push(`  ${id.padEnd(40)} ${String(c.asked).padStart(5)}  ${String(c.allowed).padStart(7)}  ${String(c.refused).padStart(7)}`);
    }
  }
  if (r.deny > 0) {
    L.push("");
    L.push("Denies by rule");
    for (const [id, n] of top(r.denyByRule)) L.push(`  ${id.padEnd(40)} ${String(n).padStart(5)}`);
  }
  L.push("");
  L.push("By runtime");
  for (const [k, n] of top(r.byRuntime)) L.push(`  ${k.padEnd(14)} ${String(n).padStart(7)}   ${pct(n, r.actions).padStart(6)}`);
  L.push("");
  L.push("By kind of action");
  for (const [k, n] of top(r.byToolKind)) L.push(`  ${k.padEnd(14)} ${String(n).padStart(7)}   ${pct(n, r.actions).padStart(6)}`);
  return L.join("\n");
}
