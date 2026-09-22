import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openYenop, readAllReceipts, answersFor, type Yenop } from "../../core/index.js";
import { yenopGuardrails, type GuardrailDataLike } from "./index.js";

let home: string;
let project: string;
let y: Yenop;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-oai-"));
  project = join(home, "proj");
  mkdirSync(project, { recursive: true });
  y = openYenop({ home, cwd: project });
});
afterAll(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

const TOOLS = { run_shell: { kind: "shell" as const }, read_file: { kind: "read" as const, readOnly: true }, write_file: { kind: "write" as const }, fetch_url: { kind: "web" as const, readOnly: true } };
let n = 0;
const call = (context: object, name: string, args: unknown, agent = "coder"): GuardrailDataLike => ({ context, agent: { name: agent }, toolCall: { name, arguments: typeof args === "string" ? args : JSON.stringify(args), callId: `call_${++n}` } });

describe("openai-agents guardrails", () => {
  it("allows the boring, denies a secret read, and tells the agent why", async () => {
    const g = yenopGuardrails({ yenop: y, tools: TOOLS });
    const ctx = {};
    const [input] = g.inputGuardrails;
    expect((await input!.run(call(ctx, "run_shell", { command: "npm test" }))).behavior).toEqual({ type: "allow" });
    const denied = await input!.run(call(ctx, "run_shell", { command: "cat .env" }));
    expect(denied.behavior).toMatchObject({ type: "rejectContent", message: expect.stringContaining("no-secret-files") });
    expect((await input!.run(call(ctx, "read_file", { file_path: join(project, ".env") }))).behavior.type).toBe("rejectContent");
    expect(denied.outputInfo).toMatchObject({ effect: "deny" });
    g.close();
  });
  it("binds one SDK run context to one Yenop run, so run-level facts carry across calls", async () => {
    const g = yenopGuardrails({ yenop: y, tools: TOOLS });
    const ctx = {};
    const [input] = g.inputGuardrails;
    // reading an outside page marks the run untrusted; a later outbound call after sensitive data is held
    await input!.run(call(ctx, "fetch_url", { url: "https://example.com/issue/1" }));
    expect(g.runIdFor(ctx)).toMatch(/^openai-agents:/);
    expect(g.runIdFor({})).toBeUndefined();
    const other = {};
    await input!.run(call(other, "run_shell", { command: "npm test" }));
    expect(g.runIdFor(other)).not.toBe(g.runIdFor(ctx));
    g.close();
  });
  it("refuses an ask when nobody can answer it, routes it through onAsk when someone can, and records the answer", async () => {
    const [noAsk] = yenopGuardrails({ yenop: y, tools: TOOLS }).inputGuardrails;
    const refused = await noAsk!.run(call({}, "run_shell", { command: "git push --force origin main" }));
    expect(refused.behavior).toMatchObject({ type: "rejectContent", message: expect.stringContaining("no way to ask a person") });

    const seen: string[] = [];
    const g = yenopGuardrails({ yenop: y, tools: TOOLS, onAsk: async (d, data) => { seen.push(`${data.toolCall.name}:${d.effect}`); return data.toolCall.arguments.includes("staging"); } });
    const [input] = g.inputGuardrails;
    const [output] = g.outputGuardrails;
    const ctx = {};
    const yes = call(ctx, "run_shell", { command: "git push --force origin staging" });
    const approved = await input!.run(yes);
    expect(approved.behavior).toEqual({ type: "allow" });
    expect(approved.outputInfo).toMatchObject({ approvedBy: "person" });
    await output!.run({ ...yes, output: "ok" });
    const no = call(ctx, "run_shell", { command: "git push --force origin main" });
    expect((await input!.run(no)).behavior).toMatchObject({ type: "rejectContent", message: expect.stringContaining("a person declined") });
    expect(seen).toEqual(["run_shell:ask", "run_shell:ask"]);

    const answers = answersFor(readAllReceipts(y.config.receiptsPath));
    const lines = readFileSync(y.config.receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; id: string; callId?: string; effect?: string; runtime?: string });
    const ran = lines.find((l) => l.kind === "decision" && l.callId === yes.toolCall.callId)!;
    const declined = lines.find((l) => l.kind === "decision" && l.callId === no.toolCall.callId)!;
    expect(ran.runtime).toBe("openai-agents");
    expect(answers.get(ran.id)).toBe("approved, ran");
    expect(answers.get(declined.id)).toBe("refused by the permission system");
    g.close();
  });
  it("judges a tool it was not told about as unknown, so the baseline holds it for a person", async () => {
    const [input] = yenopGuardrails({ yenop: y }).inputGuardrails;
    const r = await input!.run(call({}, "launch_rockets", { target: "moon" }));
    expect(r.behavior.type).toBe("rejectContent");
    expect(r.outputInfo).toMatchObject({ effect: "ask" });
  });
  it("fails closed on arguments that are not JSON, an approval handler that throws, and honours onDeny: throw", async () => {
    const [input] = yenopGuardrails({ yenop: y, tools: TOOLS, onAsk: () => { throw new Error("slack is down"); } }).inputGuardrails;
    expect((await input!.run(call({}, "run_shell", "{not json"))).behavior).toMatchObject({ type: "rejectContent", message: expect.stringContaining("not a JSON object") });
    expect((await input!.run(call({}, "run_shell", { command: "rm -rf build" }))).behavior).toMatchObject({ type: "rejectContent", message: expect.stringContaining("slack is down") });
    const [thrower] = yenopGuardrails({ yenop: y, tools: TOOLS, onDeny: "throw" }).inputGuardrails;
    expect((await thrower!.run(call({}, "run_shell", { command: "cat .env" }))).behavior).toEqual({ type: "throwException" });
  });
  it("mapArgs reshapes a developer's argument names into what the engine reads", async () => {
    const [input] = yenopGuardrails({ yenop: y, tools: { sh: { kind: "shell" } }, mapArgs: (name, a) => (name === "sh" ? { command: a["cmd"] } : a) }).inputGuardrails;
    expect((await input!.run(call({}, "sh", { cmd: "cat .env" }))).behavior.type).toBe("rejectContent");
    expect((await input!.run(call({}, "sh", { cmd: "ls" }))).behavior).toEqual({ type: "allow" });
  });
  it("without an explicit cwd, judges under the current directory's project, not the machine default", async () => {
    // seen live: the example agent's decisions were filed under tenant "local" instead of the playground's
    const h = mkdtempSync(join(tmpdir(), "yenop-oai-cwd-"));
    const proj = join(h, "p");
    mkdirSync(join(proj, ".yenop"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "config.json"), JSON.stringify({ tenant: { id: "tn_0123456789abcdefghijklmnop", name: "proj" } }));
    const prev = process.cwd();
    process.chdir(proj);
    try {
      const g = yenopGuardrails({ home: h, tools: TOOLS });
      await g.inputGuardrails[0]!.run(call({}, "run_shell", { command: "npm test" }));
      g.close();
    } finally {
      process.chdir(prev);
    }
    const last = JSON.parse(readFileSync(join(h, "receipts.jsonl"), "utf8").trim().split("\n").pop()!) as { tenant: { name: string } };
    expect(last.tenant.name).toBe("proj");
    rmSync(h, { recursive: true, force: true });
  });
  it("in observe mode records and never blocks", async () => {
    const obsHome = mkdtempSync(join(tmpdir(), "yenop-oai-obs-"));
    const proj = join(obsHome, "p");
    mkdirSync(join(proj, ".yenop"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "config.json"), JSON.stringify({ mode: "observe" }));
    const g = yenopGuardrails({ home: obsHome, cwd: proj, tools: TOOLS });
    const r = await g.inputGuardrails[0]!.run(call({}, "run_shell", { command: "cat .env" }));
    expect(r.behavior).toEqual({ type: "allow" });
    expect(r.outputInfo).toMatchObject({ effect: "deny", mode: "observe" });
    g.close();
    rmSync(obsHome, { recursive: true, force: true });
  });
});
