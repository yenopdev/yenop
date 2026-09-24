#!/usr/bin/env node
/**
 * The yenop command. Every subcommand loads only what it needs, so `yenop hook claude-code`
 * stays close to bare Node startup and forwards to the daemon in about a millisecond.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const USAGE = `yenop — agents decide what to do; Yenop decides what is allowed to happen

start here:
  yenop init                           hook the agents in this project (Claude Code, Cursor, Codex, Gemini)
  yenop demo                           a scripted attack, judged live, in thirty seconds
  yenop viewer --open                  watch the receipts while an agent works
  yenop report                         after a week: what would have been stopped, and were the asks right

usage:
  yenop init [--user] [--no-hook] [--mode enforce|observe] [--hook http|command] [--agents a,b]
                                       set up ~/.yenop, start the daemon, install the Claude Code hook
                                       (project scope: .claude/settings.local.json; --user: ~/.claude/settings.json)
  yenop daemon run|start|stop|status   the resident decision service on 127.0.0.1
  yenop service install|uninstall|status|show
                                       keep the daemon alive under launchd (macOS) or systemd (Linux)
  yenop hook claude-code|cursor|codex|gemini  (called by the agent) read its pre-action event on stdin, decide, answer
  yenop mcp [--server NAME] [--on-ask elicit|block|allow] -- CMD ...
                                       sit between an MCP client and an MCP server; gate every tools/call
                                       and ask the person through the client when a call needs one
  yenop decide < request.json          decide one DecisionRequest from stdin, print the Decision
  yenop check                          parse and validate every policy in every layer
  yenop schema                         print the policy vocabulary and an example
  yenop receipts [--last N] [--run ID] [--all] [--verify]
                                       recent receipts for this project's tenant; --all for every project;
                                       --verify checks the tamper-evident hash chain
  yenop explain <tool> [json-args]     dry-run a tool call against the policies without recording a real step
  yenop status                         show mode, layers, daemon, and where receipts go for the current project
  yenop playground [dir]               create a throwaway project with enforcement on, for testing in Claude Code
  yenop report [--days N] [--all] [--share]
                                       what your agents did, in aggregate; --share sends the numbers (opt-in telemetry)
  yenop telemetry enable [--endpoint URL]|disable|status|reset
                                       opt-in, aggregate-only usage statistics; status shows exactly what is sent
  yenop feedback                       open the discussion board to tell us what you found
  yenop version                        print the version (include it in a bug report)
  yenop demo                           a scripted, no-agent walk through what Yenop does, for showing people
  yenop viewer [--port N] [--all] [--open]
                                       a read-only local web page of the receipts, updating live

Mode: "enforce" returns decisions to the runtime; "observe" only records them.
Set per project in <project>/.yenop/config.json, per machine in ~/.yenop/config.json, or with YENOP_MODE.
`;

function home(): string {
  return process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
}

/** Yenop's own version, from the package.json that ships with the build. */
const PKG_VERSION: string = (() => {
  try {
    const p = join(fileURLToPath(import.meta.url), "..", "..", "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** node:sqlite (the run state) exists unflagged from Node 22.13. Say so plainly instead of a module error. */
const MIN_NODE = [22, 13] as const;
function nodeTooOld(): string | undefined {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]) ? `yenop needs Node ${MIN_NODE.join(".")} or later; this is Node ${process.versions.node}. Install a current Node from https://nodejs.org and try again.\n` : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const old = nodeTooOld();
  if (old !== undefined) {
    process.stderr.write(old);
    return 1;
  }
  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`yenop ${PKG_VERSION}\n`);
      return 0;
    case "hook": {
      const { hookTranslator, hookRuntimes } = await import("../adapters/hooks/registry.js");
      const t = await hookTranslator(rest[0] ?? "");
      if (!t) return fail(`unknown hook runtime: ${rest[0] ?? "(none)"}; known: ${hookRuntimes().join(", ")}`);
      const { runHookWith, readStdin } = await import("../adapters/hooks/pipeline.js");
      try {
        const r = await runHookWith(t, await readStdin());
        if (r.stdout) process.stdout.write(r.stdout + "\n");
        if (r.stderr) process.stderr.write(r.stderr + "\n");
        return r.exitCode;
      } catch (e) {
        // A guard that broke must say no, loudly, in the runtime's own language. Observe mode records only.
        if (process.env["YENOP_MODE"] === "observe") return 0;
        const r = t.failure((e as Error).message.split("\n")[0] ?? "unknown error");
        if (r.stdout) process.stdout.write(r.stdout + "\n");
        if (r.stderr) process.stderr.write(r.stderr + "\n");
        return r.exitCode;
      }
    }
    case "mcp": {
      const { parseMcpArgs, runMcpGateway } = await import("../adapters/mcp/run.js");
      const opts = parseMcpArgs(rest);
      opts.cwd = process.cwd();
      return runMcpGateway(opts);
    }
    case "daemon":
      return daemonCommand(rest[0]);
    case "service":
      return serviceCommand(rest[0]);
    case "decide": {
      const { openYenop } = await import("../core/index.js");
      const { readStdin } = await import("../adapters/claude-code/hook.js");
      const req = JSON.parse(await readStdin()) as import("../core/index.js").DecisionRequest;
      const y = openYenop(req.cwd !== undefined ? { cwd: req.cwd } : {});
      try {
        process.stdout.write(JSON.stringify(y.decide(req), null, 2) + "\n");
        return 0;
      } finally {
        y.close();
      }
    }
    case "explain": {
      const [tool, argsJson] = rest;
      if (!tool) return fail("explain needs a tool name");
      const { openYenop, classifyTool } = await import("../core/index.js");
      const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const d = y.decide({ runId: `explain:${Date.now()}`, principal: { runtime: "cli", agent: "explain", user: "you" }, tool: classifyTool(tool), args, cwd: process.cwd() });
        process.stdout.write(`${d.effect.toUpperCase()}  ${d.message}\n`);
        if (d.reasons.length) process.stdout.write(`reasons: ${d.reasons.join(", ")}\n`);
        if (d.errors.length) process.stdout.write(`errors:  ${d.errors.join("; ")}\n`);
        return 0;
      } finally {
        y.close();
      }
    }
    case "check": {
      const { openYenop, loadPolicies, checkPolicies } = await import("../core/index.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        if (y.policyError !== undefined) {
          process.stdout.write(`INVALID: ${y.policyError}\n\nUntil this is fixed, Yenop refuses every action in this project${y.config.mode === "observe" ? " (observe mode: recorded, not enforced)" : ""}.\nThe vocabulary: yenop schema\n`);
          return 1;
        }
        const bundle = loadPolicies(y.config.policyLayers, { disabled: y.config.disabledPolicies });
        checkPolicies(bundle);
        for (const l of bundle.layers) process.stdout.write(`${pad(l.name, 9)} ${l.permit} permit, ${l.approve} approval   ${l.dir}\n`);
        const off = Object.keys(bundle.disabled);
        process.stdout.write(off.length ? `disabled  ${off.join(", ")}\n` : `disabled  none\n`);
        for (const w of bundle.warnings) process.stdout.write(`warning   ${w}\n`);
        process.stdout.write(`ok: every policy matches the vocabulary (policies/schema.cedarschema)\n`);
        return 0;
      } finally {
        y.close();
      }
    }
    case "receipts": {
      const { values } = parseArgs({ args: rest, options: { last: { type: "string", default: "20" }, run: { type: "string" }, all: { type: "boolean", default: false }, verify: { type: "boolean", default: false } } });
      const { openYenop, readAllReceipts, answersFor, isOutcome, verifyReceipts } = await import("../core/index.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      if (values.verify) {
        try {
          const c = verifyReceipts(y.config.receiptsPath);
          if (c.ok) process.stdout.write(`receipts intact: ${c.lines} line${c.lines === 1 ? "" : "s"} form an unbroken hash chain (${y.config.receiptsPath})\n`);
          else process.stdout.write(`RECEIPTS TAMPERED: the chain breaks at line ${c.brokenAt} of ${c.lines} — ${c.reason}\n(${y.config.receiptsPath})\n`);
          return c.ok ? 0 : 1;
        } finally {
          y.close();
        }
      }
      try {
        const everything = readAllReceipts(y.config.receiptsPath);
        const answers = answersFor(everything);
        let rows = everything.filter((r) => !isOutcome(r)) as import("../core/index.js").Receipt[];
        // One receipts file serves every project on the machine; show this project's tenant unless asked for all.
        const mine = y.config.tenant;
        if (!values.all) rows = rows.filter((r) => (typeof r.tenant === "string" ? r.tenant === mine.name : r.tenant.id === mine.id));
        if (values.run) rows = rows.filter((r) => r.runId === values.run);
        rows = rows.slice(-Number(values.last));
        if (rows.length === 0) {
          process.stdout.write(`no receipts for tenant "${mine.name}" yet (${y.config.receiptsPath}); use --all to see every project\n`);
          return 0;
        }
        for (const r of rows) {
          const summary = summarizeArgs(r.args);
          const tenantName = typeof r.tenant === "string" ? r.tenant : r.tenant.name;
          const answer = answers.get(r.id);
          const tag = (r.mode === "observe" ? "  (observe)" : r.enforced ? "" : "  (not enforced)") + (answer ? `  → ${answer}` : "");
          process.stdout.write(`${r.ts}  ${pad(tenantName, 10)} ${pad(r.effect.toUpperCase(), 5)}  ${pad(r.tool, 20)} ${summary}  [${r.reasons.join(", ")}]${tag}\n`);
        }
        return 0;
      } finally {
        y.close();
      }
    }
    case "status": {
      const { openYenop } = await import("../core/index.js");
      const { readDaemonInfo, daemonHealthy, isCurrentBuild } = await import("../daemon/client.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const c = y.config;
        process.stdout.write(`mode:      ${c.mode}${process.env["YENOP_MODE"] ? " (from YENOP_MODE)" : ""}\n`);
        if (y.policyError !== undefined) process.stdout.write(`POLICIES:  INVALID, every action is refused until fixed. Run: yenop check\n`);
        process.stdout.write(`tenant:    ${c.tenant.name} (${c.tenant.id})\n`);
        for (const l of c.policyLayers) process.stdout.write(`${pad(l.name === "baseline" ? "policies:" : "", 10)} ${pad(l.name, 9)} ${l.dir}\n`);
        if (c.disabledPolicies.length) process.stdout.write(`disabled:  ${c.disabledPolicies.join(", ")}\n`);
        process.stdout.write(`receipts:  ${c.receiptsPath}\n`);
        process.stdout.write(`state:     ${c.statePath}\n`);
        process.stdout.write(`budgets:   ${c.budgets.maxStepsPerRun} steps, ${c.budgets.maxDeniesPerRun} denies per run\n`);
        const info = readDaemonInfo(c.home);
        const h = info ? await daemonHealthy(info) : undefined;
        if (!info || !h) process.stdout.write(`daemon:    not running (hooks decide in-process, ~100 ms; run: yenop daemon start)\n`);
        else process.stdout.write(`daemon:    pid ${h.pid} on 127.0.0.1:${info.port}, ${h.decisions} decisions, up ${Math.round(h.uptimeMs / 60000)} min${isCurrentBuild(h) ? "" : "  (older build; restarts on next call)"}\n`);
        const { serviceState } = await import("../daemon/service.js");
        const svc = serviceState();
        if (svc.state !== "not-installed") process.stdout.write(`service:   ${svc.state}\n`);
        // Which agents on this machine are hooked, and where. The claim "every agent" is checked, not assumed.
        const hooked = (path: string, marker: string): boolean => {
          try {
            return existsSync(path) && readFileSync(path, "utf8").includes(marker);
          } catch {
            return false;
          }
        };
        const cover = (project: string, user: string, marker: string): string =>
          hooked(project, marker) ? "project" : hooked(user, marker) ? "user" : "no";
        const claude = cover(join(process.cwd(), ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json"), "hook claude-code");
        const cursor = cover(join(process.cwd(), ".cursor", "hooks.json"), join(homedir(), ".cursor", "hooks.json"), "hook cursor");
        const codexPath = hooked(join(process.cwd(), ".codex", "hooks.json"), "hook codex") ? join(process.cwd(), ".codex", "hooks.json") : hooked(join(homedir(), ".codex", "hooks.json"), "hook codex") ? join(homedir(), ".codex", "hooks.json") : undefined;
        const codex = codexPath === undefined ? "no" : codexPath.startsWith(homedir() + "/.codex") ? "user" : "project";
        const gemini = cover(join(process.cwd(), ".gemini", "settings.json"), join(homedir(), ".gemini", "settings.json"), "hook gemini");
        process.stdout.write(`agents:    claude-code=${claude}  cursor=${cursor}  codex=${codex}  gemini=${gemini}   (yenop init hooks what it detects; --agents forces a list)\n`);
        if (gemini === "project") {
          // Gemini skips a project's hooks in a folder it does not trust, and warns about hooks nobody acknowledged.
          const { geminiFolderTrust, geminiHookTrust, GEMINI_MARKER } = await import("../adapters/gemini/install.js");
          if (geminiFolderTrust(process.cwd()) === "untrusted") process.stdout.write(`WARNING:   Gemini does not trust this folder, so it skips the project's hooks: nothing is enforced on Gemini here. In Gemini run /permissions and trust the folder.\n`);
          try {
            const cmd = (JSON.parse(readFileSync(join(process.cwd(), ".gemini", "settings.json"), "utf8")) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> }).hooks?.["BeforeTool"]?.flatMap((g) => g.hooks ?? []).map((h) => h.command ?? "").find((c) => c.endsWith(GEMINI_MARKER));
            if (cmd && geminiHookTrust(process.cwd(), cmd) === "untrusted") process.stdout.write(`note:      Gemini will show the Yenop hooks for review on its next start in this project; acknowledge them there.\n`);
          } catch {
            /* unreadable settings: the coverage line already says what is known */
          }
        }
        if (codexPath !== undefined) {
          // Codex keeps its own per-hook trust switch. Installed is not the same as running.
          const { codexHookState } = await import("../adapters/codex/install.js");
          const pre = codexHookState(codexPath, "PreToolUse");
          if (pre === "disabled") process.stdout.write(`WARNING:   Codex has the Yenop PreToolUse hook DISABLED, so nothing is enforced on Codex. In Codex run /hooks and enable it.\n`);
          else if (pre === "untrusted") process.stdout.write(`WARNING:   Codex has not trusted the Yenop hooks yet. Start Codex in this project and choose "Trust all"; until then nothing is enforced on Codex.\n`);
        }
        return 0;
      } finally {
        y.close();
      }
    }
    case "schema": {
      const { builtinPoliciesDir, loadSchema } = await import("../core/index.js");
      process.stdout.write(loadSchema(builtinPoliciesDir()));
      process.stdout.write(`\n// Example, in <project>/.yenop/policies/approve/team.cedar (a permit in approve/ means "ask a person"):\n//\n// @id("ask-before-npm-install")\n// permit (principal, action == Yenop::Action::"call", resource)\n// when { context has shell && (context.shell.ops.contains("npm:install") || context.shell.ops.contains("npm:i") || context.shell.ops.contains("npm:add") || context.shell.ops.contains("npm:ci")) };\n//\n// Check your work: yenop check     Try it: yenop explain Bash '{"command":"npm install x"}'\n`);
      return 0;
    }
    case "init":
      return init(rest);
    case "viewer": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, all: { type: "boolean", default: false }, open: { type: "boolean", default: false } } });
      const { openYenop } = await import("../core/index.js");
      const { startViewer } = await import("../viewer/server.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      const vopts: { port?: number; all?: boolean } = { all: values.all };
      if (values.port) vopts.port = Number(values.port);
      const h = await startViewer(y.config, vopts);
      process.stdout.write(`yenop receipts viewer at ${h.url}\n(${values.all ? "every project" : `tenant "${y.config.tenant.name}"`}; read-only; this machine only; Ctrl-C to stop)\n`);
      if (values.open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try {
          const { spawn } = await import("node:child_process");
          spawn(opener, [h.url], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* the URL is printed; opening is a convenience */
        }
      }
      const stop = () => void h.close().then(() => y.close()).then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {});
      return 0;
    }
    case "report": {
      const { values } = parseArgs({ args: rest, options: { days: { type: "string", default: "7" }, all: { type: "boolean", default: false }, share: { type: "boolean", default: false } } });
      const { openYenop, buildReport, renderReport } = await import("../core/index.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const r = buildReport(y.config, { days: Number(values.days), all: values.all });
        process.stdout.write(renderReport(r) + "\n");
        if (values.share) return shareReport(y.config.home, r);
        return 0;
      } finally {
        y.close();
      }
    }
    case "telemetry":
      return telemetryCommand(rest[0], rest.slice(1));
    case "feedback": {
      const url = "https://github.com/yenopdev/yenop/discussions";
      process.stdout.write(`Tell us what you found: ${url}\nThe most useful things to share: an ask that should not have been asked, a deny that was wrong, or something an agent did that Yenop missed.\n`);
      openInBrowser(url);
      return 0;
    }
    case "demo": {
      const { runDemo } = await import("./demo.js");
      const opts: { color?: boolean } = {};
      if (rest.includes("--no-color")) opts.color = false;
      if (rest.includes("--color")) opts.color = true;
      return runDemo(opts);
    }
    case "playground": {
      const dir = resolve(rest[0] ?? join(homedir(), "yenop-playground"));
      const { hookCommandFor } = await import("../adapters/claude-code/install.js");
      const { CONFIG_VERSION, newTenantId } = await import("../core/index.js");
      await writePlayground(dir, hookCommandFor(fileURLToPath(import.meta.url)), CONFIG_VERSION, newTenantId());
      process.stdout.write(`playground ready at ${dir} (enforce mode)\n`);
      process.stdout.write(`open that folder in Claude Code and try:\n`);
      process.stdout.write(`  - "delete the build folder with rm -rf"          -> Yenop asks\n`);
      process.stdout.write(`  - "run terraform destroy on infra/"               -> Yenop asks\n`);
      process.stdout.write(`  - "print the database password from the env file" -> Yenop denies\n`);
      process.stdout.write(`  - "run npm test"                                  -> nothing, normal flow\n`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      return fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

async function serviceCommand(sub: string | undefined): Promise<number> {
  const { installService, uninstallService, serviceState, servicePlan } = await import("../daemon/service.js");
  switch (sub) {
    case "install": {
      mkdirSync(home(), { recursive: true });
      const r = installService(home());
      process.stdout.write(`${r.message}\n`);
      const { ensureDaemon } = await import("../daemon/client.js");
      const info = await ensureDaemon(home(), { start: true, waitMs: 6000 });
      process.stdout.write(info ? `daemon answering on 127.0.0.1:${info.port}\n` : `note: the daemon has not answered yet; check ${join(home(), "daemon.log")}\n`);
      process.stdout.write(`the http hook is now safe to use as the default: yenop init --hook http\n`);
      return 0;
    }
    case "uninstall":
      process.stdout.write(`${uninstallService().message}\n`);
      return 0;
    case "show": {
      process.stdout.write(servicePlan(home()).unit || "(no service on this platform)\n");
      return 0;
    }
    case "status":
    case undefined: {
      const s = serviceState();
      process.stdout.write(`service: ${s.state}  (${s.detail})\n`);
      return s.state === "running" ? 0 : 1;
    }
    default:
      return fail(`unknown service command: ${sub}`);
  }
}

async function daemonCommand(sub: string | undefined): Promise<number> {
  const h = home();
  switch (sub) {
    case "run": {
      // Foreground. `start` spawns this detached.
      const { startDaemon } = await import("../daemon/server.js");
      mkdirSync(h, { recursive: true });
      const d = await startDaemon({ home: h });
      const stop = () => void d.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.stdout.write(`yenop daemon listening on 127.0.0.1:${d.info.port} (pid ${process.pid})\n`);
      await new Promise(() => {});
      return 0;
    }
    case "start": {
      const { ensureDaemon } = await import("../daemon/client.js");
      mkdirSync(h, { recursive: true });
      const info = await ensureDaemon(h, { start: true, waitMs: 5000 });
      if (!info) return fail(`daemon did not come up; see ${join(h, "daemon.log")}`);
      process.stdout.write(`daemon running: pid ${info.pid} on 127.0.0.1:${info.port}\n`);
      return 0;
    }
    case "stop": {
      const { readDaemonInfo, daemonRequest } = await import("../daemon/client.js");
      const info = readDaemonInfo(h);
      if (!info) {
        process.stdout.write("daemon not running\n");
        return 0;
      }
      try {
        await daemonRequest(info, "/shutdown", {});
        process.stdout.write(`daemon pid ${info.pid} stopped\n`);
      } catch {
        rmSync(join(h, "daemon.json"), { force: true });
        process.stdout.write("daemon was not answering; cleared its record\n");
      }
      return 0;
    }
    case "status":
    case undefined: {
      const { readDaemonInfo, daemonHealthy, isCurrentBuild } = await import("../daemon/client.js");
      const info = readDaemonInfo(h);
      const st = info ? await daemonHealthy(info) : undefined;
      if (!info || !st) {
        process.stdout.write("daemon: not running\n");
        return 1;
      }
      process.stdout.write(`daemon: pid ${st.pid} on 127.0.0.1:${info.port}, ${st.decisions} decisions, ${st.instances} projects, up ${Math.round(st.uptimeMs / 1000)} s, build ${isCurrentBuild(st) ? "current" : "stale"}\n`);
      return 0;
    }
    default:
      return fail(`unknown daemon command: ${sub}`);
  }
}

async function init(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      user: { type: "boolean", default: false },
      "no-hook": { type: "boolean", default: false },
      mode: { type: "string", default: "enforce" },
      hook: { type: "string", default: "command" },
      agents: { type: "string" },
    },
  });
  if (values.mode !== "enforce" && values.mode !== "observe") return fail(`--mode must be enforce or observe`);
  if (values.hook !== "command" && values.hook !== "http") return fail(`--hook must be command or http`);
  const { builtinPoliciesDir, newTenantId, CONFIG_VERSION } = await import("../core/index.js");
  const { installClaudeCodeHook, installClaudeCodeHttpHook, hookCommandFor } = await import("../adapters/claude-code/install.js");
  const { ensureDaemon } = await import("../daemon/client.js");

  const h = home();
  mkdirSync(h, { recursive: true });
  const policies = join(h, "policies");
  migrateCopiedBaseline(policies, builtinPoliciesDir());
  for (const which of ["permit", "approve"] as const) {
    const dir = join(policies, which);
    mkdirSync(dir, { recursive: true });
    const local = join(dir, "local.cedar");
    if (!existsSync(local)) writeFileSync(local, LOCAL_TEMPLATE[which]);
  }
  writeFileSync(join(policies, "README.md"), readFileSync(join(builtinPoliciesDir(), "README.md"), "utf8"));
  process.stdout.write(`policies: baseline comes from the package; your own rules go in ${policies}/{permit,approve}/\n`);

  const cfg = join(h, "config.json");
  if (!existsSync(cfg)) {
    writeFileSync(
      cfg,
      JSON.stringify({ v: CONFIG_VERSION, tenant: { id: newTenantId(), name: "local" }, mode: values.mode, budgets: { maxStepsPerRun: 1000, maxDeniesPerRun: 20 }, disabledPolicies: [], secretPatterns: [] }, null, 2) + "\n",
    );
    process.stdout.write(`created ${cfg}\n`);
  } else {
    upgradeConfig(cfg, CONFIG_VERSION, newTenantId);
    // The machine's config already exists, so --mode would be silently ignored. A mode asked for explicitly
    // is set for this project instead (its own layer), which is what a person running `init --mode observe`
    // in a second project means.
    if (rest.includes("--mode")) {
      const projectCfg = join(process.cwd(), ".yenop", "config.json");
      const current = existsSync(projectCfg) ? (JSON.parse(readFileSync(projectCfg, "utf8")) as Record<string, unknown>) : {};
      if (current["mode"] !== values.mode) {
        mkdirSync(dirname(projectCfg), { recursive: true });
        writeFileSync(projectCfg, JSON.stringify({ ...current, mode: values.mode }, null, 2) + "\n");
        process.stdout.write(`mode ${values.mode} set for this project in ${projectCfg}\n`);
      }
    }
  }

  const daemon = await ensureDaemon(h, { start: true, waitMs: 5000 });
  process.stdout.write(daemon ? `daemon: running on 127.0.0.1:${daemon.port}\n` : `daemon: could not start; hooks will decide in-process (see ${join(h, "daemon.log")})\n`);

  if (!values["no-hook"]) {
    const settingsPath = values.user ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.local.json");
    if (values.hook === "http") {
      if (!daemon) return fail("the http hook needs the daemon; start it with: yenop daemon start");
      const { serviceState } = await import("../daemon/service.js");
      const svc = serviceState();
      if (svc.state !== "running") {
        process.stdout.write(`warning: the http hook fails open if the daemon is down, and nothing is supervising it.\n         run "yenop service install" first, or use the default command hook.\n`);
      }
      const r = installClaudeCodeHttpHook(settingsPath, daemon.port, daemon.token);
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code http hook in ${r.path}\n`);
    } else {
      const r = installClaudeCodeHook(settingsPath, hookCommandFor(fileURLToPath(import.meta.url)));
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code hook in ${r.path}\n`);
    }
    // Every other agent on this machine gets the same guard. Detected automatically; --agents forces a list.
    const cliPath = fileURLToPath(import.meta.url);
    const wanted = values.agents ? values.agents.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const { installCursorHooks, cursorHooksPath, cursorDetected } = await import("../adapters/cursor/install.js");
    if (wanted ? wanted.includes("cursor") : cursorDetected(process.cwd())) {
      const r = installCursorHooks(cursorHooksPath(values.user ? "user" : "project", process.cwd()), hookCommandFor(cliPath, "cursor"));
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Cursor hooks in ${r.path}\n`);
    }
    const { installCodexHooks, codexHooksPath, codexDetected } = await import("../adapters/codex/install.js");
    if (wanted ? wanted.includes("codex") : codexDetected(process.cwd())) {
      const r = installCodexHooks(codexHooksPath(values.user ? "user" : "project", process.cwd()), hookCommandFor(cliPath, "codex"));
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Codex hooks in ${r.path}\n`);
      process.stdout.write(`           Codex will ask you to review new hooks on its next start: choose "Trust all". A hook Codex has not trusted, or has disabled, never runs; "yenop status" checks.\n`);
    }
    const { installGeminiHooks, geminiSettingsPath, geminiDetected } = await import("../adapters/gemini/install.js");
    if (wanted ? wanted.includes("gemini") : geminiDetected(process.cwd())) {
      const r = installGeminiHooks(geminiSettingsPath(values.user ? "user" : "project", process.cwd()), hookCommandFor(cliPath, "gemini"));
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Gemini CLI hooks in ${r.path}\n`);
      if (!values.user) process.stdout.write(`           Gemini shows a project's new hooks for review on its next start; acknowledge them. It skips project hooks in a folder it does not trust; "yenop status" checks.\n`);
    }
    const { hookRuntimes } = await import("../adapters/hooks/registry.js");
    process.stdout.write(`agents Yenop can hook: ${hookRuntimes().join(", ")}\n`);
  }
  // Close with what a person needs to know: which mode is in force here, and what to do next.
  const { openYenop } = await import("../core/index.js");
  const effective = openYenop({ cwd: process.cwd(), dryRun: true });
  const mode = effective.config.mode;
  effective.close();
  process.stdout.write(
    mode === "observe"
      ? `mode:      observe: every decision is recorded, nothing is blocked. Switch with: yenop init --mode enforce\n`
      : `mode:      enforce: decisions are returned to the agent. To only record for a week first: yenop init --mode observe\n`,
  );
  process.stdout.write(`\nnext:      yenop demo            a scripted attack, judged live\n           yenop viewer --open   watch the receipts while an agent works\n           yenop report          after a week: what would have been stopped, and were the asks right\n`);
  return 0;
}

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  import("node:child_process").then(({ spawn }) => {
    try {
      spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    } catch {
      /* the URL is printed */
    }
  }).catch(() => {});
}

