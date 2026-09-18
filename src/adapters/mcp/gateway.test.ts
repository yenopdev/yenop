import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openYenop, type Yenop } from "../../core/index.js";
import { gateClientMessage, gateServerMessage, mcpToolRef, pumpGateway, makeLineSplitter, newGatewayState, type GatewayContext, type Effect } from "./gateway.js";
import { parseMcpArgs } from "./run.js";

let home: string;
let y: Yenop;
const ctx = (over: Partial<GatewayContext> = {}): GatewayContext => ({ yenop: y, runId: "r", server: "supabase", user: "u", client: "cursor", onAsk: "block", state: newGatewayState(), ...over });
const call = (id: number, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...extra } });
const init = (caps: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: caps, clientInfo: { name: "t", version: "0" } } });
const parse = (e: Effect) => JSON.parse(e.line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
const receipts = () => readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const MRTR_CAPS = { _meta: { "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } } };

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
  it("classifies the official filesystem server's tools correctly, including recursive listings", () => {
    for (const t of ["read_text_file", "list_directory", "directory_tree", "search_files", "get_file_info"]) expect(mcpToolRef("fs", t).readOnly, t).toBe(true);
    for (const t of ["write_file", "edit_file", "create_directory", "move_file"]) expect(mcpToolRef("fs", t).readOnly, t).toBe(false);
  });
});

describe("gating tools/call without an approver", () => {
  it("forwards a read call", () => {
    expect(gateClientMessage(ctx(), call(1, "list_tables"))).toEqual([{ to: "server", line: call(1, "list_tables") }]);
  });
  it("blocks a write call and answers the client with a tool error, never the server", () => {
    const [e] = gateClientMessage(ctx(), call(2, "execute_sql", { query: "DROP TABLE customers" }));
    expect(e!.to).toBe("client");
    const m = parse(e!) as { id: number; result: { isError: boolean; content: { text: string }[] } };
    expect(m.id).toBe(2);
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0]!.text).toMatch(/needs a person.*cannot ask one/);
    expect(m.result.content[0]!.text).toMatch(/receipt /);
  });
  it("passes non-tools/call messages through untouched", () => {
    for (const l of [JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "not json at all"]) {
      expect(gateClientMessage(ctx(), l)).toEqual([{ to: "server", line: l }]);
    }
  });
  it("catches a cross-server sequence: a read from a sensitive server, then reaching an untrusted one", () => {
    const h2 = mkdtempSync(join(tmpdir(), "yenop-mcp2-"));
    mkdirSync(join(h2, "policies"), { recursive: true });
    writeFileSync(join(h2, "config.json"), JSON.stringify({ sensitiveServers: ["supabase"] }));
    const y2 = openYenop({ home: h2 });
    try {
      const c = ctx({ yenop: y2 });
      gateClientMessage(c, call(1, "list_rows"));
      const [e] = gateClientMessage({ ...c, server: "github" }, call(2, "get_file", { path: "README" }));
      expect(e!.to).toBe("client");
    } finally {
      y2.close();
      rmSync(h2, { recursive: true, force: true });
    }
  });
  it("records the decision and a definite denied outcome when it refuses", () => {
    gateClientMessage(ctx(), call(7, "write_file", { path: "/x" }));
    expect(receipts().find((l) => l.kind === "decision")).toMatchObject({ tool: "write_file", toolKind: "mcp", effect: "ask" });
    expect(receipts().find((l) => l.kind === "outcome")).toMatchObject({ outcome: "denied", tool: "write_file", callId: "mcp:7" });
  });
  it("on-ask=allow forwards the ask and records ran/failed from the server's reply", () => {
    const c = ctx({ onAsk: "allow" });
    expect(gateClientMessage(c, call(1, "execute_sql", { query: "UPDATE x SET y=1" }))[0]!.to).toBe("server");
    gateServerMessage(c, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }));
    expect(receipts().find((l) => l.kind === "outcome")).toMatchObject({ outcome: "ran", callId: "mcp:1" });
    expect(gateClientMessage(c, call(2, "execute_sql", { query: "UPDATE x SET y=2" }))[0]!.to).toBe("server");
    gateServerMessage(c, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [] } }));
    expect(receipts().filter((l) => l.kind === "outcome").pop()).toMatchObject({ outcome: "failed", callId: "mcp:2" });
  });
});

