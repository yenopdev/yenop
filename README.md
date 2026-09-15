# Yenop

The layer between an AI agent and the systems it can touch.

Yenop decides which tool calls actually execute, who approved the ones that cannot be undone, how much a single run may cost, and keeps a receipt for every action. The model can be tricked. This layer cannot.

- Badge: per-tool least privilege, written as policy, enforced outside the model.
- Sign-off: single-use human approval bound to the exact rendered action.
- Spending limit: step, recursion and cost breakers scoped to one run, not one month.
- Receipt: an audit record that survives across Claude, OpenAI, MCP and agent-to-agent hops.

Status: pre-alpha. First enforcement points: Claude Code hooks and a local MCP gateway.

https://yenop.com
