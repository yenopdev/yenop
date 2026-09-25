# Yenop

**The local-first execution authorization layer for AI agents. One set of rules across the agents you run, and your agents' actions stay on your machine.**

An AI agent decides what it wants to do. Yenop decides what is allowed to happen. It sits between the agent and the systems it can touch, and on every action it returns one of three answers:

**ALLOW** &nbsp;·&nbsp; **ASK** a person &nbsp;·&nbsp; **DENY**

- **One layer across the agents you run.** Claude Code, Cursor, Codex CLI, Gemini CLI, agents built on the OpenAI Agents SDK, and any tool that speaks MCP, judged by the same policies and written to one verifiable record. No single agent vendor will ever govern its competitors; a layer outside all of them can.
- **It authorizes the action, not the reasoning.** Yenop does not decide whether an agent's thinking is safe. It decides whether the action the agent is about to execute is allowed, reading the actual command and file path, so there is no sentence to jailbreak. And it watches the whole run, so a harmful plan split across steps that each look harmless is still caught.
- **Local-first.** It runs next to the agent, on your machine. No cloud dependency, no account, and no agent data, source, prompts or secrets leaves the machine unless you choose to export the audit trail. That trail is a plain file you own, hash-chained so tampering is detectable.

Status: **pre-alpha, developer preview** (0.1.1). **Source-available, not open source** (see License). Works today with Claude Code, Cursor, Codex CLI and Gemini CLI hooks, the OpenAI Agents SDK, and an MCP gateway for any MCP client, each verified in a live session against the current release of that runtime. The set of runtimes is frozen for this preview; the next one is added when people using Yenop ask for it.

## See it in thirty seconds

```sh
yenop demo
```

A scripted walk through what Yenop does, with no AI agent and nothing real touched: safe work passes silently, a secret-exfiltration attempt is blocked, a multi-step plan is caught by the run's history, a database dump is stopped at the MCP gateway, and Yenop refuses to let the agent switch it off. Every verdict is the real engine.

## Why this exists

Companies are giving agents real access: the shell, the repository, the database, the cloud. An agent is helpful, but it does what it is told, including by a web page or a document carrying a hidden instruction. And the newest models reason in ways you cannot read or log, so you cannot audit the thinking. You can only govern the actions. That is the one place left to put a control, and it is where Yenop sits.

Yenop's claim is deliberately narrow and provable: **a model's decision is never the final authorization decision.** Whatever the agent was convinced to attempt, the deed still has to pass a deterministic rule, and a person still signs off on the irreversible ones.

## Why another layer?

Your agent already has permissions. Cursor has run modes. Codex has a sandbox. MCP servers describe their own tools. Cloud platforms have IAM. So why install one more thing?

Because each of those controls part of the execution path, and each is owned by the party it governs. A runtime's permission system changes with its next release. A tool server's "read-only" hint is the server's word. A model's judgement is the thing being attacked. None of them is independent of the agent, and none of them is the same across the three agents your team runs on the same repository.

Yenop adds an independent enforcement boundary, outside the agent, that stays the same when the runtime, the model, or the tool server changes. One policy, one record, whichever agent acted. It does not replace those controls; it is the layer that is still there when they differ, update, or are talked around.

## Who this is for

Developers and security-minded teams giving coding agents, MCP tools, and autonomous workflows real access: a repository, credentials, a database, infrastructure. If an agent on your machine can reach something you would not want it to touch unasked, Yenop is for you.

## Quickstart

Requires Node 22.13 or later (`node --version`). Then:

```sh
npm install -g yenop
yenop init            # sets up ~/.yenop and installs the hook for every agent it detects
```

From source, today:

```sh
npm install && npm run build && npm link
yenop init            # detects Claude Code, Cursor, Codex, Gemini; installs each hook
yenop status          # mode, layers, daemon, and which agents are covered
yenop explain Bash '{"command":"terraform destroy -auto-approve"}'
```

From then on, every action an agent takes in this project passes through Yenop first:

