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
- Every policy has an `@id`. Evaluation errors fail closed. The Claude Code adapter only tightens: it prints nothing on allow.
- This repo runs its own hook (`.claude/settings.local.json`, ignored by git). If a change breaks the hook, Claude Code in this repo will feel it first. Shell commands whose heredoc text mentions secret paths or pipe-to-shell will be denied; write such content with the file tool instead.

## Working agreements
- Commit or push only when Ertunç asks.
- Research and decisions live in `docs/`. The evidence dossier is at https://claude.ai/artifact/AmGhRXB8JTJSZSvXg4d4TX
