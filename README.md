# Yenop

The layer between an AI agent and the systems it can touch.

Yenop decides which tool calls actually execute, who approved the ones that cannot be undone, how much a single run may cost, and keeps a receipt for every action. The model can be tricked. This layer cannot.

- **Badge:** per-tool least privilege, written as Cedar policy, enforced outside the model.
- **Sign-off:** irreversible actions pause for a person who sees the exact action.
- **Spending limit:** step and deny breakers scoped to one run, not one month.
- **Receipt:** an append-only record of every decision and the policy that made it.

Status: pre-alpha. Two enforcement points today: the Claude Code hook, and an MCP gateway that works for any MCP client (Cursor, Claude Desktop, custom agents). Next: adapters for the OpenAI Agents SDK, LangGraph and n8n. Same core, same policies, same receipts for all of them.

## Install

From npm, once published:

```sh
npm install -g yenop
yenop init            # sets up ~/.yenop and installs the Claude Code hook for the current project
```

From source, today:

```sh
npm install && npm run build && npm link     # makes the `yenop` command available on this machine
yenop init
yenop check                                  # every policy, every layer, checked against the vocabulary
yenop explain Bash '{"command":"terraform destroy -auto-approve"}'
```

When `yenop` is on the PATH, the hook is installed as `yenop hook claude-code`, so no machine-specific path ends up in any settings file.

From then on, every tool call Claude Code makes in this project passes through Yenop first:

| The agent tries | Yenop says |
|---|---|
| `npm test`, reading a source file | nothing; Claude Code's normal flow applies |
| `terraform destroy`, `DROP TABLE`, a forced push, writing outside the project, any MCP tool that writes | **ask**: Claude Code shows the exact action and waits for you |
| running a scanner, exploitation framework, credential cracker, or a reverse shell (`nmap`, `sqlmap`, `hashcat`, `bash -i >& /dev/tcp/...`) | **ask**: dual-use, so a person signs off |
| reading a private key or `.env`, piping a download straight into a shell, sending a credential over the network | **deny**: blocked, with the policy named |
| a run that has been denied 20 times, or has made 1,000 calls | **deny**: the breaker halts the run |

Receipts: `node dist/cli/main.js receipts --last 20`. Raw file: `~/.yenop/receipts.jsonl`.

Yenop only ever tightens. It never grants something Claude Code would have asked about.

## Any MCP agent: the gateway

The Claude Code hook covers Claude Code. The MCP gateway covers every agent that speaks MCP. Point the client at Yenop instead of at the tool server:

```json
{ "mcpServers": {
  "supabase": { "command": "yenop", "args": ["mcp", "--server", "supabase", "--", "npx", "-y", "@supabase/mcp-server"] }
} }
```

Yenop launches the real server, forwards every message, and runs a decision on each `tools/call`. Allowed calls go through untouched; blocked ones never reach the server and the client gets a tool error with the reason. This is where the trusted-backend attacks land: an injected instruction telling the agent to dump a database through a Supabase server, or exfiltrate a repo through a GitHub server. The server would obey. The gateway does not. A tool server's own `readOnlyHint` annotations are treated as untrusted, so the classification is Yenop's, not the server's.

When a call needs a person, the gateway asks the person through the client using MCP elicitation: the client shows a small form with the reason and the run's history, and an Allow or Deny choice. The gateway speaks both protocol generations, the 2025 flow where the server sends the question and the 2026 flow where the client retries the call carrying the answer. The answer is recorded on the receipt, and so is whether the call then ran or failed. A client that cannot show forms gets `--on-ask block` (the default fallback: the call is refused with the reason) or `--on-ask allow`.

Verified against the official filesystem server: the handshake, a 14-tool listing, reads through, writes stopped before the server sees them, and the stream healthy afterwards.

A note on scope: an MCP client can widen a server's reach. Claude Code advertises the project root to servers, and the official filesystem server honors that over its own arguments, so a server configured for one folder ends up serving the whole project. Yenop's checks are on the path being touched, not on what the server claims to cover, so reading `.env` through that server is still denied.

