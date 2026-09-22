# Yenop with the OpenAI Agents SDK

A minimal agent built with `@openai/agents`, with Yenop judging every tool call before it runs.

```sh
cd examples/openai-agents
npm install

cd /path/to/some/project          # Yenop judges relative to the project the agent works in
export OPENAI_API_KEY=sk-...
node /path/to/yenop/examples/openai-agents/agent.mjs "Run npm test."
```

Without arguments it runs three prompts: an ordinary command (allowed silently), a read of `.npmrc`
(refused, with the reason handed back to the model), and a destructive command (put to you in the terminal
before it runs). Afterwards, `yenop receipts --last 10` shows the decisions and what became of the ask.

What the example shows, and what your own agent needs:

- `tools` tells Yenop what each of your tools can do (`shell`, `read`, `write`, `web`, `mcp`), since a tool
  named `run_shell` is just a function to the SDK. A tool you leave out is judged as unknown and held for a person.
- `onAsk` is where an ask reaches a person: here a terminal prompt; in your product, Slack, a queue, an approval UI.
  Without it, an ask is refused, never let through.
- Each `run()` is one Yenop run, so the run-level rules (untrusted content in, sensitive data touched, then an
  outside call) follow the agent across its tool calls.