describe("elicitation, 2025 flow (server-initiated request)", () => {
  it("asks the person through the client, holds the call, and forwards it on allow", () => {
    const c = ctx({ onAsk: "elicit" });
    expect(gateClientMessage(c, init({ elicitation: {} }))[0]!.to).toBe("server");
    const effects = gateClientMessage(c, call(5, "execute_sql", { query: "DELETE FROM x" }));
    expect(effects).toHaveLength(1);
    expect(effects[0]!.to).toBe("client"); // the question, not the call
    const q = parse(effects[0]!);
    expect(q.method).toBe("elicitation/create");
    expect(String(q.id)).toMatch(/^yenop:/);
    expect((q.params as { message: string }).message).toMatch(/Allow supabase\/execute_sql/);
    expect((q.params as { requestedSchema: { properties: { decision: { enum: string[] } } } }).requestedSchema.properties.decision.enum).toEqual(["allow", "deny"]);
    // the person says allow
    const after = gateClientMessage(c, JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { action: "accept", content: { decision: "allow" } } }));
    expect(after).toEqual([{ to: "server", line: call(5, "execute_sql", { query: "DELETE FROM x" }) }]);
    gateServerMessage(c, JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [] } }));
    expect(receipts().find((l) => l.kind === "outcome")).toMatchObject({ outcome: "ran", callId: "mcp:5" });
  });
  it("a decline, a cancel, or an explicit deny all refuse the held call and never touch the server", () => {
    for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { decision: "deny" } }]) {
      const c = ctx({ onAsk: "elicit" });
      gateClientMessage(c, init({ elicitation: {} }));
      const [q] = gateClientMessage(c, call(9, "execute_sql", { query: "x" }));
      const after = gateClientMessage(c, JSON.stringify({ jsonrpc: "2.0", id: parse(q!).id, result: answer }));
      expect(after).toHaveLength(1);
      expect(after[0]!.to).toBe("client");
      expect(parse(after[0]!)).toMatchObject({ id: 9, result: { isError: true } });
      expect(c.state.held.size).toBe(0);
    }
  });
  it("falls back to blocking when the client did not declare elicitation", () => {
    const c = ctx({ onAsk: "elicit" });
    gateClientMessage(c, init({}));
    const [e] = gateClientMessage(c, call(3, "execute_sql", { query: "x" }));
    expect(parse(e!)).toMatchObject({ id: 3, result: { isError: true } });
  });
  it("drops a held call the client cancels", () => {
    const c = ctx({ onAsk: "elicit" });
    gateClientMessage(c, init({ elicitation: {} }));
    gateClientMessage(c, call(4, "execute_sql", { query: "x" }));
    expect(c.state.held.size).toBe(1);
    gateClientMessage(c, JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } }));
    expect(c.state.held.size).toBe(0);
  });
  it("leaves the real server's own elicitations alone", () => {
    const c = ctx({ onAsk: "elicit" });
    const serverAsk = JSON.stringify({ jsonrpc: "2.0", id: 77, method: "elicitation/create", params: { message: "your name?" } });
    expect(gateServerMessage(c, serverAsk)).toEqual([{ to: "client", line: serverAsk }]);
    const reply = JSON.stringify({ jsonrpc: "2.0", id: 77, result: { action: "accept", content: { name: "x" } } });
    expect(gateClientMessage(c, reply)).toEqual([{ to: "server", line: reply }]);
  });
});