| The agent tries | Yenop says |
|---|---|
| `npm test`, editing a source file, reading the README | nothing; the agent's normal flow applies |
| `terraform destroy`, `DROP TABLE`, a forced push, writing outside the project, an MCP tool that writes | **ask**: the agent shows the exact action and waits for a person |
| a scanner, exploitation framework, credential cracker, or a reverse shell (`nmap`, `sqlmap`, `hashcat`, `bash -i >& /dev/tcp/...`) | **ask**: dual-use, so a person signs off |
| reading a private key or `.env`, piping a download into a shell, sending a credential over the network | **deny**: blocked, with the policy named |
| inline code handed to an interpreter (`python -c`, `eval`) that touches a protected file | **ask** or **deny**: opaque code is judged by what it names |
| a run that has been denied 20 times, or has made 1,000 calls | **deny**: the breaker halts the run |

Yenop only ever tightens. It never grants something the agent would have asked about on its own.

## Watch it happen

```sh
yenop viewer --open
```

A read-only web page of the receipts, on this machine only, updating every couple of seconds: green allowed, amber needs a person, red blocked, each with the reason and the recorded answer. Off the decision path, writes nothing. Put it beside your agent during a demo.

Roll it out without breaking anyone's flow: **observe mode** records decisions without blocking.

```sh
yenop init --mode observe   # in the project; nothing is blocked, everything is recorded
yenop init --mode enforce   # when the report looks right
```

Run it for a week, read what would have been stopped, tune the policies, then switch to enforce.

## Read the week

```sh
yenop report            # last 7 days, this project
yenop report --days 30 --all
```

Counts by verdict, by rule, by runtime and by kind of action, from the receipts on this machine. The line that matters is the **ask approval rate**: of the calls held for a person, how many the person then allowed. Near 100 % means a rule asks too often; near 0 % means the asks were real catches. That is how the baseline gets tuned by evidence rather than opinion. `yenop feedback` opens the discussion board for the things a number cannot say.

**Telemetry is off by default and stays off unless you turn it on.** `yenop telemetry enable` sends the report's numbers once a day; `yenop telemetry status` prints the exact payload; `disable` stops it; `reset` issues a new random install id. What is sent is an allow-list, built in [`src/core/telemetry.ts`](src/core/telemetry.ts): counts by verdict, rule id, runtime and tool kind, the Yenop version, the operating system name and major version, which runtimes are hooked, and a random install id. Never a command, a path, a prompt, source, a hostname, a username, a project or tenant name, a receipt, or an MCP argument. A field not listed there does not leave the machine.

---

## Every agent, one engine

Yenop turns each runtime's event into one canonical action, so the engine, the policies, the run state and the receipts never know which agent produced it. A rule written once applies to all of them.

**Claude Code.** A PreToolUse hook decides before each tool runs, and later events record whether the call ran, failed, or was refused. Silent on allow, a prompt on ask, a block on deny.

**Cursor.** `yenop init` writes `.cursor/hooks.json`. Cursor sends every tool call through `preToolUse` first, then through a specialised hook for shell and MCP calls that can ask a person, so Yenop judges everything at the first gate and lets an ask through to the second, where Cursor shows it as "Pending approval… Hook requested approval: Yenop: …", even in its Run Everything mode. File edits can only be allowed or denied there, so an edit that needs a person is blocked with a message rather than let through. Every hook is fail-closed, so a crash or timeout blocks. Verified in a live session against Cursor 3.21.18: allow, ask, deny on a secret read, and an attempt to edit its own hook file refused. Two facts about Cursor itself: its documentation describes the specialised hooks as the gates, but `preToolUse` fires first and a hook that stays silent there blocks the call, which is how the first version of this adapter failed, safely; and when a person clicks Skip on an approval, Cursor reports the command to hooks exactly as if it had run with no output, so on Cursor "approved, ran" in a receipt means "Cursor reported it complete", nothing more.

**Codex CLI.** `yenop init` writes `.codex/hooks.json`. Shell commands, `apply_patch` edits and MCP calls are judged, and a patch touching several files is judged by the strictest of them. Two facts about Codex itself: it has no way to ask a person from a hook, so a step that needs one is blocked with a message; and it ignores a hook that crashes or times out. Be precise about whose guarantee is whose: **Yenop's boundary is fail-closed**, a decision it cannot make is a deny; **Codex's runtime is fail-open**, it proceeds if the hook itself does not answer. Yenop answers with the one signal Codex always honours and is built to answer every time, but it cannot change Codex's design, and we say so rather than imply otherwise. Proven against a live model that tried to route around a blocked edit through an interpreter, and was stopped.