Under Claude Code the hook already sees every MCP call and asks first, so a gateway on the same server would ask a second time. There, run the gateway with `--on-ask allow` and let the hook be the approver, or skip the gateway. The gateway earns its keep with clients that have no hook.

## See it in one command

```sh
yenop demo
```

A scripted, deterministic walk through what Yenop does: safe work allowed, a secret-exfil attempt blocked, a multi-step plan caught by the run's history, a database dump held at the MCP gateway, and Yenop refusing to let the agent disable it. No AI agent, no network, no UI, and it touches nothing real. `docs/demo-script.md` is the talk track for showing it to someone.

## The daemon

Opening policies, the Cedar engine and the state database costs about 100 ms per call if done from scratch. Yenop keeps a small resident service on `127.0.0.1` that holds everything warm and decides in about a millisecond.

| Path | Round trip | When |
|---|---|---|
| HTTP hook, Claude Code posts straight to the daemon | ~1 ms | `yenop init --hook http` |
| Command hook, forwards to the daemon over a raw socket | ~45 ms, almost all of it Node starting | default |
| Command hook, no daemon running | ~120 ms, then it starts a daemon for next time | fallback |

`yenop daemon start | stop | status` manage it; `yenop init` starts it. `yenop service install` hands it to the operating system's own supervisor (a launchd agent on macOS, a systemd user service on Linux), which starts it at login and restarts it if it exits. Do that before making the HTTP hook the default, since only a supervised daemon is guaranteed to be up. It serves every project on the machine, reloads a project within a second of any policy or config change, keeps its port and token across restarts (`~/.yenop/daemon.key`, mode 600), and retires itself when Yenop is rebuilt or upgraded so old code never keeps answering. Requests need the token; only loopback is bound.

The command hook is the default because it cannot fail open: if the daemon is down, it decides in-process. The HTTP hook is faster but depends on the daemon being up, since Claude Code treats an unreachable hook as "no opinion". The safe way to use it:

```sh
yenop service install     # launchd or systemd keeps the daemon alive
yenop init --hook http    # warns if the daemon is not supervised
```

## Two modes

| Mode | What happens |
|---|---|
| `enforce` | decisions go back to the runtime: ask and deny take effect |
| `observe` | decisions are recorded in receipts only; nothing is blocked |

Observe mode is how you roll Yenop out: run it for a week, read the receipts, tune the policies, then switch to enforce. Set it per project in `<project>/.yenop/config.json`, per machine in `~/.yenop/config.json`, or for one command with `YENOP_MODE`. `node dist/cli/main.js status` shows what is active.

## Test it without touching your own work

```sh
node dist/cli/main.js playground     # creates ~/yenop-playground with fake infra, .env, build output, and enforcement on
```

Open that folder in Claude Code and ask it to delete the build folder, run terraform destroy, or print the database password. Delete the folder when done.

## How it decides

```
tool call → budget breakers → permit policies → approval policies → receipt → allow / deny / ask
```

Shell commands are parsed, not pattern-matched. Yenop splits a command into its programs and arguments, follows `sudo`, `xargs`, `bash -c` and `$(...)`, ignores heredoc bodies and comments, and exposes facts such as `context.shell.destructive`, `context.shell.pipesToShell`, `context.shell.secretPath`, `context.shell.ops` and `context.shell.programs`. A README that mentions `rm -rf` is a write to a README. A public key is not a secret. Secret-file patterns are configurable with `secretPatterns` in any `config.json`.

Decisions look at the run, not only at the call. A model that plans where nobody can see can split a harmful plan into steps that each look harmless: read a forum page, dump the environment, fetch a URL. So every run remembers two sticky facts, whether it has taken in **untrusted content** and whether it has touched **sensitive data**, and every call is described by its **flow**: does it reach an external host, send data out, change state. The baseline asks a person before any external network call once sensitive data is in play, even a plain GET, and names the full shape, untrusted input plus sensitive data plus a way out, as `lethal-trifecta` in the receipt. Calls to localhost and private ranges never count as external. Tune it with `trustedServers`, `sensitiveServers` and `sensitivePatterns` in any `config.json`.

