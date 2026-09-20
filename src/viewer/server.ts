/**
 * `yenop viewer` — a read-only local web page that shows the receipts as a timeline.
 *
 * The receipts are a plain append-only file; this is just a nicer way to read them, for a demo or for a
 * developer glancing at what an agent did. It is deliberately not part of the daemon: it stays off the
 * decision hot path, runs only when asked, and never writes anything. It binds to 127.0.0.1 and refuses any
 * request whose Host header is not localhost, so a web page cannot reach it by rebinding a name to 127.0.0.1.
 *
 * This is also the first pixel of the paid control plane's interface. Keep it self-contained: no external
 * scripts, no fonts, no network.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { YenopConfig } from "../core/config.js";
import { readAllReceipts, answersFor, isOutcome, summarizeCall, type Receipt } from "../core/index.js";

export interface ReceiptRow {
  id: string;
  ts: string;
  tenant: string;
  effect: "allow" | "ask" | "deny";
  tool: string;
  kind: string;
  summary: string;
  reasons: string[];
  approvals: string[];
  mode: string;
  enforced: boolean;
  runId: string;
  answer?: string;
}
export interface ViewerPayload {
  tenant: string;
  scope: "this project" | "every project";
  counts: { allow: number; ask: number; deny: number };
  rows: ReceiptRow[];
}

/** Build the timeline the page renders. Newest first. Pure, so it is easy to test. */
export function viewerPayload(config: YenopConfig, opts: { all?: boolean } = {}): ViewerPayload {
  const everything = readAllReceipts(config.receiptsPath);
  const answers = answersFor(everything);
  const mine = config.tenant;
  let rows = everything.filter((r): r is Receipt => !isOutcome(r));
  if (!opts.all) rows = rows.filter((r) => (typeof r.tenant === "string" ? r.tenant === mine.name : r.tenant.id === mine.id));

  const out: ReceiptRow[] = rows.map((r) => {
    const row: ReceiptRow = {
      id: r.id,
      ts: r.ts,
      tenant: typeof r.tenant === "string" ? r.tenant : r.tenant.name,
      effect: r.effect,
      tool: r.tool,
      kind: r.toolKind ?? "",
      summary: summarizeCall(r.args, 140),
      reasons: r.reasons.filter((x) => !x.startsWith("approve:")),
      approvals: r.reasons.filter((x) => x.startsWith("approve:")).map((x) => x.slice(8)),
      mode: r.mode,
      enforced: r.enforced,
      runId: r.runId,
    };
    const a = answers.get(r.id);
    if (a) row.answer = a;
    return row;
  });
  out.reverse();
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const r of out) counts[r.effect]++;
  return { tenant: mine.name, scope: opts.all ? "every project" : "this project", counts, rows: out };
}

