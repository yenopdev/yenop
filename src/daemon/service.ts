/**
 * Keeping the daemon alive under the operating system's own supervisor.
 *
 * The command hook can always fall back to deciding in-process, so it is safe without a running daemon.
 * The HTTP hook cannot: Claude Code treats an unreachable hook as "no opinion", which fails open. So the
 * HTTP hook should only be the default when something guarantees the daemon is up. That is what this does:
 * a launchd agent on macOS or a systemd user service on Linux that starts the daemon at login and restarts
 * it if it exits, including the deliberate exit the daemon makes when Yenop is rebuilt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_LABEL = "com.yenop.daemon";

export interface ServicePlan {
  platform: "darwin" | "linux" | "unsupported";
  /** How to launch the daemon: node plus the CLI path, or the bare `yenop` command when it resolves here. */
  argv: string[];
  home: string;
  /** Where the unit file goes. */
  unitPath: string;
  /** The unit file contents. */
  unit: string;
}

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
}

/**
 * Always node's absolute path plus the CLI's absolute path. A launchd agent and a systemd user service
 * both run with a minimal PATH that does not include Homebrew, nvm, or fnm, so `#!/usr/bin/env node` in
 * the CLI, and a bare `yenop` command, both fail with "node: not found". Prefer a stable node symlink
 * (/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node) over a version-pinned path so the service
 * survives a Node minor upgrade; fall back to the node running this command.
 */
function stableNode(): string {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  return process.execPath;
}
function launchArgv(): string[] {
  return [stableNode(), cliPath(), "daemon", "run"];
}
export function nodeDir(): string {
  return dirname(launchArgv()[0]!);
}

function darwinPlist(argv: string[], home: string): string {
  const args = argv.map((a) => `    <string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>YENOP_HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${nodeDir()}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${join(home, "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(home, "daemon.log")}</string>
</dict>
</plist>
`;
}

function linuxUnit(argv: string[], home: string): string {
  return `[Unit]
Description=Yenop decision daemon
Documentation=https://yenop.com
After=default.target

[Service]
Type=simple
ExecStart=${argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}
Environment=YENOP_HOME=${home}
Environment=PATH=${nodeDir()}:/usr/bin:/bin:/usr/sbin:/sbin
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function servicePlan(home = process.env["YENOP_HOME"] ?? join(homedir(), ".yenop")): ServicePlan {
  const argv = launchArgv();
  if (process.platform === "darwin") {
    return { platform: "darwin", argv, home, unitPath: join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`), unit: darwinPlist(argv, home) };
  }
  if (process.platform === "linux") {
    return { platform: "linux", argv, home, unitPath: join(homedir(), ".config", "systemd", "user", "yenop.service"), unit: linuxUnit(argv, home) };
  }
  return { platform: "unsupported", argv, home, unitPath: "", unit: "" };
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message || "").toString() };
  }
}

export interface ServiceResult {
  platform: string;
  unitPath: string;
  message: string;
}

/** Write the unit file and load it. Idempotent: a reload picks up a changed unit. */
export function installService(home?: string): ServiceResult {
  const p = servicePlan(home);
  if (p.platform === "unsupported") throw new Error(`yenop: no service integration for ${process.platform}; run "yenop daemon start" instead, or supervise "yenop daemon run" yourself`);
  mkdirSync(dirname(p.unitPath), { recursive: true });
  writeFileSync(p.unitPath, p.unit);
  if (p.platform === "darwin") {
    const uid = userInfo().uid;
    run("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]); // clear any old copy; ignore result
    let r = run("launchctl", ["bootstrap", `gui/${uid}`, p.unitPath]);
    if (!r.ok) r = run("launchctl", ["load", "-w", p.unitPath]); // older macOS
    if (!r.ok) throw new Error(`yenop: wrote ${p.unitPath} but launchctl failed: ${r.out.trim()}`);
    run("launchctl", ["enable", `gui/${uid}/${SERVICE_LABEL}`]);
    return { platform: p.platform, unitPath: p.unitPath, message: `installed and started the launchd agent ${SERVICE_LABEL}; it will keep the daemon running and start it at login` };
  }
  run("systemctl", ["--user", "daemon-reload"]);
  const r = run("systemctl", ["--user", "enable", "--now", "yenop.service"]);
  if (!r.ok) throw new Error(`yenop: wrote ${p.unitPath} but systemctl failed: ${r.out.trim()}. On a headless box run: loginctl enable-linger ${userInfo().username}`);
  return { platform: p.platform, unitPath: p.unitPath, message: `installed and started the systemd user service yenop.service; enable it across logouts with: loginctl enable-linger ${userInfo().username}` };
}

export function uninstallService(): ServiceResult {
  const p = servicePlan();
  if (p.platform === "unsupported") return { platform: p.platform, unitPath: "", message: "nothing to uninstall" };
  if (p.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${userInfo().uid}/${SERVICE_LABEL}`]);
  } else {
    run("systemctl", ["--user", "disable", "--now", "yenop.service"]);
  }
  if (existsSync(p.unitPath)) rmSync(p.unitPath);
  return { platform: p.platform, unitPath: p.unitPath, message: "removed the service; the daemon is no longer supervised" };
}

export type ServiceState = "running" | "installed-not-running" | "not-installed" | "unsupported";

export function serviceState(): { state: ServiceState; detail: string } {
  const p = servicePlan();
  if (p.platform === "unsupported") return { state: "unsupported", detail: process.platform };
  if (!existsSync(p.unitPath)) return { state: "not-installed", detail: p.unitPath };
  if (p.platform === "darwin") {
    const r = run("launchctl", ["print", `gui/${userInfo().uid}/${SERVICE_LABEL}`]);
    if (!r.ok) return { state: "installed-not-running", detail: "unit present, launchctl has not loaded it" };
    const running = /\bpid = \d+/.test(r.out) || /active count = [1-9]/.test(r.out);
    return { state: running ? "running" : "installed-not-running", detail: p.unitPath };
  }
  const r = run("systemctl", ["--user", "is-active", "yenop.service"]);
  return { state: r.out.trim() === "active" ? "running" : "installed-not-running", detail: p.unitPath };
}
