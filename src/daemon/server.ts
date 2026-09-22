/**
 * The Yenop daemon: a resident decision service on localhost.
 *
 * Why: opening policies, the Cedar engine and the state database costs ~40 ms and Node itself ~36 ms.
 * A warm decision costs ~1 ms. The daemon keeps everything warm and answers over HTTP, so Claude Code's
 * HTTP hook type reaches a decision in about a millisecond, and the command hook forwards here in ~40 ms.
 *
 * One daemon per YENOP_HOME. It serves every project on the machine; instances are cached per working
 * directory and rebuilt when their config or policy files change.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openYenop, type Yenop, type DecisionRequest } from "../core/index.js";
import { readTelemetry, writeTelemetry, dueForDaily, toTelemetry, sendTelemetry, buildReport, hookedRuntimes, DEFAULT_TELEMETRY_ENDPOINT } from "../core/index.js";
import { expectedBuildId } from "./client.js";
import { hookTranslator } from "../adapters/hooks/registry.js";
import { decideEvent, eventCwd } from "../adapters/hooks/pipeline.js";

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  buildId: string;
  startedAt: string;
  home: string;
}

export const DAEMON_PROTOCOL = 1;

export function yenopHome(): string {
  return process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
}

export function daemonInfoPath(home: string): string {
  return join(home, "daemon.json");
}

function pkgVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Identifies this build. Shared with the client so both sides agree; see expectedBuildId. */
export function currentBuildId(): string {
  return expectedBuildId();
}

/**
 * Something about the config or policies changed on disk. Cheap: a handful of stats.
 * Covers every place a file could appear, not only the places that existed when the project was first seen.
 */
function fingerprint(home: string, cwd: string | undefined, baselineDir: string): string {
  const parts: string[] = [];
  const stat = (p: string) => {
    try {
      const s = statSync(p);
      parts.push(`${p}:${Math.round(s.mtimeMs)}:${s.size}`);
    } catch {
      parts.push(`${p}:absent`);
    }
  };
  const policyDir = (dir: string) => {
    for (const which of ["permit", "approve"]) {
      const d = join(dir, which);
      if (!existsSync(d)) {
        parts.push(`${d}:absent`);
        continue;
      }
      for (const f of readdirSync(d).filter((n) => n.endsWith(".cedar")).sort()) stat(join(d, f));
    }
  };
  stat(join(home, "config.json"));
  policyDir(join(home, "policies"));
  policyDir(baselineDir);
  stat(join(baselineDir, "schema.cedarschema"));
  if (cwd) {
    stat(join(cwd, ".yenop", "config.json"));
    policyDir(join(cwd, ".yenop", "policies"));
  }
  return parts.join("|");
}

class InstanceCache {
  private byCwd = new Map<string, { y: Yenop; fp: string; checkedAt: number; baseline: string }>();
  constructor(private home: string) {}

  get(cwd: string | undefined): Yenop {
    const key = cwd ?? "";
    const now = Date.now();
    const hit = this.byCwd.get(key);
    if (hit) {
      if (now - hit.checkedAt < 1000) return hit.y;
      const fp = fingerprint(this.home, cwd, hit.baseline);
      hit.checkedAt = now;
      if (fp === hit.fp) return hit.y;
      hit.y.close();
      this.byCwd.delete(key);
    }
    const y = openYenop(cwd ? { cwd, home: this.home } : { home: this.home });
    const baseline = y.config.policyLayers[0]?.dir ?? "";
    this.byCwd.set(key, { y, fp: fingerprint(this.home, cwd, baseline), checkedAt: now, baseline });
    return y;
  }
  size(): number {
    return this.byCwd.size;
  }
  clear(): void {
    for (const v of this.byCwd.values()) v.y.close();
    this.byCwd.clear();
  }
}

