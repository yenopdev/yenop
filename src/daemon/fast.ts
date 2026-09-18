/**
 * The command hook's path to the daemon. Imports only `node:net` and `node:fs`:
 * loading Node's HTTP client costs ~20 ms, which is half of what a hook call should take.
 * The daemon always answers with Content-Length and closes the connection, so a minimal
 * HTTP/1.1 exchange over a raw socket is enough.
 */
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FastDaemonInfo {
  port: number;
  token: string;
}

export function readDaemonInfoFast(home: string): FastDaemonInfo | undefined {
  const p = join(home, "daemon.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as FastDaemonInfo;
    return typeof j.port === "number" && typeof j.token === "string" ? j : undefined;
  } catch {
    return undefined;
  }
}

export function rawPost(info: FastDaemonInfo, path: string, body: string, timeoutMs = 1500): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(info.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    s.setTimeout(timeoutMs, () => s.destroy(new Error("daemon timeout")));
    s.on("connect", () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${info.token}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    s.on("data", (c: Buffer) => chunks.push(c));
    s.on("error", reject);
    s.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
      if (split === -1 || !status) return reject(new Error("daemon: malformed response"));
      resolve({ status, body: text.slice(split + 4) });
    });
  });
}
