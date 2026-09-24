# Security

Yenop is a security tool, so a flaw in it matters more than a flaw in most software. Please tell us
privately, and we will fix it quickly and credit you.

## Reporting a vulnerability

Email **security@yenop.com**. Please do not open a public issue or discussion for a bypass until it is fixed.

Include what you can of:

- the Yenop version (`yenop version`) and the runtime and its version (Claude Code, Cursor, Codex CLI, Gemini CLI, the OpenAI Agents SDK, an MCP client)
- the operating system
- reproduction steps: the prompt or the exact tool call, the policy in effect (`yenop status`, `yenop check`), what Yenop answered and what you expected
- the impact: what an agent could do that it should not
- receipts or hook recordings if they contain nothing you would not want us to see (`yenop receipts --last 20`; `YENOP_RECORD_HOOKS` files can contain file contents)

## What to expect

- An answer as soon as we see the report, within one working day at most.
- A fix for a confirmed bypass in the next release, usually within days, with the recorded event added to the test fixtures so it cannot come back.
- Credit in the release notes, unless you prefer not to be named.
- Coordinated disclosure: we ask that you give us the time to ship the fix before the details are public.

## Scope

In scope: anything that lets an agent perform an action Yenop's baseline says it should deny or hold, without a person seeing it. Examples: a way of spelling a command or path that the parser does not recognise, a runtime event the adapter does not judge, an ask that becomes an allow, a receipt that can be altered without `yenop receipts --verify` noticing, or Yenop's own files changed by an agent without an ask.

Out of scope, by design (see the threat model at https://yenop.com/security/ and in the README): a person with root on the machine, a compromised operating system or Yenop binary, vulnerabilities inside a tool Yenop legitimately allowed, actions through a path Yenop is not hooked into, and a runtime that ignores a failed hook by its own design.

## Supported versions

The developer preview is supported on its latest release only (currently the 0.1 line). Fixes ship as new versions; we do not backport.
