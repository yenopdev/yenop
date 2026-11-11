import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, utimesSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlReceipts, verifyReceipts, RECEIPT_GENESIS, RECEIPTS_LOCK_STALE_MS } from "./receipts.js";
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

  it("two writers on one file, appending turn by turn, leave an unbroken chain (each append re-reads the tail under a lock)", () => {
    // Before the lock, each instance cached the last-line hash at construction; a second instance opened
    // against the same file wrote the same `prev` and the chain read as tampered. Seen live with Gemini CLI,
    // which runs its hooks for parallel tool calls concurrently (2026-10-02).
    const a = new JsonlReceipts(path);
    const b = new JsonlReceipts(path); // both constructed while the file is empty
    for (let i = 0; i < 20; i++) (i % 2 ? b : a).append(receipt(`w${i}`));
    const check = verifyReceipts(path);
    expect(check).toEqual({ ok: true, lines: 20 });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  // The writers are separate Node processes, so they load the built package, not this TypeScript. Without a
  // build the test is reported as skipped (CI always builds first); a build older than the source is a failure
  // with that cause named, never a misleading chain error.
  const built = fileURLToPath(new URL("../../dist/core/receipts.js", import.meta.url));
  it.skipIf(!existsSync(built))("two processes appending at the same time leave an unbroken chain", async () => {
    const source = fileURLToPath(new URL("./receipts.ts", import.meta.url));
    if (statSync(built).mtimeMs < statSync(source).mtimeMs) throw new Error("dist/ is older than src/core/receipts.ts: run `npm run build` first");
    const script = `
      import { JsonlReceipts } from ${JSON.stringify(built)};
      const [path, tag] = process.argv.slice(1); // with -e, extra arguments start at argv[1]
      const sink = new JsonlReceipts(path);
      for (let i = 0; i < 40; i++) sink.append({ v: 1, kind: "decision", id: tag + i, ts: "t", tenant: { id: "t", name: "t" }, runId: "r", runtime: "cli", agent: "a", user: "u", tool: "Bash", toolKind: "shell", args: {}, mode: "enforce", enforced: true, effect: "allow", reasons: [], flow: {}, runBefore: {} });
    `;
    const children = ["p", "q"].map((tag) => spawn(process.execPath, ["--input-type=module", "-e", script, "--", path, tag], { stdio: "inherit" }));
    await Promise.all(children.map((c) => new Promise<void>((res, rej) => c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`writer exited ${code}`)))))));
    expect(verifyReceipts(path)).toEqual({ ok: true, lines: 80 });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("a lock left behind by a dead writer is broken after the stale window, and a live one is waited for", () => {
    const lock = `${path}.lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - RECEIPTS_LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old); // looks abandoned
    const sink = new JsonlReceipts(path);
    sink.append(receipt("after-stale"));
    expect(verifyReceipts(path)).toEqual({ ok: true, lines: 1 });
    expect(existsSync(lock)).toBe(false);
  });
});