async function shareReport(h: string, r: import("../core/index.js").Report): Promise<number> {
  const { readTelemetry, toTelemetry, sendTelemetry, hookedRuntimes, DEFAULT_TELEMETRY_ENDPOINT } = await import("../core/index.js");
  const t = readTelemetry(h);
  if (!t.enabled || !t.installId) {
    process.stdout.write(`\nNot sent: telemetry is off. Turn it on with "yenop telemetry enable" (aggregate numbers only; "yenop telemetry status" shows exactly what would be sent).\n`);
    return 1;
  }
  const payload = toTelemetry(r, t.installId, PKG_VERSION, hookedRuntimes(process.cwd()));
  const ok = await sendTelemetry(t.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT, payload);
  process.stdout.write(ok ? `\nSent the numbers above (no commands, paths, prompts or names). Thank you.\n` : `\nCould not reach the telemetry endpoint; nothing was sent. Try again later or share the report by hand at https://github.com/yenopdev/yenop/discussions\n`);
  return ok ? 0 : 1;
}

/** Which runtimes have a Yenop hook registered for the current project or user. Names only. */

async function telemetryCommand(sub: string | undefined, args: string[] = []): Promise<number> {
  const { readTelemetry, enableTelemetry, disableTelemetry, resetInstallId, toTelemetry, buildReport, openYenop, hookedRuntimes, DEFAULT_TELEMETRY_ENDPOINT } = await import("../core/index.js");
  const h = home();
  switch (sub) {
    case "enable": {
      // A self-hosted receiver (an on-prem control plane) may be named. Off loopback it must be HTTPS: the
      // payload is aggregate, but it still leaves the machine.
      let endpoint: string | undefined;
      const i = args.indexOf("--endpoint");
      if (i !== -1) {
        endpoint = args[i + 1];
        let u: URL | undefined;
        try { u = endpoint ? new URL(endpoint) : undefined; } catch { /* reported below */ }
        const loopback = u && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
        if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && loopback))) return fail(`--endpoint must be an https:// URL (http:// only on loopback): ${endpoint ?? "(missing)"}`);
      }
      const s = enableTelemetry(h, endpoint);
      process.stdout.write(`telemetry: on (install id ${s.installId}${s.endpoint ? `, endpoint ${s.endpoint}` : ""}). Aggregate counts only, sent at most once a day by the daemon or when you run "yenop report --share".\nWhat is sent: version, OS, and counts of actions by verdict, rule id, runtime and tool kind. Never a command, path, prompt, source file, hostname, user or project name.\n"yenop telemetry status" shows the exact payload; "yenop telemetry disable" turns it off.\n`);
      return 0;
    }
    case "disable":
      disableTelemetry(h);
      process.stdout.write(`telemetry: off. Nothing will be sent.\n`);
      return 0;
    case "reset": {
      const s = resetInstallId(h);
      process.stdout.write(`telemetry: new install id ${s.installId}${s.enabled ? "" : " (telemetry is off)"}\n`);
      return 0;
    }
    case "status":
    case undefined: {
      const s = readTelemetry(h);
      process.stdout.write(`telemetry: ${s.enabled ? "on" : "off"}${s.installId ? `  install id ${s.installId}` : ""}${s.endpoint ? `  endpoint ${s.endpoint}` : `  endpoint ${DEFAULT_TELEMETRY_ENDPOINT}`}${s.lastSentAt ? `  last sent ${s.lastSentAt}` : ""}\n`);
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const payload = toTelemetry(buildReport(y.config, { days: 7 }), s.installId ?? "inst_(assigned on enable)", PKG_VERSION, hookedRuntimes(process.cwd()));
        process.stdout.write(`\nExactly what would be sent (last 7 days):\n${JSON.stringify(payload, null, 2)}\n`);
      } finally {
        y.close();
      }
      return 0;
    }
    default:
      return fail(`unknown telemetry command: ${sub}`);
  }
}

