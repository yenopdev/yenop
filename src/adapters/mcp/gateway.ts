/**
 * The MCP gateway: Yenop between an MCP client and an MCP server.
 *
 * An MCP client (Cursor, Claude Desktop, an OpenAI or custom agent) launches a tool server and calls its
 * tools. Point the client at Yenop instead of at the server; Yenop launches the real server, forwards every
 * message, and runs a decision on each `tools/call`. Allowed calls go through untouched. Blocked calls never
 * reach the server: the client gets a tool error carrying the reason. This is the same policy engine, run
 * state and receipts as the Claude Code hook, so a rule written once covers every MCP-speaking agent.
 *
 * This is where the trusted-backend attacks land: an injected instruction telling the agent to dump a
 * database through a Supabase MCP server, or exfiltrate a repo through a GitHub MCP server. The server would
 * obey. The gateway does not.
 *
 * stdio transport: newline-delimited JSON-RPC, one message per line. Client requests flow to the server,
 * server responses and notifications flow back. Only `tools/call` requests are gated; everything else passes.
 */
import type { Yenop, DecisionRequest, ToolRef } from "../../core/index.js";
import { classifyTool } from "../../core/index.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [k: string]: unknown };
}

export interface GatewayContext {
  yenop: Yenop;
  /** One run per gateway process: one client session with one server. */
  runId: string;
  /** The server alias, used to build the tool reference and to name the tool for receipts. */
  server: string;
  user: string;
  client: string;
  /** How to handle a call that needs a person, when there is no interactive approver at the proxy. */
  onAsk: "block" | "allow";
}

/** Build the tool reference the policy engine expects. The server's own annotations are not trusted; the name is heuristic. */
export function mcpToolRef(server: string, name: string): ToolRef {
  const t = classifyTool(`mcp__${server}__${name}`);
  return { ...t, name, server };
}

export type GateResult = { action: "forward" } | { action: "respond"; message: object };

/** Decide one client message. Only tools/call is gated; parse failures and other methods pass through. */
export function gateClientMessage(ctx: GatewayContext, line: string): GateResult {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return { action: "forward" }; // not our concern; never break the stream on a parse error
  }
  if (msg.method !== "tools/call" || !msg.params || typeof msg.params.name !== "string") return { action: "forward" };

  const req: DecisionRequest = {
    runId: ctx.runId,
    principal: { runtime: "mcp", agent: ctx.client, user: ctx.user },
    tool: mcpToolRef(ctx.server, msg.params.name),
    args: msg.params.arguments ?? {},
  };
  if (msg.id !== undefined) req.callId = `mcp:${msg.id}`;
  const d = ctx.yenop.decide(req);

  // observe mode, or allow: the call goes to the server.
  if (d.mode === "observe" || d.effect === "allow") return { action: "forward" };
  if (d.effect === "ask" && ctx.onAsk === "allow") return { action: "forward" };

  const what = d.effect === "ask" ? "needs a person, and this MCP gateway has no interactive approver" : "was blocked";
  const text = `Yenop ${what}: ${d.message} (tool ${ctx.server}/${msg.params.name}). Adjust policy or run it yourself; receipt ${d.receiptId}.`;
  return {
    action: "respond",
    message: { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: true } },
  };
}

/** A newline-delimited-JSON splitter that holds a partial trailing line between chunks. */
export function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };
}

/**
 * Wire a running gateway: client stdin -> (gate) -> server stdin, and server stdout -> client stdout.
 * Streams are injectable so tests drive it without a subprocess.
 */
export interface GatewayStreams {
  clientIn: NodeJS.ReadableStream;
  clientOut: NodeJS.WritableStream;
  serverIn: NodeJS.WritableStream;
  serverOut: NodeJS.ReadableStream;
}

export function pumpGateway(ctx: GatewayContext, s: GatewayStreams): void {
  const toServer = makeLineSplitter((line) => {
    const r = gateClientMessage(ctx, line);
    if (r.action === "forward") s.serverIn.write(line + "\n");
    else s.clientOut.write(JSON.stringify(r.message) + "\n"); // blocked: answer the client, never touch the server
  });
  const toClient = makeLineSplitter((line) => s.clientOut.write(line + "\n"));
  s.clientIn.on("data", toServer);
  s.serverOut.on("data", toClient);
}
