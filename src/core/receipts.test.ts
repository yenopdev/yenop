import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlReceipts, verifyReceipts, RECEIPT_GENESIS } from "./receipts.js";
import type { Receipt } from "./types.js";

let dir: string;
let path: string;
const receipt = (id: string, effect: Receipt["effect"] = "allow"): Receipt => ({
  v: 1, kind: "decision", id, ts: new Date().toISOString(), tenant: { id: "t", name: "t" }, runId: "r", runtime: "cli", agent: "a", user: "u",
  tool: "Bash", toolKind: "shell", args: { command: "x" }, mode: "enforce", enforced: true, effect, reasons: ["shell"], flow: {} as never, runBefore: {} as never,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yenop-chain-"));
  path = join(dir, "receipts.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hash-chained receipts", () => {
  it("an untouched file verifies, with each line anchored to the one before it", () => {
    const r = new JsonlReceipts(path);
    for (let i = 0; i < 5; i++) r.append(receipt(`id${i}`));
    r.close();
    const c = verifyReceipts(path);
    expect(c).toEqual({ ok: true, lines: 5 });
    const first = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as { prev: string };
    expect(first.prev).toBe(RECEIPT_GENESIS);
  });
  it("continues the chain across a reopen, so restarts do not break it", () => {
    new JsonlReceipts(path);
    const a = new JsonlReceipts(path);
    a.append(receipt("a"));
    a.append(receipt("b"));
    a.close();
    const b = new JsonlReceipts(path); // reopened: reads the last hash
    b.append(receipt("c"));
    b.close();
    expect(verifyReceipts(path).ok).toBe(true);
  });
  it("detects an edited line", () => {
    const r = new JsonlReceipts(path);
    r.append(receipt("a", "allow"));
    r.append(receipt("b", "deny"));
    r.append(receipt("c", "allow"));
    r.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const edited = JSON.parse(lines[1]!) as Receipt;
    edited.effect = "allow"; // flip a deny to an allow
    lines[1] = JSON.stringify(edited);
    writeFileSync(path, lines.join("\n") + "\n");
    const c = verifyReceipts(path);
    expect(c.ok).toBe(false);
    expect(c.brokenAt).toBe(3); // the line after the edit is where the mismatch shows
  });
  it("detects a deleted line", () => {
    const r = new JsonlReceipts(path);
    for (const id of ["a", "b", "c"]) r.append(receipt(id));
    r.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    lines.splice(1, 1); // remove the middle line
    writeFileSync(path, lines.join("\n") + "\n");
    expect(verifyReceipts(path).ok).toBe(false);
  });
  it("detects reordered lines", () => {
    const r = new JsonlReceipts(path);
    for (const id of ["a", "b", "c"]) r.append(receipt(id));
    r.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    [lines[0], lines[1]] = [lines[1]!, lines[0]!];
    writeFileSync(path, lines.join("\n") + "\n");
    expect(verifyReceipts(path).ok).toBe(false);
  });
  it("detects a line appended by hand without the chain", () => {
    const r = new JsonlReceipts(path);
    r.append(receipt("a"));
    r.close();
    appendFileSync(path, JSON.stringify(receipt("forged")) + "\n"); // no prev, or wrong prev
    expect(verifyReceipts(path).ok).toBe(false);
  });
  it("an empty or missing file is trivially intact", () => {
    expect(verifyReceipts(join(dir, "nope.jsonl"))).toEqual({ ok: true, lines: 0 });
  });
});