const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export interface ViewerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startViewer(config: YenopConfig, opts: { port?: number; all?: boolean } = {}): Promise<ViewerHandle> {
  const page = renderPage();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: only requests that addressed us as localhost are served.
    const host = req.headers.host ?? "";
    if (!HOST_OK.test(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(page);
      return;
    }
    if (path === "/api/receipts") {
      const body = JSON.stringify(viewerPayload(config, { all: opts.all ?? false }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** The whole page: one file, no external anything. Polls the API so a live demo updates as calls happen. */
function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yenop receipts</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --panel:#14171c; --line:#242a31; --dim:#8a94a0; --fg:#e6e9ee;
          --allow:#3fb950; --ask:#d29922; --deny:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:16px 24px; display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.02em; }
  h1 small { color:var(--dim); font-weight:400; margin-left:8px; }
  .counts { display:flex; gap:14px; margin-left:auto; }
  .pill { padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; background:var(--panel); border:1px solid var(--line); }
  .pill.allow { color:var(--allow); } .pill.ask { color:var(--ask); } .pill.deny { color:var(--deny); }
  .filters { display:flex; gap:8px; }
  .filters button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:5px 12px; cursor:pointer; font:inherit; }
  .filters button[aria-pressed="true"] { border-color:var(--fg); }
  main { padding:16px 24px 80px; max-width:1100px; }
  .row { display:grid; grid-template-columns: 92px 84px 1fr; gap:14px; padding:12px 0; border-bottom:1px solid var(--line); align-items:baseline; }
  .time { color:var(--dim); font-variant-numeric:tabular-nums; font-size:12px; }
  .verdict { font-weight:700; font-size:12px; letter-spacing:.04em; }
  .verdict.allow { color:var(--allow); } .verdict.ask { color:var(--ask); } .verdict.deny { color:var(--deny); }
  .tool { font-weight:600; }
  .tool .kind { color:var(--dim); font-weight:400; font-size:12px; margin-left:6px; }
  .summary { color:var(--fg); word-break:break-word; opacity:.92; }
  .why { color:var(--dim); font-size:12px; margin-top:3px; }
  .why b { color:var(--ask); font-weight:600; }
  .answer { font-size:12px; margin-top:3px; }
  .answer.ran { color:var(--allow); } .answer.refused, .answer.abandoned { color:var(--deny); } .answer.awaiting { color:var(--ask); }
  .badge { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:6px; padding:0 6px; margin-left:8px; }
  .empty { color:var(--dim); padding:40px 0; }
  footer { position:fixed; bottom:0; left:0; right:0; background:var(--bg); border-top:1px solid var(--line); padding:8px 24px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Yenop receipts <small id="scope"></small></h1>
  <div class="filters">
    <button data-f="all" aria-pressed="true">all</button>
    <button data-f="ask">needs a person</button>
    <button data-f="deny">blocked</button>
    <button data-f="allow">allowed</button>
  </div>
  <div class="counts" id="counts"></div>
</header>
<main><div id="list"><div class="empty">Loading…</div></div></main>
<footer>Read-only. This machine only. Every decision the agent made, hash-chained and verifiable. <span id="stamp"></span></footer>
<script>
let filter = "all";
const esc = s => String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const clock = ts => { try { return new Date(ts).toLocaleTimeString(); } catch { return ts; } };
function answerClass(a){ if(!a) return ""; if(a.includes("ran")) return "ran"; if(a.includes("refused")) return "refused"; if(a.includes("not run")) return "abandoned"; if(a.includes("awaiting")) return "awaiting"; return ""; }
function verdictWord(e){ return e==="allow"?"ALLOWED":e==="deny"?"BLOCKED":"NEEDS A PERSON"; }
function draw(data){
  document.getElementById("scope").textContent = "— " + data.scope + ', tenant "' + data.tenant + '"';
  const c = data.counts;
  document.getElementById("counts").innerHTML =
    '<span class="pill allow">'+c.allow+' allowed</span><span class="pill ask">'+c.ask+' asked</span><span class="pill deny">'+c.deny+' blocked</span>';
  const rows = data.rows.filter(r => filter==="all" || r.effect===filter);
  const list = document.getElementById("list");
  if(rows.length===0){ list.innerHTML = '<div class="empty">No receipts'+(filter!=="all"?" for this filter":" yet. Run an agent, or try <code>yenop demo</code>")+'.</div>'; return; }
  list.innerHTML = rows.map(r => {
    const approvals = r.approvals && r.approvals.length ? '<span class="why">holds for: <b>'+r.approvals.map(esc).join(", ")+'</b></span>' : '';
    const reasons = r.reasons && r.reasons.length ? '<span class="why">'+r.reasons.map(esc).join(", ")+'</span>' : '';
    const answer = r.answer ? '<div class="answer '+answerClass(r.answer)+'">'+esc(r.answer)+'</div>' : '';
    const mode = r.mode==="observe" ? '<span class="badge">observe</span>' : (!r.enforced ? '<span class="badge">not enforced</span>' : '');
    return '<div class="row">'
      + '<div class="time">'+esc(clock(r.ts))+'</div>'
      + '<div class="verdict '+r.effect+'">'+verdictWord(r.effect)+'</div>'
      + '<div><div><span class="tool">'+esc(r.tool)+'</span>'+(r.kind?'<span class="kind">'+esc(r.kind)+'</span>':'')+mode+'</div>'
      + '<div class="summary">'+esc(r.summary)+'</div>'
      + (r.approvals&&r.approvals.length?approvals:reasons)
      + answer + '</div></div>';
  }).join("");
}
async function tick(){
  try {
    const res = await fetch("/api/receipts");
    draw(await res.json());
    document.getElementById("stamp").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) { /* the viewer was closed; stop quietly */ }
}
for (const b of document.querySelectorAll(".filters button")) b.onclick = () => {
  filter = b.dataset.f;
  for (const x of document.querySelectorAll(".filters button")) x.setAttribute("aria-pressed", x===b);
  tick();
};
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