export interface DaemonOptions {
  home?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Write daemon.json so clients can find us. Tests turn this off. */
  register?: boolean;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  info: DaemonInfo;
  server: Server;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Port and token survive restarts. The HTTP hook writes both into a settings file once;
 * a daemon that came back on a new port with a new token would silently stop being called.
 */
interface DaemonKey {
  port: number;
  token: string;
}
function keyPath(home: string): string {
  return join(home, "daemon.key");
}
function readKey(home: string): DaemonKey | undefined {
  try {
    const k = JSON.parse(readFileSync(keyPath(home), "utf8")) as DaemonKey;
    return typeof k.port === "number" && typeof k.token === "string" ? k : undefined;
  } catch {
    return undefined;
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = opts.home ?? yenopHome();
  mkdirSync(home, { recursive: true });
  const persist = opts.register !== false;
  const key = persist ? readKey(home) : undefined;
  const token = key?.token ?? randomBytes(24).toString("base64url");
  // The build this process was started from. Health must report this, never a fresh stat of the file on disk,
  // or a stale daemon would always look current.
  const bootBuildId = currentBuildId();
  const cache = new InstanceCache(home);
  const startedAt = new Date();
  let decisions = 0;
  const log = opts.log ?? ((line: string) => appendFileSync(join(home, "daemon.log"), `${new Date().toISOString()} ${line}\n`));

  const authorized = (req: IncomingMessage): boolean => req.headers["authorization"] === `Bearer ${token}`;

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/health") {
        send(res, 200, {
          ok: true,
          protocol: DAEMON_PROTOCOL,
          pid: process.pid,
          buildId: bootBuildId,
          startedAt: startedAt.toISOString(),
          uptimeMs: Date.now() - startedAt.getTime(),
          instances: cache.size(),
          decisions,
        });
        return;
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const raw = await readBody(req);
      // Every hooked runtime: /hooks/<runtime>. The translator parses; a parse failure is a deny, not silence.
      if (url.startsWith("/hooks/")) {
        const t = await hookTranslator(url.slice("/hooks/".length));
        if (!t) return send(res, 404, { error: "unknown hook runtime" });
        let event;
        try {
          event = t.parse(raw);
        } catch (e) {
          const y = cache.get(undefined);
          const reason = `malformed hook input: ${(e as Error).message.split("\n")[0]}`;
          const fake = { kind: "decision" as const, event: "?", askCapable: false, request: { runId: "invalid", principal: { runtime: t.runtime, agent: "?", user: "?" }, tool: { name: "?", kind: "unknown" as const, readOnly: false }, args: {} } };
          return send(res, 200, y.config.mode === "observe" ? {} : (t.body("deny", reason, y.config.mode, fake) ?? {}));
        }
        // Outcomes and session ends must reach the same project instance as the decision they belong to, or
        // they are recorded against the wrong tenant and an approved call reads as "not run".
        const cwd = eventCwd(event);
        const y = cache.get(cwd);
        if (event.kind === "decision") decisions++;
        return send(res, 200, decideEvent(y, t, event) ?? {});
      }
      switch (url) {
        case "/decide": {
          const { cwd, request } = JSON.parse(raw) as { cwd?: string; request: DecisionRequest };
          const y = cache.get(cwd);
          decisions++;
          return send(res, 200, y.decide(request));
        }
        case "/reload":
          cache.clear();
          return send(res, 200, { ok: true });
        case "/shutdown":
          send(res, 200, { ok: true });
          setTimeout(() => void running.close().then(() => process.exit(0)), 20);
          return;
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      // A broken request must never block a tool call by accident: report, and let the runtime's own flow apply.
      send(res, 500, { error: (e as Error).message });
    }
  });

  const wanted = opts.port ?? key?.port ?? 0;
  try {
    // A daemon that just retired may hold the port for a moment; wait for it rather than moving house.
    for (let attempt = 0; ; attempt++) {
      try {
        await listen(server, wanted);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0 || attempt >= 15) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw e;
    log(`port ${wanted} is taken; choosing another. HTTP hooks installed earlier must be reinstalled: yenop init --hook http`);
    await listen(server, 0);
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (persist && (key?.port !== port || key?.token !== token)) {
    writeFileSync(keyPath(home), JSON.stringify({ port, token }, null, 2) + "\n", { mode: 0o600 });
  }
  const info: DaemonInfo = { pid: process.pid, port, token, buildId: bootBuildId, startedAt: startedAt.toISOString(), home };
  if (opts.register !== false) {
    writeFileSync(daemonInfoPath(home), JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
    log(`started pid ${process.pid} on 127.0.0.1:${port} build ${info.buildId}`);
  }

  // A rebuilt Yenop must not keep answering from old code: when this file changes on disk, step aside.
  // The next hook call decides in-process and starts a fresh daemon.
  const bootBuild = info.buildId;
  const staleCheck = setInterval(() => {
    if (currentBuildId() !== bootBuild) {
      log(`build changed on disk (${bootBuild} -> ${currentBuildId()}); exiting so a fresh daemon can start`);
      void running.close().then(() => process.exit(0));
    }
  }, 2000);
  staleCheck.unref();

  // Opt-in telemetry, at most once a day, on a timer that is entirely off the decision path. Off by default;
  // a person turns it on with `yenop telemetry enable`. Failures are silent and never retried within the hour.
  const telemetryTick = async () => {
    try {
      const t = readTelemetry(home);
      if (!dueForDaily(t)) return;
      const y = cache.get(undefined);
      const payload = toTelemetry(buildReport(y.config, { days: 1, all: true }), t.installId!, expectedBuildId() === "unknown" ? "0.0.0" : pkgVersion(), hookedRuntimes());
      if (await sendTelemetry(t.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT, payload)) writeTelemetry(home, { ...t, lastSentAt: new Date().toISOString() });
    } catch {
      /* telemetry must never affect the daemon */
    }
  };
  const telemetryTimer = setInterval(() => void telemetryTick(), 60 * 60 * 1000);
  telemetryTimer.unref();
  setTimeout(() => void telemetryTick(), 30_000).unref();

  const running: RunningDaemon = {
    info,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(staleCheck);
        clearInterval(telemetryTimer);
        cache.clear();
        if (opts.register !== false) {
          try {
            const cur = JSON.parse(readFileSync(daemonInfoPath(home), "utf8")) as DaemonInfo;
            if (cur.pid === process.pid) unlinkSync(daemonInfoPath(home));
          } catch {
            /* already gone */
          }
          log(`stopped pid ${process.pid}`);
        }
        server.close(() => resolve());
      }),
  };
  return running;
}
