import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt, ReceiptSink } from "./types.js";

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
  append(receipt: Receipt): void {
    appendFileSync(this.path, JSON.stringify(receipt) + "\n", "utf8");
  }
  close(): void {}
}

export function readReceipts(path: string, last = 20): Receipt[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  return lines.slice(-last).map((l) => JSON.parse(l) as Receipt);
}

/** Discards receipts. Only for dry runs that must leave no trace. */
export class NullReceipts implements ReceiptSink {
  append(): void {}
  close(): void {}
}
