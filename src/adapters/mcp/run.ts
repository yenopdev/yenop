/**
 * `yenop mcp --server NAME -- <command> <args...>`
 * Launch the real MCP server and proxy stdio through the gateway.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { openYenop } from "../../core/index.js";
import { uuidv7 } from "../../core/index.js";
import { pumpGateway, type GatewayContext } from "./gateway.js";

export interface McpOptions {
  server?: string;
  command: string;
  args: string[];
  onAsk?: "block" | "allow";
  cwd?: string;
  home?: string;
}

/** Split `["--server","github","--","npx","-y","pkg"]` into options and the upstream command after `--`. */
export function parseMcpArgs(argv: string[]): McpOptions {
  let server: string | undefined;
  let onAsk: "block" | "allow" | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--server") server = argv[++i];
    else if (a === "--on-ask") onAsk = argv[++i] === "allow" ? "allow" : "block";
    else break;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) throw new Error('yenop mcp: nothing to launch. Usage: yenop mcp --server NAME -- <command> [args...]');
  const opts: McpOptions = { command: rest[0]!, args: rest.slice(1), server: server ?? basename(rest[0]!).replace(/\.[^.]+$/, "") };
  if (onAsk) opts.onAsk = onAsk;
  return opts;
}

export async function runMcpGateway(opts: McpOptions): Promise<number> {
  const openArgs: Parameters<typeof openYenop>[0] = {};
  if (opts.cwd !== undefined) openArgs.cwd = opts.cwd;
  if (opts.home !== undefined) openArgs.home = opts.home;
  const yenop = openYenop(openArgs);

  const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "inherit"] });
  const ctx: GatewayContext = {
    yenop,
    runId: `mcp:${opts.server}:${uuidv7()}`,
    server: opts.server ?? "mcp",
    user: safeUser(),
    client: "mcp-client",
    onAsk: opts.onAsk ?? "block",
  };

  pumpGateway(ctx, {
    clientIn: process.stdin,
    clientOut: process.stdout,
    serverIn: child.stdin!,
    serverOut: child.stdout!,
  });

  // The gateway's lifetime is the server's. When either end closes, tear down cleanly.
  return await new Promise<number>((resolve) => {
    const done = (code: number) => {
      yenop.close();
      resolve(code);
    };
    child.on("exit", (code) => done(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`yenop mcp: cannot launch ${opts.command}: ${(e as Error).message}\n`);
      done(127);
    });
    process.stdin.on("end", () => child.stdin?.end());
  });
}

function safeUser(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("node:os") as typeof import("node:os")).userInfo().username;
  } catch {
    return "unknown";
  }
}
