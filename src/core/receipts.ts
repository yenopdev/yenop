import { appendFileSync, mkdirSync, existsSync, readFileSync, rmdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
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
  constructor(private path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  /**
   * One receipts file can have several writers at once: hooks deciding in-process while the daemon starts,
   * or a runtime that calls its hooks for parallel tool calls (Gemini CLI does). A cached `prev` would then
   * be stale for all but one of them and the chain would read as tampered although every line is genuine
   * (seen live, 2026-10-02). So every append takes an exclusive lock, re-reads the tail under it, writes, and
   * releases. The lock is a directory beside the file: `mkdir` is atomic on every platform Node supports.
   */
  append(receipt: Receipt | OutcomeReceipt): void {
    withReceiptsLock(this.path, () => {
      const line = JSON.stringify({ ...receipt, prev: lastLineHash(this.path) });
      appendFileSync(this.path, line + "\n", "utf8");
    });
  }
  close(): void {}
}

/** How long a lock may be held before another writer treats it as abandoned (a crashed process). */
export const RECEIPTS_LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 10_000;

/** Run `fn` holding the exclusive append lock for `path`. Waits for a live holder; breaks a stale one. */
export function withReceiptsLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > RECEIPTS_LOCK_STALE_MS) {
          rmdirSync(lock); // a holder that died keeps nobody else out for longer than the stale window
          continue;
        }
      } catch {
        /* the holder released between our check and ours: retry at once */
        continue;
      }
      if (Date.now() > deadline) throw new Error(`receipts lock held for more than ${LOCK_WAIT_MS} ms: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); // 2 ms, synchronous
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already removed as stale by a waiter that outlived our window; nothing to do */
    }
  }
}

/** The chain hash to continue from: SHA-256 of the last line, or the genesis anchor for an empty/new file. */
function lastLineHash(path: string): string {
  if (!existsSync(path)) return RECEIPT_GENESIS;
  const last = lastLine(path);
  return last ? sha256(last) : RECEIPT_GENESIS;
}

/** The last non-empty line of a file, reading only its tail: an append must not re-read a growing file. */
function lastLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8").replace(/\n+$/, "");
      const nl = text.lastIndexOf("\n");
      if (nl >= 0) return text.slice(nl + 1);
      if (start === 0) return text; // the whole file is one line (or empty)
      chunk *= 4;
    }
  } finally {
    closeSync(fd);
  }
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
