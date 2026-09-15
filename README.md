# Yenop

The layer between an AI agent and the systems it can touch.

Yenop decides which tool calls actually execute, who approved the ones that cannot be undone, how much a single run may cost, and keeps a receipt for every action. The model can be tricked. This layer cannot.

- **Badge:** per-tool least privilege, written as Cedar policy, enforced outside the model.
- **Sign-off:** irreversible actions pause for a person who sees the exact action.
- **Spending limit:** step and deny breakers scoped to one run, not one month.
- **Receipt:** an append-only record of every decision and the policy that made it.

Status: pre-alpha. First enforcement point: Claude Code. Next: an MCP gateway and adapters for the OpenAI Agents SDK, LangGraph and n8n. Same core, same policies, same receipts for all of them.

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
| reading a private key or `.env`, piping a download straight into a shell, sending a credential over the network | **deny**: blocked, with the policy named |
| a run that has been denied 20 times, or has made 1,000 calls | **deny**: the breaker halts the run |

Receipts: `node dist/cli/main.js receipts --last 20`. Raw file: `~/.yenop/receipts.jsonl`.

Yenop only ever tightens. It never grants something Claude Code would have asked about.

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

Policies come in layers that are evaluated together: the **baseline** shipped in [`policies/`](policies/) and updated with each release, your **home** layer in `~/.yenop/policies/`, and a **project** layer in `<project>/.yenop/policies/` committed with the code. Add a file to tighten. To loosen a baseline rule, switch it off by id with `"disabledPolicies": ["..."]` in a `config.json`; the shipped files are never edited in place. Two folders, two questions: `permit/` asks "may this happen at all", `approve/` asks "must a person see it first". See [policies/README.md](policies/README.md) for the full contract. Any evaluation error fails closed to deny.

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
src/cli/        the yenop command
policies/       the default policy pack
```

Design references: OWASP AISVS control group C09, MCP spec 2026-07-28, Cedar, AuthZEN 1.0, RFC 8693.

https://yenop.com