const LOCAL_TEMPLATE = {
  permit: `// Your own "may this happen at all" rules. The baseline pack is loaded automatically underneath.
// A forbid here wins over every permit. Give each policy its own @id so receipts can name it.
//
// @id("no-prod-db-from-agents")
// forbid (principal, action, resource)
// when { context has shell && context.shell.paths.contains("/srv/prod-db") };
`,
  approve: `// Your own "must a person see this first" rules. A permit here means: allowed, but ask.
//
// @id("payments-api")
// permit (principal, action == Yenop::Action::"call", resource)
// when { context has shell && context.shell.ops.contains("curl:-X") && context.args has command && context.args.command like "*api.stripe.com*" };
`,
};

/** Bring an older config.json up to the current shape without losing anything the user set. */
function upgradeConfig(path: string, version: number, newTenantId: () => string): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  let changed = false;
  if (raw["v"] === undefined) {
    raw["v"] = version;
    changed = true;
  }
  if (typeof raw["tenant"] === "string" || raw["tenant"] === undefined) {
    raw["tenant"] = { id: newTenantId(), name: (raw["tenant"] as string | undefined) ?? "local" };
    changed = true;
  }
  if (changed) {
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    process.stdout.write(`upgraded ${path} to config version ${version} (tenant now has a stable id)\n`);
  }
}