**Gemini CLI.** `yenop init` writes the hooks into `.gemini/settings.json`. Every built-in tool (shell, file reads and writes, `read_many_files`, `save_memory`, web fetch and search) and every MCP tool is judged before it runs, and Gemini honours all three answers: allow silently, **ask** by forcing its own confirmation prompt even in an auto-approve mode, deny with the reason handed to the model. Two facts about Gemini itself, read from its source rather than its docs: a hook that times out or fails to start is ignored, so Gemini's runtime is fail-open like Codex's, and Yenop answers with JSON on exit 0 for every verdict including its own failure, the one path Gemini honours without ambiguity; and Gemini skips a project's hooks in a folder it does not trust and shows new hooks for review, so `yenop status` reads both switches and says when nothing is enforced. Verified in a live session against Gemini CLI 0.60.0 with auto-approve on and no sandbox: allow silent, deny with the reason, ask shown as Gemini's own dialog with the run's history in it, and the ask comes back even after a person picked "Allow for this session", so Gemini's convenience switch never bypasses Yenop. The recorded events are the fixtures. One honest note: the model itself refused to read `.env` before any tool call; Yenop's deny was exercised on a `.npmrc`. A model's refusal is a mood, not a boundary, which is the point.

**OpenAI Agents SDK.** An agent you build with `@openai/agents` runs in your own process, so Yenop runs there too, as a pair of tool guardrails: the input guardrail decides, the output guardrail records what happened.

```ts
import { tool } from "@openai/agents";
import { yenopGuardrails } from "yenop/openai-agents";

const guard = yenopGuardrails({
  tools: { run_shell: { kind: "shell" }, write_file: { kind: "write" }, fetch_url: { kind: "web", readOnly: true } },
  onAsk: async (decision) => askInTerminal(decision.message), // or Slack, or your approval UI
});
const runShell = tool({ name: "run_shell", /* ... */ inputGuardrails: guard.inputGuardrails, outputGuardrails: guard.outputGuardrails });
```

Your tools are your own functions, so `tools` says what each can do; one you leave out is judged as unknown and held for a person. A guardrail cannot ask anyone by itself: `onAsk` is where you route an ask, and without it an ask is refused, never let through. A deny reaches the agent as a rejection with the reason, so it can do something else, or as the SDK's tripwire exception with `onDeny: "throw"`. One SDK run is one Yenop run, so the run-level rules follow the agent across its calls. No dependency on the SDK: the types are structural, checked against `@openai/agents-core` 0.18.0, and verified with the real SDK: [`examples/openai-agents/`](examples/openai-agents/) is a forty-line agent whose `npm test` ran, whose `.npmrc` read was refused with the reason handed back to the model, and whose `rm -rf build` waited on a person in the terminal.

**Verified against.** Each adapter was exercised in a live session against the release below; the recorded hook events are the fixtures in [`fixtures/hooks/`](fixtures/hooks/). What was found in those sessions is stated next to it, because it decides how the adapter answers.

| Runtime | Version tested | Date | What the session established |
|---|---|---|---|
| Claude Code | 2.1.282 | 2026-09 | PreToolUse decides; ask and deny honoured; outcome events attach to the decision. |
| Codex CLI | 0.155.1 | 2026-09-20 | No ask from a hook: block with exit 2 and a reason. Codex disables a hook until the person trusts it, silently; `apply_patch` arrives as text under `tool_input.command`. |
| Gemini CLI | 0.60.0 | 2026-09-23 | `ask` forces Gemini's own dialog even in YOLO mode, and again after "Allow for this session". Exit code 1 is an allow; a failed or timed-out hook is ignored, so every verdict is JSON on exit 0. |
| Cursor | 3.21.18 | 2026-09-23 | `preToolUse` fires first for every tool and can only allow or deny; a silent hook there blocks under failClosed. A skipped command is reported like a successful one. |
| OpenAI Agents SDK | `@openai/agents` 0.18.0 | 2026-09-23 | Input and output tool guardrails; `onAsk` routes approvals; one run per `run()`. |
| MCP gateway | protocol 2025-06 and 2026 elicitation | 2026-09-18 | Every `tools/call` judged; asks through elicitation where the client supports it. |

