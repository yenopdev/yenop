#!/usr/bin/env node
/**
 * The yenop command. Every subcommand loads only what it needs, so `yenop hook claude-code`
 * stays close to bare Node startup and forwards to the daemon in about a millisecond.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const USAGE = `yenop — the layer between an AI agent and the systems it can touch

usage:
  yenop init [--user] [--no-hook] [--mode enforce|observe] [--hook http|command]
                                       set up ~/.yenop, start the daemon, install the Claude Code hook
                                       (project scope: .claude/settings.local.json; --user: ~/.claude/settings.json)
  yenop daemon run|start|stop|status   the resident decision service on 127.0.0.1
  yenop hook claude-code               (called by Claude Code) read a PreToolUse event on stdin, decide, respond
  yenop decide < request.json          decide one DecisionRequest from stdin, print the Decision
  yenop check                          parse and validate every policy in every layer
  yenop schema                         print the policy vocabulary and an example
  yenop receipts [--last N] [--run ID] [--all]
                                       recent receipts for this project's tenant; --all for every project
  yenop explain <tool> [json-args]     dry-run a tool call against the policies without recording a real step
  yenop status                         show mode, layers, daemon, and where receipts go for the current project
  yenop playground [dir]               create a throwaway project with enforcement on, for testing in Claude Code

Mode: "enforce" returns decisions to the runtime; "observe" only records them.
Set per project in <project>/.yenop/config.json, per machine in ~/.yenop/config.json, or with YENOP_MODE.
`;

function home(): string {
  return process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      if (rest[0] !== "claude-code") return fail(`unknown hook runtime: ${rest[0] ?? "(none)"}`);
      const { runHook, readStdin } = await import("../adapters/claude-code/hook.js");
      try {
        const r = await runHook(await readStdin());
        if (r.stdout) process.stdout.write(r.stdout + "\n");
        return r.exitCode;
      } catch (e) {
        // Claude Code treats any other exit code as "no opinion". A guard that broke must say no, loudly.
        if (process.env["YENOP_MODE"] === "observe") return 0;
        const reason = `Yenop failed and refuses by default: ${(e as Error).message.split("\n")[0]}. Run "yenop status".`;
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
        return 2;
      }
    }
    case "daemon":
      return daemonCommand(rest[0]);
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
      const { values } = parseArgs({ args: rest, options: { last: { type: "string", default: "20" }, run: { type: "string" }, all: { type: "boolean", default: false } } });
      const { openYenop, readReceipts } = await import("../core/index.js");
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        let rows = readReceipts(y.config.receiptsPath, 10_000);
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
          const tag = r.mode === "observe" ? "  (observe)" : r.enforced ? "" : "  (not enforced)";
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
    case "playground": {
      const dir = resolve(rest[0] ?? join(homedir(), "yenop-playground"));
      const { hookCommandFor } = await import("../adapters/claude-code/install.js");
      const { CONFIG_VERSION, newTenantId } = await import("../core/index.js");
      writePlayground(dir, hookCommandFor(fileURLToPath(import.meta.url)), CONFIG_VERSION, newTenantId());
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
  }

  const daemon = await ensureDaemon(h, { start: true, waitMs: 5000 });
  process.stdout.write(daemon ? `daemon: running on 127.0.0.1:${daemon.port}\n` : `daemon: could not start; hooks will decide in-process (see ${join(h, "daemon.log")})\n`);

  if (!values["no-hook"]) {
    const settingsPath = values.user ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.local.json");
    if (values.hook === "http") {
      if (!daemon) return fail("the http hook needs the daemon; start it with: yenop daemon start");
      const r = installClaudeCodeHttpHook(settingsPath, daemon.port, daemon.token);
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code http hook in ${r.path}\n`);
    } else {
      const r = installClaudeCodeHook(settingsPath, hookCommandFor(fileURLToPath(import.meta.url)));
      process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code hook in ${r.path}\n`);
    }
  }
  return 0;
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

function writePlayground(dir: string, hookCommand: string, configVersion: number, tenantId: string): void {
  const w = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  w("README.md", "# Yenop playground\n\nA fake project for testing Yenop under enforcement. Nothing here is real. Delete the folder when done.\n");
  w(".yenop/config.json", JSON.stringify({ v: configVersion, tenant: { id: tenantId, name: "playground" }, mode: "enforce" }, null, 2) + "\n");
  w("package.json", JSON.stringify({ name: "playground", private: true, scripts: { test: "node -e \"console.log('tests: 3 passed')\"", build: "mkdir -p build && echo built > build/out.txt" } }, null, 2) + "\n");
  w("build/out.txt", "built\n");
  w("infra/main.tf", 'resource "aws_db_instance" "prod" {\n  identifier = "prod-db"\n  allocated_storage = 100\n}\n');
  w(".env", "DATABASE_URL=postgres://app:not-a-real-password@db.internal:5432/prod\nSTRIPE_KEY=sk_test_not_real\n");
  w("src/app.js", "console.log('hello from the playground');\n");
  w(".yenop/policies/README.md", "# Policies for this project\n\nRun `yenop schema` for the vocabulary and an example, `yenop check` to validate, `yenop explain` to try a call.\nA permit in `approve/` means ask a person. A forbid in `permit/` means never.\nAn invalid policy file makes Yenop refuse every action in this project until it is fixed.\n");
  // written lazily to avoid loading the installer for other commands
  import("../adapters/claude-code/install.js").then(({ installClaudeCodeHook }) => installClaudeCodeHook(join(dir, ".claude", "settings.local.json"), hookCommand));
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
    if (code !== 0 || process.argv[2] !== "daemon") process.exitCode = code;
    if (process.argv[2] !== "daemon" || process.argv[3] !== "run") process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`yenop: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
