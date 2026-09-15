# Yenop

Deterministic control plane for AI agents: tool-call authorization, human approval on irreversible actions, run-scoped budgets, identity propagation, receipts for every action. Domain: yenop.com.

## Isolation rules (this Mac also hosts an unrelated project, DalisPlatformu)
- This repo has its own git identity. `user.name` is set locally; `user.email` must be a Yenop address set with `git config --local`. The pre-commit hook refuses commits carrying the DalisPlatformu email or no email.
- GitHub access is only through the SSH alias `github-yenop` (key `~/.ssh/id_ed25519_yenop`). Repo-local `url.insteadOf` rewrites any github.com remote to that alias. Never add an HTTPS remote.
- Do not run the `gh` CLI in this repo. It is logged into the other project's account. Add a Yenop account with `gh auth login` and `gh auth switch` before any use, and confirm the active account first.
- Never change global git config, `~/.ssh/config` entries for other hosts, or anything under the other project's directories.
- Secrets never go in the repo, in CLAUDE.md, or in system prompts. Use `.env` (ignored) or the OS keychain.

## Product spec anchors
- OWASP AISVS control group C09 is the spec and the test plan.
- MCP spec 2026-07-28 for gateway behavior; Cedar for policy; AuthZEN 1.0 for the decision API; RFC 8693 for delegation chains.
- Success metric is containment rate under adaptive attack with utility preserved, never detection rate.

## Build and test
- `npm run build` compiles to `dist/`; `npm test` runs vitest; `npm run typecheck` for types only.
- TypeScript, ESM, Node 22+. Cedar via `@cedar-policy/cedar-wasm` (nodejs build). Run state uses `node:sqlite`. No other runtime dependencies without a reason written in the PR.
- Policies are layered: baseline (shipped, in `policies/`), home (`~/.yenop/policies`), project (`<repo>/.yenop/policies`), plus `disabledPolicies` in config. Never make init copy the baseline again; customers must never need to edit shipped files. Every policy has an `@id`. Evaluation errors fail closed.
- The policy vocabulary in `policies/schema.cedarschema` is a public contract: renames and removals are breaking changes, additions must be optional. Every policy is validated against it at load.
- Shell commands are parsed by `src/core/shell.ts` into facts; never add text-glob rules on `context.args.command` to the baseline again.
- Receipts, config files and the state database carry a version (`RECEIPT_VERSION`, `CONFIG_VERSION`, `STATE_VERSION`). Bump on any shape change and write the migration.
- Tenants are `{ id, name }`; ids are `tn_` plus 26 chars, issued at init, never changed. Requests do not carry a tenant; the engine instance does. The Claude Code adapter only tightens: it prints nothing on allow.
- This repo runs its own hook (tracked `.claude/settings.json`) in **observe mode** (`.yenop/config.json`): every tool call is decided and recorded, nothing is blocked, so development is never interrupted. Check with `node dist/cli/main.js status`.
- To test enforcement, never flip this repo to enforce. Run `node dist/cli/main.js playground` and open `~/yenop-playground` in Claude Code; that folder is in enforce mode with fake infrastructure to act on.
- Receipts from observe mode are still useful: `node dist/cli/main.js receipts` shows what Yenop would have done to our own sessions, which is free test data for policy tuning.

## Working agreements
- Commit or push only when Ertunç asks.
- Research and decisions live in `docs/`. The evidence dossier is at https://claude.ai/artifact/AmGhRXB8JTJSZSvXg4d4TX
