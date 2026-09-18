/**
 * Talks to the daemon. Kept dependency-free (node builtins only) so the command hook can load it in a few ms.
 */
import { existsSync, readFileSync, openSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  buildId: string;
  startedAt: string;
  home: string;
}

export function readDaemonInfo(home: string): DaemonInfo | undefined {
  const p = join(home, "daemon.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

/** Same computation as the server's, on the server's file, so client and daemon agree on "this build". */
export function expectedBuildId(): string {
  try {
    const serverFile = join(dirname(fileURLToPath(import.meta.url)), "server.js");
    const st = statSync(serverFile);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return "unknown";
  }
}

export function daemonRequest<T>(info: DaemonInfo, path: string, body: unknown, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: info.port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`daemon ${path}: ${res.statusCode} ${text}`));
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`daemon ${path}: bad json`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

export interface Health {
  ok: boolean;
  pid: number;
  buildId: string;
  uptimeMs: number;
  instances: number;
  decisions: number;
}

/** A daemon that answers, and was built from the same files as this client. */
export async function daemonHealthy(info: DaemonInfo, timeoutMs = 300): Promise<Health | undefined> {
  try {
    const h = await daemonRequest<Health>(info, "/health", undefined, timeoutMs);
    return h.ok ? h : undefined;
  } catch {
    return undefined;
  }
}

export function isCurrentBuild(h: Health): boolean {
  return h.buildId === expectedBuildId();
}

/** Start `yenop daemon run` in the background, detached from this process. */
export function startDaemonDetached(home: string): void {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
  const logFd = openSync(join(home, "daemon.log"), "a");
  const child = spawn(process.execPath, [cli, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, YENOP_HOME: home },
  });
  child.unref();
}

/** Find a healthy, current daemon; start one if asked and wait briefly for it. */
export async function ensureDaemon(home: string, opts: { start?: boolean; waitMs?: number } = {}): Promise<DaemonInfo | undefined> {
  const info = readDaemonInfo(home);
  if (info) {
    const h = await daemonHealthy(info);
    if (h && isCurrentBuild(h)) return info;
    if (h && !isCurrentBuild(h)) {
      try {
        await daemonRequest(info, "/shutdown", {});
      } catch {
        /* it is going away */
      }
      await sleep(100);
    }
  }
  if (!opts.start) return undefined;
  startDaemonDetached(home);
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  while (Date.now() < deadline) {
    await sleep(60);
    const again = readDaemonInfo(home);
    if (again && again.buildId === expectedBuildId() && (await daemonHealthy(again))) return again;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
