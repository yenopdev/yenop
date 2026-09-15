#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { builtinPoliciesDir, checkPolicies, loadPolicies, openYenop, readReceipts, classifyTool, newTenantId, CONFIG_VERSION, type DecisionRequest } from "../core/index.js";
import { runHook, readStdin } from "../adapters/claude-code/hook.js";
import { installClaudeCodeHook, hookCommandFor } from "../adapters/claude-code/install.js";

const USAGE = `yenop — the layer between an AI agent and the systems it can touch

usage:
  yenop init [--user] [--no-hook] [--mode enforce|observe]
                                       set up ~/.yenop with the default policies and install the Claude Code hook
                                       (project scope: .claude/settings.local.json; --user: ~/.claude/settings.json)
  yenop hook claude-code               (called by Claude Code) read a PreToolUse event on stdin, decide, respond
  yenop decide < request.json          decide one DecisionRequest from stdin, print the Decision
  yenop check                          parse every policy and report problems
  yenop receipts [--last N] [--run ID] show recent receipts
  yenop explain <tool> [json-args]     dry-run a tool call against the policies without recording a real step
  yenop status                         show mode, policy dirs, and where receipts go for the current project
  yenop playground [dir]               create a throwaway project with enforcement on, for testing in Claude Code

Mode: "enforce" returns decisions to the runtime; "observe" only records them.
Set per project in <project>/.yenop/config.json, per machine in ~/.yenop/config.json, or with YENOP_MODE.
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      if (rest[0] !== "claude-code") return fail(`unknown hook runtime: ${rest[0] ?? "(none)"}`);
      const r = await runHook(await readStdin());
      if (r.stdout) process.stdout.write(r.stdout + "\n");
      return r.exitCode;
    }
    case "decide": {
      const req = JSON.parse(await readStdin()) as DecisionRequest;
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
      const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const d = y.decide({
          runId: `explain:${Date.now()}`,
          principal: { runtime: "cli", agent: "explain", user: "you" },
          tool: classifyTool(tool),
          args,
          cwd: process.cwd(),
        });
        process.stdout.write(`${d.effect.toUpperCase()}  ${d.message}\n`);
        if (d.reasons.length) process.stdout.write(`reasons: ${d.reasons.join(", ")}\n`);
        if (d.errors.length) process.stdout.write(`errors:  ${d.errors.join("; ")}\n`);
        return 0;
      } finally {
        y.close();
      }
    }
    case "check": {
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
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
      const { values } = parseArgs({ args: rest, options: { last: { type: "string", default: "20" }, run: { type: "string" } } });
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        let rows = readReceipts(y.config.receiptsPath, 10_000);
        if (values.run) rows = rows.filter((r) => r.runId === values.run);
        rows = rows.slice(-Number(values.last));
        if (rows.length === 0) {
          process.stdout.write(`no receipts yet (${y.config.receiptsPath})\n`);
          return 0;
        }
        for (const r of rows) {
          const summary = summarizeArgs(r.args);
          const tag = r.mode === "observe" ? "  (observe)" : r.enforced ? "" : "  (not enforced)";
          const tenantName = typeof r.tenant === "string" ? r.tenant : r.tenant.name;
          process.stdout.write(`${r.ts}  ${pad(tenantName, 10)} ${pad(r.effect.toUpperCase(), 5)}  ${pad(r.tool, 20)} ${summary}  [${r.reasons.join(", ")}]${tag}\n`);
        }
        return 0;
      } finally {
        y.close();
      }
    }
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: { user: { type: "boolean", default: false }, "no-hook": { type: "boolean", default: false }, mode: { type: "string", default: "enforce" } },
      });
      if (values.mode !== "enforce" && values.mode !== "observe") return fail(`--mode must be enforce or observe`);
      const home = process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
      mkdirSync(home, { recursive: true });
      const policies = join(home, "policies");
      migrateCopiedBaseline(policies);
      for (const which of ["permit", "approve"] as const) {
        const dir = join(policies, which);
        mkdirSync(dir, { recursive: true });
        const local = join(dir, "local.cedar");
        if (!existsSync(local)) writeFileSync(local, LOCAL_TEMPLATE[which]);
      }
      writeFileSync(join(policies, "README.md"), readFileSync(join(builtinPoliciesDir(), "README.md"), "utf8"));
      process.stdout.write(`policies: baseline comes from the package; your own rules go in ${policies}/{permit,approve}/\n`);
      const cfg = join(home, "config.json");
      if (!existsSync(cfg)) {
        writeFileSync(
          cfg,
          JSON.stringify({ v: CONFIG_VERSION, tenant: { id: newTenantId(), name: "local" }, mode: values.mode, budgets: { maxStepsPerRun: 1000, maxDeniesPerRun: 20 }, disabledPolicies: [], secretPatterns: [] }, null, 2) + "\n",
        );
        process.stdout.write(`created ${cfg}\n`);
      } else {
        upgradeConfig(cfg);
      }
      if (!values["no-hook"]) {
        const settingsPath = values.user ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.local.json");
        const command = hookCommandFor(fileURLToPath(import.meta.url));
        const r = installClaudeCodeHook(settingsPath, command);
        process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code hook in ${r.path}\n`);
      }
      return 0;
    }
    case "status": {
      const y = openYenop({ cwd: process.cwd(), dryRun: true });
      try {
        const c = y.config;
        process.stdout.write(`mode:      ${c.mode}${process.env["YENOP_MODE"] ? " (from YENOP_MODE)" : ""}\n`);
        process.stdout.write(`tenant:    ${c.tenant.name} (${c.tenant.id})\n`);
        for (const l of c.policyLayers) process.stdout.write(`${pad(l.name === "baseline" ? "policies:" : "", 10)} ${pad(l.name, 9)} ${l.dir}\n`);
        if (c.disabledPolicies.length) process.stdout.write(`disabled:  ${c.disabledPolicies.join(", ")}\n`);
        process.stdout.write(`receipts:  ${c.receiptsPath}\n`);
        process.stdout.write(`state:     ${c.statePath}\n`);
        process.stdout.write(`budgets:   ${c.budgets.maxStepsPerRun} steps, ${c.budgets.maxDeniesPerRun} denies per run\n`);
        return 0;
      } finally {
        y.close();
      }
    }
    case "playground": {
      const dir = resolve(rest[0] ?? join(homedir(), "yenop-playground"));
      writePlayground(dir, hookCommandFor(fileURLToPath(import.meta.url)));
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

const LOCAL_TEMPLATE = {
  permit: `// Your own "may this happen at all" rules. The baseline pack is loaded automatically underneath.
// A forbid here wins over every permit. Give each policy its own @id so receipts can name it.
//
// @id("no-prod-db-from-agents")
// forbid (principal, action, resource)
// when { context.args has command && context.args.command like "*prod-db.internal*" };
`,
  approve: `// Your own "must a person see this first" rules. A permit here means: allowed, but ask.
//
// @id("payments-api")
// permit (principal, action == Yenop::Action::"call", resource)
// when { context.args has command && context.args.command like "*api.stripe.com*" };
`,
};

/** Bring an older config.json up to the current shape without losing anything the user set. */
function upgradeConfig(path: string): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  let changed = false;
  if (raw["v"] === undefined) {
    raw["v"] = CONFIG_VERSION;
    changed = true;
  }
  if (typeof raw["tenant"] === "string" || raw["tenant"] === undefined) {
    raw["tenant"] = { id: newTenantId(), name: (raw["tenant"] as string | undefined) ?? "local" };
    changed = true;
  }
  if (changed) {
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    process.stdout.write(`upgraded ${path} to config version ${CONFIG_VERSION} (tenant now has a stable id)\n`);
  }
}