**Any MCP agent: the gateway.** Point the client at Yenop instead of at the tool server:

```json
{ "mcpServers": {
  "supabase": { "command": "yenop", "args": ["mcp", "--server", "supabase", "--", "npx", "-y", "@supabase/mcp-server"] }
} }
```

Yenop launches the real server, forwards every message, and runs a decision on each `tools/call`. Allowed calls go through untouched; blocked ones never reach the server, and the client gets a tool error with the reason. This is where the trusted-backend attacks land: an injected instruction telling the agent to dump a database through a Supabase server, or exfiltrate a repo through a GitHub server. The server would obey. The gateway does not. When a call needs a person, the gateway asks through the client using MCP elicitation, speaking both protocol generations; a client that cannot show forms gets `--on-ask block` or `--on-ask allow`. Under Claude Code the hook already gates MCP calls, so run the gateway there with `--on-ask allow`; it earns its keep with clients that have no hook.

## How it decides

```
action → budget breakers → permit policies → approval policies → receipt → allow / ask / deny
```

**Shell commands are parsed, not pattern-matched.** Yenop splits a command into programs and arguments, follows `sudo`, `xargs`, `bash -c`, `$(...)`, variables and redirects, ignores heredoc bodies and comments, and exposes facts like `context.shell.destructive`, `context.shell.secretPath`, `context.shell.opaque` and `context.shell.ops`. A README that mentions `rm -rf` is a write to a README; a public key is not a secret. Code handed to an interpreter is not read as shell but treated as opaque and judged by what it names, so obfuscation becomes the reason a person is asked. This is checked by property tests that generate about fourteen thousand disguised commands on every push, and by an adversarial harness that lets a real model try to find a route.

**Decisions look at the run, not only at the call.** A model that plans where nobody can see can split a harmful plan into steps that each look harmless: read a forum page, dump the environment, fetch a URL. Every run remembers two sticky facts, whether it has taken in **untrusted content** and whether it has touched **sensitive data**, and every call is described by its flow: does it reach an external host, send data out, change state. The baseline asks a person before any external network call once sensitive data is in play, and names the shape, untrusted input plus sensitive data plus a way out, as `lethal-trifecta` in the receipt. A run left idle expires, so a crashed session never taints a later one.

**An ask carries the run's history.** The person deciding cannot see the model's reasoning, so the prompt says which earlier steps made the run untrusted or sensitive and what it did just before. The receipt then records the answer, and whether the call went on to run or fail.

**Yenop protects itself.** An agent told "no" may be told, by whoever is manipulating it, to change the rules. So any change to Yenop's own files needs a person: the `.yenop` folders and policies, the mode, the daemon, and the hook registration files of every agent. Looking is free.

## Policies

Policies come in layers evaluated together: the **baseline** shipped in [`policies/`](policies/) and updated with each release, your **home** layer in `~/.yenop/policies/`, and a **project** layer committed with the code. Add a file to tighten. To loosen a baseline rule, switch it off by id with `"disabledPolicies": ["..."]`; the shipped files are never edited in place. Two folders, two questions: `permit/` asks "may this happen at all", `approve/` asks "must a person see it first". The vocabulary is frozen in [`policies/schema.cedarschema`](policies/schema.cedarschema) and every layer is validated against it on load. See [policies/README.md](policies/README.md).

**Fail closed.** Any evaluation error is a deny. A policy file that does not parse or does not match the vocabulary makes Yenop refuse every action in that project, naming the file and error, while keeping `yenop check`, `status` and `receipts` working so a person can fix it. A guard that cannot read its rules must not wave things through.

## Tamper-evident receipts

The receipts file is a hash chain: each line carries the hash of the line before it, so editing, deleting, or reordering any line is detectable.

```sh
yenop receipts --verify
```

reports an unbroken chain, or names the first broken line and exits non-zero. This turns the log from "trust us" into evidence a third party can check. It is local tamper-evidence, not a signature: it catches changes to the recorded history; anchoring the head against a wholesale rewrite is the control plane's job.

## What it protects against, and what it does not

A security tool should say both. Yenop governs agent execution on a machine you control.

**It protects against**

