import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openYenop, type Yenop } from "../../core/index.js";
import { gateClientMessage, mcpToolRef, pumpGateway, makeLineSplitter, type GatewayContext } from "./gateway.js";
import { parseMcpArgs } from "./run.js";

let home: string;
let y: Yenop;
const ctx = (over: Partial<GatewayContext> = {}): GatewayContext => ({ yenop: y, runId: "r", server: "supabase", user: "u", client: "cursor", onAsk: "block", ...over });
const call = (id: number, name: string, args: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-mcp-"));
  y = openYenop({ home });
});
afterEach(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

describe("mcp tool classification", () => {
  it("treats read-shaped names as read-only, others not, and keeps the plain tool name", () => {
    expect(mcpToolRef("github", "list_issues")).toMatchObject({ name: "list_issues", kind: "mcp", server: "github", readOnly: true });
    expect(mcpToolRef("github", "create_issue")).toMatchObject({ name: "create_issue", kind: "mcp", server: "github", readOnly: false });
    expect(mcpToolRef("supabase", "execute_sql")).toMatchObject({ readOnly: false });
  });
});

describe("gating tools/call", () => {
  it("forwards a read call", () => {
    expect(gateClientMessage(ctx(), call(1, "list_tables"))).toEqual({ action: "forward" });
  });
  it("blocks a write call and answers the client with a tool error, never the server", () => {
    const r = gateClientMessage(ctx(), call(2, "execute_sql", { query: "DROP TABLE customers" }));
    expect(r.action).toBe("respond");
    if (r.action !== "respond") return;
    const m = r.message as { id: number; result: { isError: boolean; content: { text: string }[] } };
    expect(m.id).toBe(2);
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0]!.text).toMatch(/Yenop needs a person.*execute_sql/);
    expect(m.result.content[0]!.text).toMatch(/receipt /);
  });
  it("passes non-tools/call messages through untouched", () => {
    expect(gateClientMessage(ctx(), JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }))).toEqual({ action: "forward" });
    expect(gateClientMessage(ctx(), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toEqual({ action: "forward" });
    expect(gateClientMessage(ctx(), "not json at all")).toEqual({ action: "forward" });
  });
  it("blocks a sequence: a trusted read then a write on a server marked sensitive still gets stopped", () => {
    const h2 = mkdtempSync(join(tmpdir(), "yenop-mcp2-"));
    mkdirSync(join(h2, "policies"), { recursive: true });
    writeFileSync(join(h2, "config.json"), JSON.stringify({ sensitiveServers: ["supabase"] }));
    const y2 = openYenop({ home: h2 });
    try {
      const c = ctx({ yenop: y2 });
      // a read from a sensitive server marks the run sensitive; a write to github then trips the sequence rule
      gateClientMessage(c, call(1, "list_rows"));
      const r = gateClientMessage({ ...c, server: "github" }, call(2, "get_file", { path: "README" }));
      // supabase is a sensitive server, so the read marks the run sensitive; reaching an untrusted github
      // server afterward trips the sequence rule and is asked. Cross-server exfil path, caught.
      expect(r.action).toBe("respond");
    } finally {
      y2.close();
      rmSync(h2, { recursive: true, force: true });
    }
  });
  it("records a receipt for every gated call", () => {
    gateClientMessage(ctx(), call(1, "execute_sql", { query: "DELETE FROM x" }));
    const last = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last)).toMatchObject({ tool: "execute_sql", toolKind: "mcp", effect: "ask" });
  });
  it("honors on-ask=allow for teams that want MCP writes through", () => {
    expect(gateClientMessage(ctx({ onAsk: "allow" }), call(1, "execute_sql", { query: "UPDATE x SET y=1" }))).toEqual({ action: "forward" });
  });
});

describe("line splitter and pump", () => {
  it("reassembles messages split across chunks and ignores blank lines", () => {
    const lines: string[] = [];
    const feed = makeLineSplitter((l) => lines.push(l));
    feed('{"a":1}\n{"b":2}');   // "b" has no trailing newline yet
    feed('{"more":3}\n\n');     // so it joins the next chunk into one line; the blank line is ignored
    expect(lines).toEqual(['{"a":1}', '{"b":2}{"more":3}']);
  });
  it("forwards allowed calls to the server and answers blocked ones to the client", async () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const serverIn = new PassThrough();
    const serverOut = new PassThrough();
    const seenByServer: string[] = [];
    serverIn.on("data", (c: Buffer) => seenByServer.push(c.toString().trim()));
    const toClient: string[] = [];
    clientOut.on("data", (c: Buffer) => toClient.push(c.toString().trim()));
    pumpGateway(ctx(), { clientIn, clientOut, serverIn, serverOut });
    clientIn.write(call(1, "list_tables") + "\n");
    clientIn.write(call(2, "execute_sql", { query: "DROP TABLE x" }) + "\n");
    serverOut.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(seenByServer).toHaveLength(1); // only the allowed call reached the server
    expect(JSON.parse(seenByServer[0]!).id).toBe(1);
    expect(toClient.some((l) => JSON.parse(l).result?.isError)).toBe(true); // the block was answered to the client
    expect(toClient.some((l) => JSON.parse(l).id === 1 && !JSON.parse(l).result?.isError)).toBe(true); // server's real reply passed back
  });
});

describe("parseMcpArgs", () => {
  it("splits options from the upstream command and defaults the server name", () => {
    expect(parseMcpArgs(["--server", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"])).toMatchObject({ server: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(parseMcpArgs(["--", "node", "server.js"])).toMatchObject({ server: "node", command: "node", args: ["server.js"] });
    expect(parseMcpArgs(["--on-ask", "allow", "--", "./srv"])).toMatchObject({ onAsk: "allow", command: "./srv" });
    expect(() => parseMcpArgs(["--server", "x", "--"])).toThrow(/nothing to launch/);
  });
});