/** Comments and whitespace do not make a policy file different. */
function policyText(src: string): string {
  return src.split("\n").filter((l) => !l.trim().startsWith("//")).join(" ").replace(/\s+/g, " ").trim();
}

/** Installs before 0.0.2 copied the shipped pack into the home layer. Remove untouched copies so ids do not collide. */
function migrateCopiedBaseline(policiesDir: string, baselineDir: string): void {
  for (const which of ["permit", "approve"] as const) {
    const copy = join(policiesDir, which, "default.cedar");
    if (!existsSync(copy)) continue;
    const shipped = join(baselineDir, which, "default.cedar");
    if (existsSync(shipped) && policyText(readFileSync(copy, "utf8")) === policyText(readFileSync(shipped, "utf8"))) {
      rmSync(copy);
      process.stdout.write(`migrated: removed ${copy} (identical to the shipped baseline, which is now loaded from the package)\n`);
    } else {
      process.stdout.write(`note: ${copy} differs from the shipped baseline; rename its @ids or use disabledPolicies to avoid collisions\n`);
    }
  }
}

async function writePlayground(dir: string, hookCommand: string, configVersion: number, tenantId: string): Promise<void> {
  const w = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  w("README.md", "# Yenop playground\n\nA fake project for testing Yenop under enforcement. Nothing here is real. Delete the folder when done.\n");
  // A tenant id never changes once issued. Refreshing the playground must keep the id it already has,
  // or its earlier receipts stop matching.
  let tenant = { id: tenantId, name: "playground" };
  const cfgPath = join(dir, ".yenop", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const prev = JSON.parse(readFileSync(cfgPath, "utf8")) as { tenant?: { id?: string; name?: string } };
      if (prev.tenant?.id) tenant = { id: prev.tenant.id, name: prev.tenant.name ?? "playground" };
    } catch {
      /* unreadable config: issue a fresh id */
    }
  }
  w(".yenop/config.json", JSON.stringify({ v: configVersion, tenant, mode: "enforce" }, null, 2) + "\n");
  w("package.json", JSON.stringify({ name: "playground", private: true, scripts: { test: "node -e \"console.log('tests: 3 passed')\"", build: "mkdir -p build && echo built > build/out.txt" } }, null, 2) + "\n");
  w("build/out.txt", "built\n");
  w("infra/main.tf", 'resource "aws_db_instance" "prod" {\n  identifier = "prod-db"\n  allocated_storage = 100\n}\n');
  w(".env", "DATABASE_URL=postgres://app:not-a-real-password@db.internal:5432/prod\nSTRIPE_KEY=sk_test_not_real\n");
  w("src/app.js", "console.log('hello from the playground');\n");
  w(".yenop/policies/README.md", "# Policies for this project\n\nRun `yenop schema` for the vocabulary and an example, `yenop check` to validate, `yenop explain` to try a call.\nA permit in `approve/` means ask a person. A forbid in `permit/` means never.\nAn invalid policy file makes Yenop refuse every action in this project until it is fixed.\n");
  // loaded lazily so other commands do not pay for the installer; awaited, or the process exits before the file is written
  const { installClaudeCodeHook } = await import("../adapters/claude-code/install.js");
  installClaudeCodeHook(join(dir, ".claude", "settings.local.json"), hookCommand);
}

function fail(msg: string): number {
  process.stderr.write(`yenop: ${msg}\n`);
  return 1;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const key = ["command", "file_path", "path", "url", "query", "pattern"].find((k) => typeof a[k] === "string");
  const v = (key ? String(a[key]) : JSON.stringify(a)).replace(/\s+/g, " ").trim();
  return v.length > 80 ? v.slice(0, 77) + "..." : v;
}

main(process.argv.slice(2)).then(
  (code) => {
    const longRunning = (process.argv[2] === "daemon" && process.argv[3] === "run") || process.argv[2] === "mcp" || process.argv[2] === "viewer";
    if (!longRunning) process.exit(code);
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`yenop: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