- tool misuse after a prompt injection: an agent convinced to act still has to pass a rule
- unauthorized destructive commands, and writes outside the project
- reads of secret files and credential stores, however the path is spelled or reached
- exfiltration paths: a credential over the network, a download piped into a shell, an outside call after sensitive data
- multi-step attack chains that look harmless one call at a time
- tool servers overreaching what they claimed to cover
- an agent editing Yenop's own rules or hook registration to switch it off
- runaway loops, by per-run budgets

**It does not claim to protect against**

- a person with root on the machine, or an attacker who already has it: they can remove Yenop like any other program
- a compromised operating system or a compromised Yenop binary
- vulnerabilities inside a tool that was legitimately allowed to run
- actions taken through a path Yenop is not hooked into, such as an agent Yenop does not yet support, or a runtime that ignores a hook by design (Codex, see above)
- a wholesale rewrite of the receipts file from scratch: the chain catches edits, deletions and reordering locally; anchoring the head against a full rewrite is the control plane's job

Yenop governs agent execution. It does not govern a compromised host.

## The daemon

Opening the policies, the Cedar engine and the state database costs about 100 ms from scratch. Yenop keeps a small resident service on `127.0.0.1` that holds everything warm and decides in about a millisecond.

| Path | Round trip | When |
|---|---|---|
| HTTP hook, posts straight to the daemon | ~1 ms | `yenop init --hook http` |
| Command hook, forwards over a raw socket | ~45 ms, almost all Node starting | default |
| Command hook, no daemon | ~120 ms, then it starts one for next time | fallback |

The command hook is the default because it cannot fail open: with no daemon it decides in-process. `yenop service install` hands the daemon to the operating system's supervisor (launchd on macOS, a systemd user service on Linux) so it stays up; do that before making the HTTP hook the default. The daemon serves every project, reloads within a second of a policy change, keeps its port and token across restarts, retires itself when Yenop is rebuilt, and binds only loopback behind a token.

## On-prem and offline

Yenop is built to run where you cannot reach a cloud. `npm run pack:offline` produces a self-contained bundle that installs on an air-gapped machine with only Node. Nothing it does requires a network. See [docs/on-prem.md](docs/on-prem.md) for the air-gapped install, running the daemon under a supervisor, platform support, and sending receipts to a SIEM.

## Try it safely

```sh
yenop playground     # ~/yenop-playground: fake infra, .env, build output, enforcement on
```

Open that folder in an agent and ask it to delete the build folder, run `terraform destroy`, or print the database password. Delete the folder when done.

## Formats and versions

| Thing | Version field | Where |
|---|---|---|
| Receipts | `v` and a `prev` hash on every line | `~/.yenop/receipts.jsonl` |
| Config files | `v` | `~/.yenop/config.json`, `<project>/.yenop/config.json` |
| State database | `PRAGMA user_version` | `~/.yenop/state.db` |
| Policy vocabulary | comment header | `policies/schema.cedarschema` |

A file newer than the running Yenop understands is an error, never a silent misread.

## Layout

```
src/core/       decision engine, Cedar evaluation, run state (SQLite), receipts (JSONL)
src/adapters/   one thin adapter per runtime, on a shared hook pipeline
src/daemon/     the resident decision service, its client, and the raw-socket fast path
src/viewer/     the read-only receipts page
src/cli/        the yenop command
policies/       the default policy pack and the vocabulary
fixtures/       hook events recorded from each runtime, replayed on every push
examples/       small agents with Yenop in front of them (OpenAI Agents SDK)
harness/        the adversarial harness: a real model as red-teamer
site/           yenop.com
```

Design references: OWASP AISVS control group C09, the MCP specification, Cedar, AuthZEN, RFC 8693.

## License

Yenop is source-available under the [Functional Source License, Version 1.1, with Apache 2.0 as the future license](LICENSE.md) (FSL-1.1-ALv2).

- You may read, install, run, modify and redistribute it, including inside your company and for your customers' internal use.
- You may not offer it, or something substantially similar built from it, as a competing commercial product or service.
- Every release becomes Apache 2.0 two years after it is published.

Organization features, such as shared approvals, central policy, cross-runtime receipts and the enterprise build, are separate commercial products. "Yenop" is a trademark; forks must use another name.

https://yenop.com