describe("elicitation, 2026 flow (multi round-trip)", () => {
  it("answers input_required with a nonce, then forwards the retry on allow with the extra fields stripped", () => {
    const c = ctx({ onAsk: "elicit" });
    const [e] = gateClientMessage(c, call(11, "execute_sql", { query: "DELETE FROM x" }, MRTR_CAPS));
    expect(e!.to).toBe("client");
    const r = parse(e!) as { id: number; result: { resultType: string; inputRequests: Record<string, { method: string; params: { message: string } }>; requestState: string } };
    expect(r.id).toBe(11);
    expect(r.result.resultType).toBe("input_required");
    expect(r.result.inputRequests["yenop-approval"]!.method).toBe("elicitation/create");
    expect(r.result.requestState).toMatch(/^[0-9a-f]{32}$/);
    const retry = call(12, "execute_sql", { query: "DELETE FROM x" }, { ...MRTR_CAPS, requestState: r.result.requestState, inputResponses: { "yenop-approval": { action: "accept", content: { decision: "allow" } } } });
    const [f] = gateClientMessage(c, retry);
    expect(f!.to).toBe("server");
    const sent = parse(f!);
    expect(sent.params).not.toHaveProperty("requestState");
    expect(sent.params).not.toHaveProperty("inputResponses");
    expect(sent.params).toMatchObject({ name: "execute_sql", arguments: { query: "DELETE FROM x" } });
    // only one decision receipt for the two messages, and the outcome lands on it
    expect(receipts().filter((l) => l.kind === "decision")).toHaveLength(1);
    gateServerMessage(c, JSON.stringify({ jsonrpc: "2.0", id: 12, result: { content: [] } }));
    expect(receipts().find((l) => l.kind === "outcome")).toMatchObject({ outcome: "ran", callId: "mcp:11" });
  });
  it("refuses a retry whose arguments changed, and a nonce is single use", () => {
    const c = ctx({ onAsk: "elicit" });
    const [e] = gateClientMessage(c, call(1, "execute_sql", { query: "SELECT 1" }, MRTR_CAPS));
    const rs = (parse(e!).result as { requestState: string }).requestState;
    const ok = { "yenop-approval": { action: "accept", content: { decision: "allow" } } };
    const [f] = gateClientMessage(c, call(2, "execute_sql", { query: "DROP TABLE x" }, { ...MRTR_CAPS, requestState: rs, inputResponses: ok }));
    expect(parse(f!)).toMatchObject({ id: 2, result: { isError: true } });
    // the nonce is gone: a second retry is treated as a fresh call and asked again
    const [g] = gateClientMessage(c, call(3, "execute_sql", { query: "SELECT 1" }, { ...MRTR_CAPS, requestState: rs, inputResponses: ok }));
    expect((parse(g!).result as { resultType?: string }).resultType).toBe("input_required");
  });
  it("a decline on the retry refuses the call", () => {
    const c = ctx({ onAsk: "elicit" });
    const [e] = gateClientMessage(c, call(1, "execute_sql", { query: "x" }, MRTR_CAPS));
    const rs = (parse(e!).result as { requestState: string }).requestState;
    const [f] = gateClientMessage(c, call(2, "execute_sql", { query: "x" }, { ...MRTR_CAPS, requestState: rs, inputResponses: { "yenop-approval": { action: "decline" } } }));
    expect(parse(f!)).toMatchObject({ id: 2, result: { isError: true } });
    expect(receipts().find((l) => l.kind === "outcome")).toMatchObject({ outcome: "denied", callId: "mcp:1" });
  });
  it("a requestState the gateway did not issue belongs to the real server and passes through on an allowed call", () => {
    const c = ctx({ onAsk: "elicit" });
    const l = call(1, "list_tables", {}, { requestState: "theirs", inputResponses: { q: { action: "accept" } } });
    expect(gateClientMessage(c, l)).toEqual([{ to: "server", line: l }]);
  });
});

describe("line splitter and pump", () => {
  it("reassembles messages split across chunks and ignores blank lines", () => {
    const lines: string[] = [];
    const feed = makeLineSplitter((l) => lines.push(l));
    feed('{"a":1}\n{"b":2}');
    feed('{"more":3}\n\n');
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
    expect(seenByServer).toHaveLength(1);
    expect(JSON.parse(seenByServer[0]!).id).toBe(1);
    expect(toClient.some((l) => JSON.parse(l).result?.isError)).toBe(true);
    expect(toClient.some((l) => JSON.parse(l).id === 1 && !JSON.parse(l).result?.isError)).toBe(true);
  });
});

describe("parseMcpArgs", () => {
  it("splits options from the upstream command and defaults the server name", () => {
    expect(parseMcpArgs(["--server", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"])).toMatchObject({ server: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(parseMcpArgs(["--", "node", "server.js"])).toMatchObject({ server: "node", command: "node", args: ["server.js"] });
    expect(parseMcpArgs(["--on-ask", "allow", "--", "./srv"])).toMatchObject({ onAsk: "allow", command: "./srv" });
    expect(() => parseMcpArgs(["--on-ask", "maybe", "--", "./srv"])).toThrow(/elicit, block or allow/);
    expect(() => parseMcpArgs(["--server", "x", "--"])).toThrow(/nothing to launch/);
  });
});
