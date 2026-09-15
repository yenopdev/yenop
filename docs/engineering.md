# Engineering notes

## Build and test
- `npm run build` compiles to `dist/`; `npm test` runs the suite; `npm run typecheck` checks types only.
- TypeScript, ESM, Node 22+. Cedar via `@cedar-policy/cedar-wasm` (nodejs build). Run state uses `node:sqlite`. No other runtime dependencies without a written reason in the change.

## Contracts that must not drift
- `policies/schema.cedarschema` is the policy vocabulary and a public contract: renames and removals are breaking changes, additions must be optional. Every policy layer is validated against it at load.
- Shell commands are parsed by `src/core/shell.ts` into facts. Baseline policies never match text patterns against `context.args.command`.
- Receipts, config files and the state database carry a version (`RECEIPT_VERSION`, `CONFIG_VERSION`, `STATE_VERSION`). Bump on any shape change and write the migration.
- Tenants are `{ id, name }`; ids are `tn_` plus 26 characters, issued at init, never changed. Requests do not carry a tenant; the engine instance does.
- Policies are layered: baseline (shipped, in `policies/`), home (`~/.yenop/policies`), project (`<repo>/.yenop/policies`), plus `disabledPolicies` in config. Init never copies the baseline; users never edit shipped files.
- Every policy has an `@id`. Evaluation errors fail closed. The Claude Code adapter only tightens: it prints nothing on allow.

## Running Yenop on this repository
- The tracked `.claude/settings.json` runs the Yenop hook in observe mode (`.yenop/config.json`): every tool call is decided and recorded, nothing is blocked. `yenop status` shows the active mode.
- To test enforcement, never flip this repo to enforce. Run `yenop playground` and open `~/yenop-playground`.
- Receipts from observe mode are free test data for policy tuning: `yenop receipts`.

## Secrets
Never in the repo, never in documentation, never in system prompts. Use `.env` (ignored) or the OS keychain.
