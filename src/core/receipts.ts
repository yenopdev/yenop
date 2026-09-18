import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OutcomeReceipt, Receipt, ReceiptSink } from "./types.js";

/** One short line describing a call: the command, path, URL or query. */
export function summarizeCall(args: unknown, max = 80): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const key = ["command", "file_path", "path", "notebook_path", "url", "query", "pattern"].find((k) => typeof a[k] === "string");
  const v = (key ? String(a[key]) : JSON.stringify(a)).replace(/\s+/g, " ").trim();
  return v.length > max ? v.slice(0, max - 3) + "..." : v;
}

const MAX_STRING = 4000;

/** Trim long strings so a receipt never balloons; structure is preserved. */
export function trimForReceipt(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested]";
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + `…[${v.length - MAX_STRING} more]` : v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimForReceipt(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = trimForReceipt(x, depth + 1);
    return out;
  }
  return v;
}

/** Append-only JSON Lines file. One line per decision, written synchronously so a crash never loses it. */
export class JsonlReceipts implements ReceiptSink {
  constructor(private path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  append(receipt: Receipt | OutcomeReceipt): void {
    appendFileSync(this.path, JSON.stringify(receipt) + "\n", "utf8");
  }
  close(): void {}
}

/** Every line of the receipts file: decisions and outcomes, oldest first. */
export function readAllReceipts(path: string): (Receipt | OutcomeReceipt)[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Receipt | OutcomeReceipt);
}

export function isOutcome(r: Receipt | OutcomeReceipt): r is OutcomeReceipt {
  return (r as OutcomeReceipt).kind === "outcome";
}

/** Decisions only, the last `last` of them. */
export function readReceipts(path: string, last = 20): Receipt[] {
  return (readAllReceipts(path).filter((r) => !isOutcome(r)) as Receipt[]).slice(-last);
}

export type Answer = "approved, ran" | "approved, failed" | "refused by the permission system" | "not run: rejected or abandoned" | "awaiting an answer";

/**
 * What became of each ask. The runtime reports when a call ran or was refused by its own permission system;
 * a person clicking Deny produces no event, so an ask that is followed by later steps with no run recorded was rejected or abandoned.
 */
export function answersFor(all: (Receipt | OutcomeReceipt)[]): Map<string, Answer> {
  const outcomes = new Map<string, OutcomeReceipt>();
  for (const r of all) if (isOutcome(r)) outcomes.set(r.decisionId, r);
  const decisions = all.filter((r) => !isOutcome(r)) as Receipt[];
  const lastStep = new Map<string, number>();
  for (const d of decisions) lastStep.set(d.runId, Math.max(lastStep.get(d.runId) ?? 0, d.steps));
  const out = new Map<string, Answer>();
  for (const d of decisions) {
    if (d.effect !== "ask" || d.mode === "observe") continue;
    const o = outcomes.get(d.id);
    if (o) out.set(d.id, o.outcome === "ran" ? "approved, ran" : o.outcome === "failed" ? "approved, failed" : "refused by the permission system");
    else out.set(d.id, (lastStep.get(d.runId) ?? 0) > d.steps ? "not run: rejected or abandoned" : "awaiting an answer");
  }
  return out;
}

/** Discards receipts. Only for dry runs that must leave no trace. */
export class NullReceipts implements ReceiptSink {
  append(): void {}
  close(): void {}
}
