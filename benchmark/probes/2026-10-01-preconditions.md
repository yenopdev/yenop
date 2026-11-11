# Phase 2A preconditions P1–P6: probe record, 2026-10-01

Scope: the six empirical preconditions in `docs/benchmark-design.md` section 10, for the Phase 2A runtimes only
(Claude Code, Gemini CLI, Codex CLI). No pilot run, no scenario, no methodology change. Every probe below ran on
this machine with no credentials of any kind: no key was present in the environment and nothing was copied from
the developer's real configuration. Where a probe needs a model call, it is marked UNKNOWN with the reason.

## Environment (identical for every probe)

| Item | Value |
|---|---|
| OS | macOS 26.6.2 (Darwin 25.6.0, arm64) |
| Node | v26.3.0 |
| Yenop | 0.1.2, repository `a475804` |
| Claude Code CLI | 2.1.287, installed today (`npm install -g @anthropic-ai/claude-code`; npm did not run its postinstall script under the allow-scripts policy, the binary runs) |
| Codex CLI | codex-cli 0.155.1 |
| Gemini CLI | 0.61.0 (`@google/gemini-cli`; the README's verified version is 0.60.0) |
| Cursor | out of scope (Phase 2B) |
| Credentials | none; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CODEX_HOME`, `GEMINI_CLI_HOME` all unset |

Evidence labels: **run** = observed by executing the runtime here; **source** = read in the installed
runtime's own code (Gemini CLI ships readable JavaScript); **docs** = the vendor's documentation, fetched today;
**UNKNOWN** = needs a model call or is not determinable without one.

Failure classes used below: methodology blocker · implementation blocker · runtime limitation · environment
limitation · documentation uncertainty.

---

## P1: environment pass-through to hooks and to the agent's shell

**Hypothesis.** The runtime passes the parent process environment (`YENOP_HOME`, `YENOP_NO_DAEMON`,
`YENOP_RECORD_HOOKS`, `HTTP_PROXY`, `PATH`) to (a) the hook subprocess and (b) the shell it spawns for the agent.

| Runtime | (a) hook subprocess | (b) agent shell | Evidence | Verdict |
|---|---|---|---|---|
| Gemini CLI 0.61.0 | env = `{...sanitizeEnvironment(process.env, cfg), GEMINI_PROJECT_DIR, GEMINI_PLANS_DIR, GEMINI_CWD, GEMINI_SESSION_ID, CLAUDE_PROJECT_DIR, ...hookConfig.env}`; `sanitizeEnvironment` returns a copy of `process.env` unless `enableEnvironmentVariableRedaction` is set or the process runs under GitHub CI; a hook definition may carry its own `env` block | shell env = sanitized `process.env` plus `GEMINI_CLI=1`, `TERM`, `PAGER`, `GIT_PAGER`; `PATH` is in the always-allowed set even under redaction | **source** (bundle `chunk-5FZXKDXH.js`, hook runner and `environmentSanitization.ts`) | **PASS (source)**; empirical confirmation pending a model run. The per-hook `env` block is a deterministic way to pin `YENOP_HOME` without relying on inheritance |
| Codex CLI 0.155.1 | "The parent environment is inherited"; hooks run with "the session cwd as their working directory" | not documented; Codex adds its own helper-binary directory to the agent's `PATH` ("PATH aliases" created under `codex_home`; refused under a temp dir in the P2 run) | **docs** (learn.chatgpt.com/docs/hooks) + **run** (stderr line about PATH aliases) | **PASS (docs)** for (a); **UNKNOWN** for (b): a benchmark `PATH` prefix may be re-ordered by Codex's own aliases. Needs the P3 probe prompt |
| Claude Code 2.1.287 | not documented | not documented | **docs** (hooks and tools references are silent) | **UNKNOWN**: documentation uncertainty; needs the probe hook and the probe prompt with a dedicated key |

Failure class where not PASS: documentation uncertainty (Claude Code), runtime behaviour to measure (Codex PATH).
Methodology change: none. The probe hook and probe prompt in the design remain the test.

## P2: HOME handling, isolation and credential persistence

**Hypothesis.** With `HOME` (or the runtime's own config-dir variable) pointed at an empty temporary directory
and no credentials, the runtime looks only there, fails cleanly, writes only there, and never falls back to the
developer's real login.

Commands (stdin closed, 45–60 s hard timeout, `PATH`/`TERM`/`LANG` only in the environment plus the variables
named):

```
HOME=<tmp>                 codex -a never exec --skip-git-repo-check --ephemeral -s read-only -C <tmp>/proj "say hi"
CODEX_HOME=<tmp2>          codex ... (real HOME)
HOME=<tmp>                 gemini -p "say hi"
CLAUDE_CONFIG_DIR=<tmp>    claude -p "say hi" --output-format json --permission-prompts none --max-turns 1   (no key)
CLAUDE_CONFIG_DIR=<tmp>    claude -p ... with ANTHROPIC_API_KEY=<deliberately invalid>, with and without --bare
```

| Runtime | Observed | Evidence | Verdict |
|---|---|---|---|
| Codex | Exit 1 after `401 Unauthorized` from `wss://api.openai.com/v1/responses`: it looked for auth under the temporary `HOME/.codex` and found none. `CODEX_HOME` is honoured the same way. **It wrote more than 5,000 files under the temporary home before any model call: a shallow git clone of a plugin marketplace into `.codex/.tmp/plugins/`, plus `.sandbox_migration`.** It also printed "Refusing to create helper binaries under temporary dir … (codex_home: …)". With stdin left open it blocks on "Reading additional input from stdin…" indefinitely; with stdin closed it proceeds | **run** | **PASS** for isolation and clean failure. **Finding:** the runtime itself performs network fetches and large writes at startup, with no credentials and no prompt. The benchmark's "nothing leaves the machine except the sink" statement is true of the agent's actions, not of the runtime's own traffic; the sink proxy may or may not see this traffic (UNKNOWN; Codex's proxy handling untested) |
| Gemini | Exit 41, "Please set an Auth method in your `<tmp>/.gemini/settings.json` or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA". Wrote only `.gemini/projects.json`, `.gemini/history/proj/.project_root`, `.gemini/tmp/proj/.project_root` | **run** | **PASS**. Tier-2 credentials (an environment key) are explicitly supported |
| Claude Code, no key | Exit 1 with a JSON result: `terminal_reason: "api_error"`, zero cost, zero tokens. The real `~/.claude/.credentials.json` and `~/.claude.json` mtimes were unchanged. Files written under the temporary config dir: `.claude.json`, a backup of it, `.last-cleanup`, and a transcript `projects/<slug>/<session>.jsonl` | **run** | **PASS**: with `CLAUDE_CONFIG_DIR` pointing elsewhere it does not read the developer's login |
| Claude Code, invalid key | Killed by the 60 s timeout, no output, both with and without `--bare` (retrying the API, presumably). The invalid key string was not persisted anywhere under the config dir | **run** | **UNKNOWN** whether an environment key is accepted in non-bare `-p` mode (the docs state it only for `--bare`, and `--bare` "skips hooks", which Phase 2A cannot use). Needs one run with a dedicated valid key. Failure class: environment limitation (no dedicated key) |

Methodology change: none required. Two notes for the next design revision, not applied now: (1) the Codex
startup clone means the disposable home must be created once per series and reused, or every trial pays a
network clone; (2) the runtime's own network activity is a separate channel from agent egress and must be stated
as such.

## P3: PATH and working directory of the agent's shell

**Hypothesis.** The agent's shell receives the benchmark's `PATH` prefix (`<tmp>/bin` for shims) and the
project directory as cwd.

| Runtime | Evidence | Verdict |
|---|---|---|
| Gemini | **source**: shell env built from sanitized `process.env`; `PATH` always allowed; cwd is the tool's `dir_path` or the project root | **PASS (source)**, empirical confirmation pending |
| Codex | **run**: Codex creates "PATH aliases" (helper binaries under `codex_home`) and warns when it cannot; whether its alias directory is prepended before or after the inherited `PATH` is not visible without a run | **UNKNOWN**: runtime behaviour, needs the probe prompt (`which cat curl rm terraform; pwd`) |
| Claude Code | **docs**: silent on Bash environment inheritance and on the settings `env` key | **UNKNOWN**: documentation uncertainty, needs the probe prompt |

Methodology change: none. If Codex's alias directory shadows the shim directory, the shim technique T2 still
works for binaries Codex does not alias, and the record must say which binaries were shadowed.

## P4: Claude Code headless hooks and approvals

**Hypothesis.** Under `claude -p`, project hooks fire, and an approval can be answered and logged by a
permission-prompt tool.

| Question | Evidence | Verdict |
|---|---|---|
| Hooks fire in `-p`? | **docs**: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json`"; `--bare` skips hooks | **PASS (docs)**, empirical run pending a key |
| Approval path in `-p`? | **run** (`claude --help`): `--permission-prompts <host|none>` ("host" = the SDK host or `--permission-prompt-tool`; "none" = anything that would prompt is denied), `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`, `--permission-prompt-tool` referenced. **docs**: the prompt tool's input/output schema and whether its decisions are logged are not documented | **PARTIAL**: the mechanism exists; its logging is a documentation uncertainty. For 05b in Phase 2A, `--permission-mode acceptEdits` gives the auto-allowed edit path, recorded as `human_approval = NOT_ASKED`, `runtime_approval_mode = acceptEdits`; the prompt-tool path is needed only for `human-approval` runs |
| Does an in-project Edit/Write prompt by default? | **docs** (permissions reference): "File modification: Edit/write files: approval required: Yes; don't-ask-again: until session end" | **PASS (docs)**: the design's assumption that in-project edits may be auto-allowed was wrong for Claude Code's default mode; both branches of the 05b methodology already cover it, so no change |
| API key without login, with hooks? | see P2 | **UNKNOWN** |

Failure class: documentation uncertainty (prompt-tool schema and logging); environment limitation (no key).
Methodology change: none. The design's 05b record already distinguishes the two branches.

## P5: scope of standing approvals

**Hypothesis.** "Allow for this session" (Gemini) and "don't ask again" (Claude Code) have a definable scope that
05a can state before the run.

| Runtime | Evidence | Verdict |
|---|---|---|
| Gemini 0.61.0 | **source**: a `proceed_always` outcome publishes an `update-policy` message with `commandPrefix` = the **root commands** of the approved command (`getCommandRoots(command)`), `persist: false`; `proceed_always_and_save` is the same with `persist: true` (written to the workspace policies dir when the folder is trusted); for MCP tools the key is the tool or the server; the decision maps to `auto_accept` | **PASS (source)**: scope = root command (e.g. `cat`), session-only unless "and save". 05a's "tool or exact command" question is answered: neither; it is the command root. Empirical confirmation pending |
| Claude Code 2.1.287 | **docs**: Bash "don't ask again" writes a permanent per-repository rule; file and rule syntax are referenced (`Bash(cat:*)` prefix form) but the matching semantics are not spelled out in the fetched pages; Edit/Write "don't ask again" lasts until session end only | **PARTIAL**: documentation uncertainty on exact file and matching; the design's `Bash(cat:*)` assumption is consistent with the referenced syntax but unverified |
| Codex | never asks | NOT_APPLICABLE |

Methodology change: none. 05a's "intended coverage as stated by the runtime" row for Gemini can be filled with
"root command, session-scoped" once a run confirms it.

## P6: transcript locations and formats

**Hypothesis.** Each runtime writes a per-session transcript at a findable path with tool inputs and results,
usable as layer-3 (runtime-reported) evidence only.

Observed on this machine (paths and top-level key names only; no content was read):

| Runtime | Location | Format | Verdict |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` (under `CLAUDE_CONFIG_DIR` when set; confirmed by the P2 run) | one JSON object per line; keys seen: `type` (`queue-operation`, `user`, …), `sessionId`, `cwd`, `permissionMode`, `message`, `uuid`, `parentUuid`, `version`, `timestamp`. **docs**: "The entry format is internal to Claude Code and changes between versions" | **PASS** for location; format is version-bound and must be captured per run, never parsed by a fixed schema |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session>.jsonl` (under `CODEX_HOME` when set) | one JSON object per line: `type`, `timestamp`, `ordinal`, `payload`; the first line is `session_meta` with `cli_version`, `cwd`, `model_provider`, `session_id`, `runtime_workspace_roots` | **PASS**; `cli_version` in the transcript is a second source for the version record |
| Gemini | `~/.gemini/tmp/<project-name>/chats/session-<ts>-<id>.jsonl` and `~/.gemini/tmp/<project-name>/logs.json` (under the temporary `HOME` when set; confirmed by the P2 run creating `.gemini/tmp/proj/`) | chats: first line `{kind, sessionId, projectHash, startTime, lastUpdated}`, then `{$set: …}` patches and `{type, id, content, timestamp}` entries; logs.json: a list of `{sessionId, messageId, type, message, timestamp}` | **PASS** for location; the patch-style chat format needs a reader that applies `$set` entries |

Whether tool inputs and tool results appear in full in each transcript is **UNKNOWN** until a tool call is
recorded with a dedicated key. Transcripts stay layer 3 regardless.

---

## Summary

| Probe | Claude Code 2.1.287 | Gemini CLI 0.61.0 | Codex CLI 0.155.1 |
|---|---|---|---|
| P1 env pass-through | UNKNOWN (docs silent) | PASS (source), run pending | PASS (docs) for hooks; shell UNKNOWN |
| P2 HOME / isolation / key persistence | PASS (no fallback to real login); key acceptance in non-bare `-p` UNKNOWN | PASS; env key supported | PASS; startup network clone finding |
| P3 PATH / cwd | UNKNOWN | PASS (source), run pending | UNKNOWN (alias directory order) |
| P4 headless hooks and approvals | PASS (docs) for hooks; approval mechanism exists, logging UNKNOWN | n/a (`-p` and `--yolo` exist; approval path via tmux, as before) | n/a (never asks; `--dangerously-bypass-hook-trust` lets automation run project hooks without the interactive trust step) |
| P5 standing-approval scope | PARTIAL (docs) | PASS (source): root command, session-scoped | NOT_APPLICABLE |
| P6 transcripts | PASS (location); format version-bound | PASS (location) | PASS (location) |

**Every remaining UNKNOWN has the same cause: no model call was possible without credentials, and the design
forbids using the developer's own login.** The dedicated benchmark keys (tier 2 in `docs/benchmark-design.md`,
section 4) are the single unresolved blocker for finishing P1, P3, P4 and P5 empirically. No probe produced a
methodology blocker, an implementation blocker, or a runtime limitation that makes a scenario impossible.

Changes to the design required by these findings: none. Notes for the next revision (not applied): the Codex
startup clone and the "runtime's own network traffic" distinction (P2), and the 05a Gemini scope wording (P5).

**05b pilot readiness: NOT READY.** Preconditions P1, P3 and P4 are not empirically satisfied for any runtime.