/** Comments and whitespace do not make a policy file different. */
function policyText(src: string): string {
  return src.split("\n").filter((l) => !l.trim().startsWith("//")).join(" ").replace(/\s+/g, " ").trim();
}

/** Installs before 0.0.2 copied the shipped pack into the home layer. Remove untouched copies so ids do not collide. */
function migrateCopiedBaseline(policiesDir: string): void {
  for (const which of ["permit", "approve"] as const) {
    const copy = join(policiesDir, which, "default.cedar");
    if (!existsSync(copy)) continue;
    const shipped = join(builtinPoliciesDir(), which, "default.cedar");
    if (existsSync(shipped) && policyText(readFileSync(copy, "utf8")) === policyText(readFileSync(shipped, "utf8"))) {
      rmSync(copy);
      process.stdout.write(`migrated: removed ${copy} (identical to the shipped baseline, which is now loaded from the package)\n`);
    } else {
      process.stdout.write(`note: ${copy} differs from the shipped baseline; rename its @ids or use disabledPolicies to avoid collisions\n`);
    }
  }
}

function writePlayground(dir: string, hookCommand: string): void {
  const w = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  w("README.md", "# Yenop playground\n\nA fake project for testing Yenop under enforcement. Nothing here is real. Delete the folder when done.\n");
  w(".yenop/config.json", JSON.stringify({ v: CONFIG_VERSION, tenant: { id: newTenantId(), name: "playground" }, mode: "enforce" }, null, 2) + "\n");
  w("package.json", JSON.stringify({ name: "playground", private: true, scripts: { test: "node -e \"console.log('tests: 3 passed')\"", build: "mkdir -p build && echo built > build/out.txt" } }, null, 2) + "\n");
  w("build/out.txt", "built\n");
  w("infra/main.tf", 'resource "aws_db_instance" "prod" {\n  identifier = "prod-db"\n  allocated_storage = 100\n}\n');
  w(".env", "DATABASE_URL=postgres://app:not-a-real-password@db.internal:5432/prod\nSTRIPE_KEY=sk_test_not_real\n");
  w("src/app.js", "console.log('hello from the playground');\n");
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
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`yenop: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
