#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { builtinPoliciesDir, checkPolicies, loadPolicies, openYenop, readReceipts, classifyTool, type DecisionRequest } from "../core/index.js";
import { runHook, readStdin } from "../adapters/claude-code/hook.js";
import { installClaudeCodeHook } from "../adapters/claude-code/install.js";

const USAGE = `yenop — the layer between an AI agent and the systems it can touch

usage:
  yenop init [--user] [--no-hook]     set up ~/.yenop with the default policies and install the Claude Code hook
                                       (project scope: .claude/settings.local.json; --user: ~/.claude/settings.json)
  yenop hook claude-code               (called by Claude Code) read a PreToolUse event on stdin, decide, respond
  yenop decide < request.json          decide one DecisionRequest from stdin, print the Decision
  yenop check                          parse every policy and report problems
  yenop receipts [--last N] [--run ID] show recent receipts
  yenop explain <tool> [json-args]     dry-run a tool call against the policies without recording a real step
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
          tenant: y.config.tenant,
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
        const bundle = loadPolicies(y.config.policyDirs);
        checkPolicies(bundle);
        const n = (o: object) => Object.keys(o).length;
        process.stdout.write(`ok: ${n(bundle.permit)} permit policies, ${n(bundle.approve)} approval policies from ${y.config.policyDirs.join(", ")}\n`);
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
          process.stdout.write(`${r.ts}  ${pad(r.effect.toUpperCase(), 5)}  ${pad(r.tool, 24)} ${summary}  [${r.reasons.join(", ")}]${r.enforced ? "" : "  (not enforced)"}\n`);
        }
        return 0;
      } finally {
        y.close();
      }
    }
    case "init": {
      const { values } = parseArgs({ args: rest, options: { user: { type: "boolean", default: false }, "no-hook": { type: "boolean", default: false } } });
      const home = process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
      mkdirSync(home, { recursive: true });
      const policies = join(home, "policies");
      if (!existsSync(policies)) {
        cpSync(builtinPoliciesDir(), policies, { recursive: true });
        process.stdout.write(`created ${policies} with the default policy pack\n`);
      } else {
        process.stdout.write(`kept existing ${policies}\n`);
      }
      const cfg = join(home, "config.json");
      if (!existsSync(cfg)) {
        writeFileSync(cfg, JSON.stringify({ tenant: "local", budgets: { maxStepsPerRun: 1000, maxDeniesPerRun: 20 } }, null, 2) + "\n");
        process.stdout.write(`created ${cfg}\n`);
      }
      if (!values["no-hook"]) {
        const settingsPath = values.user ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.local.json");
        const cliPath = fileURLToPath(import.meta.url);
        const command = `node ${JSON.stringify(cliPath)} hook claude-code`;
        const r = installClaudeCodeHook(settingsPath, command);
        process.stdout.write(`${r.changed ? "installed" : "already installed"} Claude Code hook in ${r.path}\n`);
      }
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
