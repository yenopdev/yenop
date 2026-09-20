# Roadmap: every agent, and hardening

Written for: the people building Yenop. This is the working plan, not marketing. It has two parts: how Yenop
covers every agent a customer might run, and how it answers the substantive criticisms it has received, each
with a solution pattern rather than a wish.

The one sentence the plan serves: **the local-first, independent policy and audit layer across every AI agent
a team runs; nothing leaves your machine.** Every item below either widens "every agent" or hardens "policy
and audit" enough to be trusted.

---

## Part 1. One engine, every agent

### The principle

Do not build one integration per agent. Build one canonical **Action**, and a thin adapter per runtime that
translates that runtime's event into an Action. The engine, the policies, the run state and the receipts never
know which agent produced the Action. A rule written once applies to all of them, and one receipt trail covers
all of them. That cross-agent property is the product; no single agent vendor will ever ship it.

Four transports carry an Action into the engine, and every runtime fits one of them:

| Transport | How it works | Fits |
|---|---|---|
| **Hook** | the runtime calls `yenop hook <runtime>` before acting; stdin JSON in, verdict out | coding agents with a hook system |
| **Gateway** | Yenop sits between the agent and its tool server and gates each call | anything that speaks MCP |
| **SDK** | a library the agent's own code calls around each tool invocation | agent frameworks |
| **API** | HTTP `decide` on the daemon, with a receipt back | custom and in-house agents, any language |

### The canonical Action (integration contract v1)

Today the engine takes a `DecisionRequest` and derives flow and shell facts. Formalize and version it as the
public contract so adapters and customers build against something stable:

```
Action {
  runtime         claude-code | cursor | codex | gemini | mcp | openai-agents | langgraph | http | ...
  agent           the agent's name or id as the runtime reports it
  principal       the human (or service) the agent acts for; may be unknown
  delegation      chain of principals/agents when a sub-agent acts for an agent (may be empty)
  run             session id; Yenop keys run state on it
  tool            name, kind (read/write/shell/web/mcp/unknown), readOnly, server
  operation       parsed intent when known: git:push, rm:-r, sql:delete, mcp:write ...
  target          paths, hosts, resources touched
  args            the raw arguments (trimmed for receipts)
  environment     cwd, project, permission mode
  sideEffect      none | local | outbound | destructive     (derived)
  reversibility   reversible | irreversible | unknown        (derived)
  dataClass       none | sensitive | secret                   (derived)
  network         none | internal | external                  (derived)
}
```

`principal` and `delegation` are declared now and filled where the runtime provides them; enforcement rules
on them come later (Part 2, item 7). Declaring the fields early keeps the schema stable.

### Adapter matrix

Verified means the integration surface was checked against the runtime's documentation in September 2026.

| Runtime | Surface | Status | Notes |
|---|---|---|---|
| Claude Code | PreToolUse / PostToolUse hooks | **done** | command and HTTP hooks, outcomes recorded |
| MCP, stdio | gateway | **done** | any MCP client; elicitation for approvals |
| MCP, Streamable HTTP | gateway | todo | second transport; needed for hosted tool servers |
| Cursor | `hooks.json`: beforeShellExecution, beforeMCPExecution, beforeReadFile, preToolUse; returns allow/ask/deny; `failClosed` | **done** | shared hook pipeline; fail-closed; file edits deny-only (Cursor cannot ask there) |
| Codex CLI | `hooks.json` PreToolUse/PostToolUse, enabled by default | verified, todo | **shell events only**; file and MCP calls go through the gateway |
| Gemini CLI | `settings.json` BeforeTool / AfterTool with matchers | verified, todo | returns deny decisions with a reason |
| GitHub Copilot agent | agent firewall, sandboxes; third-party hook surface unclear | verify | likely gateway-only for MCP tools |
| OpenAI Agents SDK | tool guardrails / on-tool-start callbacks | todo | SDK adapter, TypeScript and Python |
| LangGraph | tool-node wrapper, interrupt for ask | todo | SDK adapter |
| n8n | community node calling the API | todo | |
| Custom / in-house LLM agents | HTTP `decide` + thin SDKs | todo | the universal path; answers "we have our own model" |
| Enterprise agent platforms (Copilot Studio / Agent 365, Agentforce, Bedrock AgentCore, Azure AI Foundry) | via the MCP gateway where they call MCP tools; via each platform's policy extension points where they exist | partial, roadmap | be honest with customers: coverage is through MCP first |

### Install experience

- `yenop init` detects every installed agent (Claude Code, Cursor, Codex, Gemini) and installs the hook for
  each in one command. `yenop status` shows which agents are covered and which are not.
- One `yenop hook <runtime>` entry point with a per-runtime translator, sharing the daemon fast path.
- The gateway gains an HTTP transport and a config that lists the MCP servers a project uses, so
  `yenop init` can rewrite the client's MCP config to route through Yenop.

