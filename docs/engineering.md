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

## MCP gateway
- `src/adapters/mcp/gateway.ts` is the transport-agnostic core (`gateClientMessage`, `pumpGateway`); `run.ts` wires stdio to a spawned server. stdio is newline-delimited JSON-RPC, one message per line. Only `tools/call` is gated; every other message passes.
- A blocked call is answered to the client as a tool error (`isError: true`) and never written to the server's stdin. This is the security invariant: test it stays true.
- The tool name in the gateway is the bare MCP tool; `mcpToolRef` builds the `mcp` ToolRef. The server's annotations are not trusted.
- One run per gateway process. MCP carries no cross-server session id, so run facts are per-server-session; correlating across servers needs a client-supplied run id, which MCP does not have yet.
- Approval over MCP uses elicitation, both generations. 2025 (`initialize` declares `capabilities.elicitation`): the gateway holds the call and sends `elicitation/create` with a string id prefixed `yenop:`, so it never collides with the real server's own requests; the client's reply to that id is consumed, never forwarded. 2026 (`_meta["io.modelcontextprotocol/clientCapabilities"].elicitation` on the call): the gateway answers `resultType: "input_required"` with one `inputRequests` entry and a random `requestState` nonce; the retry must carry the same nonce, the same tool and canonicalized arguments, within 10 minutes; the nonce is single use; `inputResponses` and `requestState` are stripped before the call reaches the real server, which never asked for them. No decision is re-run on the retry; the outcome lands on the original call id.
- The question omits `mode` and uses a plain `enum`, the one form both generations render.
- Every forwarded ask (approved, or `--on-ask allow`) is tracked by the server's response id and the outcome is recorded from the reply: `isError` or a JSON-RPC error means failed. Refusals at the gateway record `denied` themselves. Nothing about an MCP ask is left to `answersFor` inference.
- Proven against the real filesystem server as a client of each generation on 2026-09-19.
- Proven against `@modelcontextprotocol/server-filesystem` 0.2.0 on 2026-09-19. Its 14 tool names drove the read heuristic in `src/core/tools.ts`; when adding a server, run its `tools/list` names through `classifyTool` and fix misses there, never per server.
- Double gating: Claude Code's hook sees `mcp__server__tool` before the gateway does. Document `--on-ask allow` for that combination rather than building dedup.

## Approvals and answers
- `explainAsk` in `src/core/engine.ts` builds the history sentence from the step history in the state store (`run_steps`, STATE_VERSION 3). Keep it one paragraph: Claude Code shows the reason as plain text.
- Outcome receipts (`kind: "outcome"`) are written only for calls Yenop asked about, once per call, linked by `decisionId`. Decision receipts carry `kind: "decision"`; lines without `kind` are older decisions.
- Claude Code events: `PreToolUse` decides and blocks; `PostToolUse`, `PostToolUseFailure` and `PermissionDenied` only report and are installed with `async: true` so the agent never waits on them. There is no event for a person clicking Deny; `answersFor` infers it.
- Any CLI path that writes files must be awaited before `process.exit`. The playground lost its hook registration to that race once.

## Failing closed
- Three places can fail: evaluating a policy, loading policies, and Yenop itself. All three end in deny when the mode is enforce. `openYenop` never throws on bad policies; it returns an instance with `policyError` whose every decision is `breaker:policies-invalid`. The hook command turns any unexpected exception into a deny with exit 2, because Claude Code reads every other exit code as "no opinion".
- The CLI must stay usable in the broken state. Never make `check`, `status`, `receipts` or `schema` depend on policies loading.
- Found in manual testing on 2026-09-18: an agent wrote a well-meant but invalid policy, and the hook's exit 1 let a destructive command through. Keep the regression tests in `sequence.test.ts` and `server.test.ts`.

## Self-protection
- `isControlPlanePath` in `src/core/shell.ts` defines Yenop's own files: any `.yenop/` folder and `.claude/settings(.local).json`. The baseline policy `changes-to-yenop-itself` asks a person before any tool writes them, before a shell command that is not plain viewing touches them, and before `yenop daemon stop|run` or `yenop init`.
- When a new adapter registers Yenop somewhere else (another runtime's config file), add that path here in the same change.
- Never add a baseline rule that lets an agent loosen the guard without a person.

## Sequence rules
- Run facts (`untrusted`, `sensitive`, `outbound`, `destructive`) live in the state store and are sticky for the run. Only calls that were not denied leave a mark.
- `flowOf` in `src/core/engine.ts` is the single place that maps a tool call to flow facts. A new adapter or tool kind extends it there, never in policies.
- Internal hosts (loopback, RFC 1918, `.local`, `.internal`) are not external. An undeterminable host is treated as external.
- Receipts record `flow` and `runBefore`, so an auditor can see why a sequence rule fired without replaying the run.

## Service (launchd / systemd)
- `src/daemon/service.ts` writes the unit and loads it. The unit MUST invoke node by absolute path plus the CLI's absolute path: launchd and systemd user services run with a minimal PATH, so the CLI's `#!/usr/bin/env node` shebang and a bare `yenop` both fail with exit 127. Found the hard way on 2026-09-18.
- Prefer a stable node symlink (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`) over `process.execPath`, which on Homebrew is a version-pinned Cellar path that breaks on a Node upgrade. After a Node major move the user re-runs `yenop service install`.
- KeepAlive/Restart=always plus the daemon's self-exit-on-rebuild means a rebuild is picked up automatically: the daemon exits, the supervisor restarts it on the persisted port. There is a sub-second window during a rebuild where an HTTP hook call can fail open; document it, do not engineer a handoff yet.

## Viewer
- `src/viewer/server.ts` is a standalone read-only HTTP server (`yenop viewer`), on purpose not part of the daemon: it must never touch the decision hot path, and it should run without a daemon. `viewerPayload` is pure and tested; the page is one self-contained HTML string with no external scripts or fonts.
- It binds 127.0.0.1 and rejects any request whose `Host` header is not localhost, the standard DNS-rebinding guard, so a web page cannot read the receipts by pointing a name at 127.0.0.1. No auth beyond that: the data is local and read-only.
- It is the first surface of the paid control plane. Keep it dependency-free.

## Daemon rules
- The command hook's path to the daemon (`src/daemon/fast.ts`, `hook.ts`) imports only `node:net`, `node:fs`, `node:os`, `node:path`. Loading `node:http` costs 20 ms. Do not add imports there.
- `src/cli/main.ts` loads each subcommand's modules lazily for the same reason.
- `/health` reports the build the daemon booted from, never a fresh stat. The daemon exits when its own file changes on disk.
- Port and token persist in `~/.yenop/daemon.key`. Never regenerate them on restart; HTTP hooks depend on them.
- Any hook path must fail toward "Claude Code's own flow applies", never toward an accidental block, and never toward a silent allow of something Yenop would have denied when Yenop is reachable.

## Running Yenop on this repository
- The tracked `.claude/settings.json` runs the Yenop hook in observe mode (`.yenop/config.json`): every tool call is decided and recorded, nothing is blocked. `yenop status` shows the active mode.
- To test enforcement, never flip this repo to enforce. Run `yenop playground` and open `~/yenop-playground`.
- Receipts from observe mode are free test data for policy tuning: `yenop receipts`.

## Secrets
Never in the repo, never in documentation, never in system prompts. Use `.env` (ignored) or the OS keychain.
