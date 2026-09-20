import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
/** The chain's anchor: the "hash before the first line". A fixed, public constant. */
export const RECEIPT_GENESIS = "yenop-receipts-v1";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Appends receipts as a hash chain: each line carries `prev`, the SHA-256 of the previous line's exact bytes.
 * Editing, deleting or reordering any line makes the next line's `prev` wrong, so tampering is detectable with
 * `verifyReceipts`. The hash is over the literal line, so there is no canonical-form step to get wrong. This is
 * local tamper-evidence, not a signature: it catches changes to the recorded history, and truncation of the
 * tail is caught by anchoring the head elsewhere (the control plane, later). Documented as such.
 */
export class JsonlReceipts implements ReceiptSink {
  private prevHash: string;
  constructor(private path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.prevHash = lastLineHash(path);
  }
  append(receipt: Receipt | OutcomeReceipt): void {
    const line = JSON.stringify({ ...receipt, prev: this.prevHash });
    appendFileSync(this.path, line + "\n", "utf8");
    this.prevHash = sha256(line);
  }
  close(): void {}
}

/** The chain hash to continue from: SHA-256 of the last line, or the genesis anchor for an empty/new file. */
function lastLineHash(path: string): string {
  if (!existsSync(path)) return RECEIPT_GENESIS;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  return last ? sha256(last) : RECEIPT_GENESIS;
}

export interface ChainCheck {
  ok: boolean;
  lines: number;
  /** 1-based line number where the chain first breaks, if any. */
  brokenAt?: number;
  reason?: string;
}

/** Walk the receipts file and confirm every line's `prev` matches the hash of the line before it. */
export function verifyReceipts(path: string): ChainCheck {
  if (!existsSync(path)) return { ok: true, lines: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  let expected = RECEIPT_GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    let parsed: { prev?: string };
    try {
      parsed = JSON.parse(text) as { prev?: string };
    } catch {
      return { ok: false, lines: lines.length, brokenAt: i + 1, reason: "line is not valid JSON" };
    }
    const prev = parsed.prev ?? RECEIPT_GENESIS; // older unchained lines read as genesis-anchored
    if (prev !== expected) {
      return { ok: false, lines: lines.length, brokenAt: i + 1, reason: `prev hash does not match the line before it (a line was edited, removed, or reordered)` };
    }
    expected = sha256(text);
  }
  return { ok: true, lines: lines.length };
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