### Order and reasons

1. Cursor, Codex, Gemini hooks and auto-detecting init. Cheapest, and it makes "every coding agent" literally
   true, which the positioning depends on.
2. MCP Streamable HTTP. Widens the gateway to hosted tool servers.
3. HTTP API plus TypeScript and Python SDKs. The universal path for custom agents and in-house models.
4. OpenAI Agents SDK and LangGraph adapters on top of the SDK.
5. Enterprise platforms as customers ask, through MCP first.

---

## Part 2. Hardening: the criticisms, each with a solution pattern

### 1. Approval fatigue

Criticism: if Yenop asks too often, developers click through or turn it off. This is the biggest product risk.

Pattern: **make ASK rare, sticky, and measured.**
- Risk tiers in the baseline: silent for reversible local work, ask only for irreversible, outbound, or
  sensitive-after-untrusted. Audit the baseline against a corpus of real sessions and cut every ask that a
  reasonable developer would always approve.
- "Remember this": an approval can be remembered for the session, the project, or a pattern (for example
  `npm install *` in this repo), stored as a project policy the person can read and revoke. One answer, not
  ten.
- Auto-mode safety: when the agent runs without prompts, Yenop still holds the irreversible and outbound
  actions and lets everything else through. The pitch is "stay in auto mode safely", not "another dialog".
- A fatigue metric in receipts: asks per hundred calls, and how many were approved. `yenop report` shows it,
  and a rising number is a bug in the baseline.

Done when: a week of normal coding on a real project produces fewer than one ask per fifty calls, and every
ask that occurred was one the developer agrees should have been asked.

### 2. The shell-parsing treadmill

Criticism: attackers obfuscate commands (`eval`, base64, string construction, exotic piping) and a parser can
never keep up.

Pattern: **do not try to win by parsing. Make opacity itself a signal, and catch effects, not just text.**
- Layer 1, the parser: keeps handling the common shapes well (it already handles quotes, pipes, chains,
  redirects, `$(...)`, `sudo`, `xargs`, `bash -c`, heredocs, `@file` references).
- Layer 2, opacity rule: any command whose executed content cannot be seen is classified **opaque** and treated
  as untrusted: `eval`, `base64 -d | sh`, `xxd -r`, `printf` with escape-built strings piped to an
  interpreter, nested `$(...)` beyond a depth, an interpreter reading from a pipe or a variable, `curl | sh`
  (already denied). Opaque earns an ask in the baseline and a deny in a strict profile. The attacker's
  obfuscation becomes the reason they get caught.
- Layer 3, effects: whatever the command decodes into, exfiltration still needs the network and destruction
  still needs a destructive operation. The run-state rules (sensitive then external, untrusted then outbound)
  and the network facts catch the effect even when the text was hidden. This is why the run-level model
  matters more than the parser.
- Layer 4, the OS: where the runtime offers a sandbox (Claude Code, Cursor, Codex all do now), Yenop is a
  policy layer above it, not a replacement. Say so plainly: the parser is not the security boundary; it is
  one of four.
- A regression corpus: every bypass found, in testing or in the wild, becomes a test case. The parser's job is
  to never regress on a known trick, not to predict every future one.
- A Windows dialect: PowerShell and cmd do not use backslash escapes, quote differently, and pass paths as
  `-Path` arguments. Windows paths are recognized today; the dialects are not. Until they are, Windows is not
  supported for the shell surface (file, MCP and path checks already work there).

Done when: the obfuscation corpus (eval, base64, printf-escapes, nested substitution, variable-built
commands, interpreter-from-pipe) is entirely classified opaque or caught by effect, and the corpus is
part of the test suite.

### 3. State drift and phantom runs

Criticism: a crashed or abandoned session could leave "dirty" run state that a later session inherits,
causing false positives.

Pattern: **runs expire, and sessions end explicitly.**
- Run facts carry a last-activity time; a run idle longer than a configurable window (default 2 hours) is
  treated as ended, and a new call on that session id starts a fresh run.
