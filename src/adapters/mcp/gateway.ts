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
 * When a call needs a person, the gateway asks the person through the client, using MCP elicitation. Two
 * protocol generations exist and the gateway speaks both:
 *  - 2025-06-18 / 2025-11-25: the client declares `capabilities.elicitation` in `initialize`; the server sends
 *    an `elicitation/create` request and the client answers it. The gateway holds the call meanwhile.
 *  - 2026-07-28 (multi round-trip requests): servers no longer send requests. The gateway answers the call
 *    with `resultType: "input_required"` plus an opaque `requestState`; the client shows the form and retries
 *    the call with `inputResponses` and the same `requestState`. Nothing is held; the state is one nonce.
 * A client that supports neither gets the `onAsk` fallback: block (default) or allow.
 *
 * stdio transport: newline-delimited JSON-RPC, one message per line. Only `tools/call` is gated; every other
 * message passes. A blocked call is never written to the server.
 */
import { randomBytes } from "node:crypto";
import type { Yenop, DecisionRequest } from "../../core/index.js";
import { mcpToolRef } from "../../core/tools.js";

type JsonId = number | string;
interface JsonRpc {
  jsonrpc: "2.0";
  id?: JsonId;
  method?: string;
  params?: Record<string, unknown> & {
    name?: string;
    arguments?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    requestState?: string;
    inputResponses?: Record<string, { action?: string; content?: Record<string, unknown> }>;
    _meta?: Record<string, unknown>;
  };
  result?: Record<string, unknown> & { action?: string; content?: Record<string, unknown>; isError?: boolean };
  error?: unknown;
}

export type OnAsk = "elicit" | "block" | "allow";

/** What one message makes the gateway send, and where. */
export type Effect = { to: "server" | "client"; line: string };

interface Held {
  line: string;
  id: JsonId;
  callId: string;
  tool: string;
}
interface Pending {
  fingerprint: string;
  callId: string;
  tool: string;
  exp: number;
}

export interface GatewayState {
  /** The client said it can show elicitation forms, in the 2025 handshake. */
  legacyElicitation: boolean;
  seq: number;
  /** 2025 flow: our elicitation id -> the call waiting on the answer. */
  held: Map<string, Held>;
  /** 2026 flow: requestState nonce -> the call it belongs to. */
  pending: Map<string, Pending>;
  /** Asks that were forwarded: the server's response id -> the ask, so the outcome gets recorded. */
  awaiting: Map<string, { callId: string; tool: string }>;
}
export function newGatewayState(): GatewayState {
  return { legacyElicitation: false, seq: 0, held: new Map(), pending: new Map(), awaiting: new Map() };
}

export interface GatewayContext {
  yenop: Yenop;
  /** One run per gateway process: one client session with one server. */
  runId: string;
  /** The server alias, used to build the tool reference and to name the tool for receipts. */
  server: string;
  user: string;
  client: string;
  onAsk: OnAsk;
  state: GatewayState;
}

const ELICIT_KEY = "yenop-approval";
const ELICIT_PREFIX = "yenop:";
const PENDING_TTL_MS = 10 * 60 * 1000;
const CAPS_META = "io.modelcontextprotocol/clientCapabilities";