An ask carries the run's history. The person deciding cannot see the model's reasoning, so the prompt says which earlier steps made the run untrusted or sensitive and what it did just before: "Earlier in this run the agent took in outside content at step 1 (WebFetch: https://forum.example.org/t/1) and touched sensitive data at step 2 (Bash: printenv | wc -l). Just before: 3 Read src/app.ts." The receipts then record the answer. Claude Code reports when a call ran, failed, or was refused by its own permission system, and Yenop writes that next to the ask. A person clicking Deny produces no event, so an ask followed by later steps with no run recorded reads "not run: rejected or abandoned". `yenop receipts` shows it on each line.

Yenop protects itself. An agent that is told "no" may be told, by whoever is manipulating it, to go and change the rules. So any change to Yenop's own files goes past a person: the `.yenop` folders, the policies in them, the mode, the daemon, and the `.claude/settings` files that keep the hook registered. Looking is free; `cat .yenop/config.json` and `yenop status` never ask.

Policies come in layers that are evaluated together: the **baseline** shipped in [`policies/`](policies/) and updated with each release, your **home** layer in `~/.yenop/policies/`, and a **project** layer in `<project>/.yenop/policies/` committed with the code. Add a file to tighten. To loosen a baseline rule, switch it off by id with `"disabledPolicies": ["..."]` in a `config.json`; the shipped files are never edited in place. Two folders, two questions: `permit/` asks "may this happen at all", `approve/` asks "must a person see it first". See [policies/README.md](policies/README.md) for the full contract. Any evaluation error fails closed to deny.

So does a policy file Yenop cannot load. If any layer contains a policy that does not parse or does not match the vocabulary, Yenop refuses **every** action in that project, names the file and the error in the refusal, and keeps `yenop check`, `yenop status` and `yenop receipts` working so a person can fix it. A guard that cannot read its rules must not wave things through; otherwise one bad write to a policy folder would switch the guard off. `yenop schema` prints the vocabulary with an example.

The names a policy can use are frozen in [`policies/schema.cedarschema`](policies/schema.cedarschema). Every policy in every layer is validated against it when loaded; a misspelled attribute is an error with a suggestion, and a policy that can never apply is rejected too. Arguments of tools not typed in the schema are reachable as tags: `context.call.getTag("repo") == "acme/prod"`.

## Formats and versions

| Thing | Version field | Where |
|---|---|---|
| Receipts | `v` on every line | `~/.yenop/receipts.jsonl` |
| Config files | `v` | `~/.yenop/config.json`, `<project>/.yenop/config.json` |
| State database | `PRAGMA user_version` | `~/.yenop/state.db` |
| Policy vocabulary | comment header | `policies/schema.cedarschema` |

A newer file than the running Yenop understands is an error, never a silent misread. Tenants have a stable id (`tn_` plus 26 characters) that never changes once issued; the name is free to change.

## Layout

```
src/core/       decision engine, Cedar evaluation, run state (SQLite), receipts (JSONL)
src/adapters/   one thin adapter per runtime; claude-code/ is the first
src/daemon/     the resident decision service, its client, and the raw-socket fast path
src/cli/        the yenop command
policies/       the default policy pack
```

Design references: OWASP AISVS control group C09, MCP spec 2026-07-28, Cedar, AuthZEN 1.0, RFC 8693.


## License

Yenop is source-available under the [Functional Source License, Version 1.1, with Apache 2.0 as the future license](LICENSE.md) (FSL-1.1-ALv2).

- You may read, install, run, modify and redistribute it, including inside your company and for your customers' internal use.
- You may not offer it, or something substantially similar built from it, as a competing commercial product or service.
- Every release becomes available under the Apache License 2.0 two years after it is published.

Organization features, such as shared approvals, central policy, cross-runtime receipts and the enterprise build, are separate commercial products. "Yenop" is a trademark; forks must use another name.

https://yenop.com