- Where the runtime signals session end (Claude Code's Stop and SessionEnd hooks; equivalents elsewhere),
  Yenop closes the run.
- `yenop runs` lists active runs with their facts and lets a person clear one.
- Run state is keyed by session id and start time, never by project alone, so two sessions on one repo never
  share facts.

Done when: a run left dirty and then idle past the window produces no ask on the next fresh session, and a
test proves it.

### 4. The daemon under endpoint security

Criticism: enterprise endpoint tools (EDR) may kill an unrecognized resident daemon or block loopback ports.

Pattern: **the daemon is an accelerator, never a dependency.**
- The command hook already decides in-process when the daemon is absent. Make that path first-class: fast
  startup, same policies, a receipt that notes it ran without the daemon.
- Detect a blocked loopback (connection refused or reset within a few milliseconds) and degrade without
  retry storms.
- Document EDR allowlisting: a stable install path, a stable service label, and a signed binary once the
  company can sign.
- The HTTP hook stays opt-in, because it is the one path that needs the daemon.

Done when: with the daemon forcibly killed and its port blocked, every decision still returns correctly with
acceptable latency, and the receipts say how it ran.

### 5. Claims and positioning

Criticism: "the model can be tricked, this layer cannot" overclaims; the README explains too much too early.

Pattern: **claim only what a rule can prove.**
- Replace the slogan with: **a model's decision is never the final authorization decision.** Every claim in
  the README must be something the test suite demonstrates.
- Rewrite the README above the fold to the one sentence, the three pillars (one policy and one record across
  every agent; makes auto mode safe; nothing leaves your machine), a 30-second demo, then why, then how.
  The technical depth moves below.
- Cedar, the trifecta rule, and the MCP gateway are described as implementation, never as the reason to
  choose Yenop.

### 6. Tamper-evident receipts, and a receipt standard

Criticism: an audit trail that can be edited is not evidence.

Pattern: **hash-chain the file; version the schema; make it exportable.**
- Each receipt carries the hash of the previous receipt; `yenop receipts --verify` walks the chain and reports
  the first break. A receipt then answers "why did this action happen" in a way a third party can check.
- Publish the receipt schema as a versioned document alongside the policy vocabulary, so a customer's SIEM or
  auditor can consume it without Yenop.
- Export: `yenop receipts --export` writes a signed bundle for a time range.

Done when: editing any line of the receipts file is detected by `--verify`, and the schema is documented.

### 7. Principal and delegation

Criticism: enterprises will ask "on whose behalf is this agent acting", and sub-agents delegate.

Pattern: **carry identity now, enforce it later, never invent it.**
- The Action carries `principal` and `delegation` from the first release of the contract. Runtimes that know
  the human fill it; others leave it unknown.
- Policies can reference principal and delegation depth once they are populated, for example "a sub-agent
  more than two hops from a person may not perform outbound writes".
- Identity comes from the customer's identity provider, consumed as a token, never from the model's own
  claims. Yenop enforces what an identity may do; it does not mint identities.

Done when: a request carrying a delegation chain is recorded on the receipt, and one baseline rule uses
delegation depth.

### 8. The observe-to-enforce report

Criticism (an opportunity, not a flaw): the best onboarding story is "install, see what would have been
blocked, then turn enforcement on".

Pattern: **make observe mode produce a report a person wants to show their boss.**
- `yenop report` over an observe-mode period: actions that would have been blocked, that would have needed a
  person, secrets touched, external hosts contacted, per agent and per project. Plain text and a page in the
  viewer.

### 9. Unicode and path normalization

Criticism (from our own review): a path that looks like `.env` using different Unicode code points could slip
past the secret-file match.

Pattern: normalize paths (NFC, strip zero-width and bidirectional control characters, fold confusable
characters in file names) before matching secret patterns, and add the cases to the test suite.

### 10. Localization

Criticism: the text a person sees is English only.

Pattern: message catalogs for the ask prompt, the viewer, and the demo; Turkish first. Enforcement is already
language-independent because it reads actions, not words.

### 11. Metrics that prove the product

Coverage: which agents on the machine are hooked. Fatigue: asks per hundred calls. Catches: denies and
asks by rule. All derived from receipts, all shown by `yenop status` and `yenop report`, so the product
demonstrates its own value.

### 12. Company readiness (not code)

Enterprise procurement rejects an unfunded vendor with no security attestation. Start SOC 2 and ISO 42001
readiness early: written policies, access control, a vulnerability disclosure process, dependency
scanning in CI. These do not need to be complete to start a pilot; they need to be underway.

---

## Part 3. Sequencing

**Phase A, foundations of the claim (first).** Positioning and claims (5). Cursor, Codex, Gemini hooks and
auto-detecting init (Part 1, step 1). Hash-chained receipts and schema (6). Run expiry (3). These make the
one sentence true and honest.

**Phase B, trust under pressure.** Opacity rule and obfuscation corpus (2). Fatigue reduction and metrics
(1, 11). Daemon-optional hardening (4). Unicode normalization (9). MCP HTTP transport. Observe report (8).

**Phase C, every agent, every language.** HTTP API and SDKs, then OpenAI Agents SDK and LangGraph adapters
(Part 1, steps 3 and 4). Principal and delegation populated and one rule (7). Turkish localization (10).

**Phase D, the team layer.** The control plane re-scoped to team scale with self-serve onboarding:
cross-agent receipts, approvals, central policy, single sign-on. Enterprise platform adapters as customers
ask. Company readiness (12) runs in parallel from Phase A.

Each phase ends with something demonstrable, and Phase A alone changes what Yenop can truthfully say.