export { mcpToolRef } from "../../core/tools.js";

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
function fingerprint(tool: string, args: unknown): string {
  return `${tool} ${canon(args ?? {})}`;
}
function toolError(id: JsonId | undefined, text: string): Effect {
  return { to: "client", line: JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } }) };
}
function short(args: unknown): string {
  const s = canon(args ?? {});
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
/** The question a person sees. One flat enum, no mode field: readable by every client generation. */
function approvalRequest(ctx: GatewayContext, tool: string, args: unknown, reason: string) {
  return {
    method: "elicitation/create",
    params: {
      message: `Yenop: ${reason} Allow ${ctx.server}/${tool} ${short(args)}?`,
      requestedSchema: {
        type: "object",
        properties: { decision: { type: "string", title: "Decision", description: "Allow this call once, or deny it", enum: ["allow", "deny"] } },
        required: ["decision"],
      },
    },
  };
}
function answered(r: { action?: string; content?: Record<string, unknown> } | undefined): "allow" | "deny" {
  return r?.action === "accept" && r.content?.["decision"] === "allow" ? "allow" : "deny";
}
function refuse(ctx: GatewayContext, id: JsonId | undefined, callId: string, tool: string, why: string, detail: string): Effect {
  ctx.yenop.recordOutcome(ctx.runId, callId, tool, "denied", detail);
  return toolError(id, `Yenop: ${why} (tool ${ctx.server}/${tool}).`);
}
function stripMrtr(msg: JsonRpc): string {
  const params = { ...msg.params };
  delete params.inputResponses;
  delete params.requestState;
  return JSON.stringify({ ...msg, params });
}

/** Decide what one client message causes. Only tools/call is gated; parse failures and other methods pass through. */
export function gateClientMessage(ctx: GatewayContext, line: string): Effect[] {
  let msg: JsonRpc;
  try {
    msg = JSON.parse(line) as JsonRpc;
  } catch {
    return [{ to: "server", line }]; // never break the stream on a parse error
  }
  const st = ctx.state;

  // 2025 flow: the client is answering a question the gateway asked. The server never asked, so it never sees this.
  if (msg.method === undefined && typeof msg.id === "string" && msg.id.startsWith(ELICIT_PREFIX)) {
    const h = st.held.get(msg.id);
    st.held.delete(msg.id);
    if (!h) return [];
    if (msg.error === undefined && answered(msg.result) === "allow") {
      st.awaiting.set(String(h.id), { callId: h.callId, tool: h.tool });
      return [{ to: "server", line: h.line }];
    }
    return [refuse(ctx, h.id, h.callId, h.tool, "the person said no", "declined in the client")];
  }

  if (msg.method === "initialize") {
    st.legacyElicitation = !!msg.params?.capabilities?.["elicitation"];
    return [{ to: "server", line }];
  }
  if (msg.method === "notifications/cancelled") {
    const rid = String((msg.params as { requestId?: JsonId } | undefined)?.requestId);
    for (const [k, h] of st.held) if (String(h.id) === rid) st.held.delete(k);
    return [{ to: "server", line }];
  }
  if (msg.method !== "tools/call" || !msg.params || typeof msg.params.name !== "string") return [{ to: "server", line }];

  const tool = msg.params.name;
  const args = msg.params.arguments ?? {};

  // 2026 flow: a retry carrying the person's answer to a question the gateway asked.
  const rs = msg.params.requestState;
  if (rs !== undefined && st.pending.has(rs)) {
    const p = st.pending.get(rs)!;
    st.pending.delete(rs); // single use
    if (p.exp < Date.now() || p.fingerprint !== fingerprint(tool, args)) {
      return [refuse(ctx, msg.id, p.callId, p.tool, "the approval did not match this call or had expired; ask again", "approval expired or mismatched")];
    }
    if (answered(msg.params.inputResponses?.[ELICIT_KEY]) === "allow") {
      if (msg.id !== undefined) st.awaiting.set(String(msg.id), { callId: p.callId, tool: p.tool });
      return [{ to: "server", line: stripMrtr(msg) }]; // the real server never asked for these fields
    }
    return [refuse(ctx, msg.id, p.callId, p.tool, "the person said no", "declined in the client")];
  }

  const req: DecisionRequest = { runId: ctx.runId, principal: { runtime: "mcp", agent: ctx.client, user: ctx.user }, tool: mcpToolRef(ctx.server, tool), args };
  if (msg.id !== undefined) req.callId = `mcp:${msg.id}`;
  const callId = req.callId ?? "";
  const d = ctx.yenop.decide(req);

  if (d.mode === "observe" || d.effect === "allow") return [{ to: "server", line }];
  if (d.effect === "deny") return [toolError(msg.id, `Yenop blocked this: ${d.message} (tool ${ctx.server}/${tool}); receipt ${d.receiptId}.`)];

  // ask
  if (ctx.onAsk === "allow") {
    if (msg.id !== undefined) st.awaiting.set(String(msg.id), { callId, tool });
    return [{ to: "server", line }];
  }
  if (ctx.onAsk === "elicit") {
    const caps = msg.params._meta?.[CAPS_META] as { elicitation?: unknown } | undefined;
    if (caps?.elicitation !== undefined) {
      const nonce = randomBytes(16).toString("hex");
      st.pending.set(nonce, { fingerprint: fingerprint(tool, args), callId, tool, exp: Date.now() + PENDING_TTL_MS });
      const result = { resultType: "input_required", inputRequests: { [ELICIT_KEY]: approvalRequest(ctx, tool, args, d.message) }, requestState: nonce };
      return [{ to: "client", line: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) }];
    }
    if (st.legacyElicitation && msg.id !== undefined) {
      const eid = `${ELICIT_PREFIX}${++st.seq}`;
      st.held.set(eid, { line, id: msg.id, callId, tool });
      return [{ to: "client", line: JSON.stringify({ jsonrpc: "2.0", id: eid, ...approvalRequest(ctx, tool, args, d.message) }) }];
    }
  }
  return [refuse(ctx, msg.id, callId, tool, `needs a person, and this client cannot ask one: ${d.message} Adjust policy or run it yourself; receipt ${d.receiptId}`, "blocked at the MCP gateway: client cannot elicit")];
}

/** A server message always reaches the client. If it answers a forwarded ask, the outcome is recorded on the way. */
export function gateServerMessage(ctx: GatewayContext, line: string): Effect[] {
  try {
    const msg = JSON.parse(line) as JsonRpc;
    if (msg.id !== undefined && msg.method === undefined) {
      const a = ctx.state.awaiting.get(String(msg.id));
      if (a) {
        ctx.state.awaiting.delete(String(msg.id));
        const failed = msg.error !== undefined || msg.result?.isError === true;
        ctx.yenop.recordOutcome(ctx.runId, a.callId, a.tool, failed ? "failed" : "ran", failed ? "the server reported an error" : undefined);
      }
    }
  } catch {
    /* not JSON: pass it through */
  }
  return [{ to: "client", line }];
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
 * Wire a running gateway: client stdin -> (gate) -> server stdin, and server stdout -> (outcomes) -> client stdout.
 * Streams are injectable so tests drive it without a subprocess.
 */
export interface GatewayStreams {
  clientIn: NodeJS.ReadableStream;
  clientOut: NodeJS.WritableStream;
  serverIn: NodeJS.WritableStream;
  serverOut: NodeJS.ReadableStream;
}

export function pumpGateway(ctx: GatewayContext, s: GatewayStreams): void {
  const apply = (effects: Effect[]) => {
    for (const e of effects) (e.to === "server" ? s.serverIn : s.clientOut).write(e.line + "\n");
  };
  s.clientIn.on("data", makeLineSplitter((line) => apply(gateClientMessage(ctx, line))));
  s.serverOut.on("data", makeLineSplitter((line) => apply(gateServerMessage(ctx, line))));
}
