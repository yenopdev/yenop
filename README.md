# Yenop

The layer between an AI agent and the systems it can touch.

Yenop decides which tool calls actually execute, who approved the ones that cannot be undone, how much a single run may cost, and keeps a receipt for every action. The model can be tricked. This layer cannot.

- **Badge:** per-tool least privilege, written as Cedar policy, enforced outside the model.
- **Sign-off:** irreversible actions pause for a person who sees the exact action.
- **Spending limit:** step and deny breakers scoped to one run, not one month.
- **Receipt:** an append-only record of every decision and the policy that made it.

Status: pre-alpha. First enforcement point: Claude Code. Next: an MCP gateway and adapters for the OpenAI Agents SDK, LangGraph and n8n. Same core, same policies, same receipts for all of them.

## Try it in two minutes

```sh
npm install && npm run build
node dist/cli/main.js init        # creates ~/.yenop with the default policies, installs the Claude Code hook for this project
node dist/cli/main.js check       # parses every policy
node dist/cli/main.js explain Bash '{"command":"terraform destroy -auto-approve"}'
```

From then on, every tool call Claude Code makes in this project passes through Yenop first:

| The agent tries | Yenop says |
|---|---|
| `npm test`, reading a source file | nothing; Claude Code's normal flow applies |
| `terraform destroy`, `DROP TABLE`, a forced push, writing outside the project, any MCP tool that writes | **ask**: Claude Code shows the exact action and waits for you |
| reading a private key or `.env`, piping a download straight into a shell | **deny**: blocked, with the policy named |
| a run that has been denied 20 times, or has made 1,000 calls | **deny**: the breaker halts the run |

Receipts: `node dist/cli/main.js receipts --last 20`. Raw file: `~/.yenop/receipts.jsonl`.

Yenop only ever tightens. It never grants something Claude Code would have asked about.

## How it decides

```
tool call → budget breakers → permit policies → approval policies → receipt → allow / deny / ask
```

Policies live in `~/.yenop/policies/` (copied from [`policies/`](policies/) on init) and optionally in `<project>/.yenop/policies/`. Two folders, two questions: `permit/` asks "may this happen at all", `approve/` asks "must a person see it first". See [policies/README.md](policies/README.md) for what a policy can see. Any evaluation error fails closed to deny.

## Layout

```
src/core/       decision engine, Cedar evaluation, run state (SQLite), receipts (JSONL)
src/adapters/   one thin adapter per runtime; claude-code/ is the first
src/cli/        the yenop command
policies/       the default policy pack
```

Design references: OWASP AISVS control group C09, MCP spec 2026-07-28, Cedar, AuthZEN 1.0, RFC 8693.

https://yenop.com
