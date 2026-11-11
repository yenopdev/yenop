# Preconditions P1, P3, P4, P5: empirical rerun with dedicated credentials, 2026-10-02

Follows `2026-10-01-preconditions.md`. Only the parts left UNKNOWN there were rerun. Credentials: three
dedicated benchmark keys supplied by the owner in a local file outside the repository, loaded into memory by a
scratchpad driver, passed only to the runtime's child environment, and scrubbed from every artifact by value.
No key value appears in this record, in the artifacts under `2026-10-02-artifacts/`, or in the repository.
Redacted artifacts: `result.json` per run (verdict fields), `hook-env.txt` (what the probe hook received;
values kept only for `YENOP_*`, `PATH`, `HOME`, `PWD`, cwd variables; every other variable name-only),
`stderr.txt`, and the Gemini dialog captures. Machine paths and the username are replaced.

## Environment

| Item | Value |
|---|---|
| OS / Node | macOS 26.6.2 (Darwin 25.6.0 arm64) / v26.3.0 |
| Claude Code CLI | 2.1.287, model `claude-haiku-4-5-20251001` |
| Gemini CLI | **0.61.0 at the start; the global package was 0.62.0 by the end** (see P2 addendum), model `gemini-3.1-flash-lite` |
| Codex CLI | codex-cli 0.155.1, default model `gpt-6-astra` |
| Yenop | 0.1.2, repository `a475804`; no Yenop hook was installed in any probe (the probe hook is a shell script that records its environment and exits 0) |

Method, identical per runtime: a fresh temporary directory with `proj/` (a README), `home/` (empty; the
runtime's `HOME`, plus `CLAUDE_CONFIG_DIR=home/.claude` for Claude Code), `bin/` (a fake `terraform` shim),
`evidence/`. Project-scope hook file in the runtime's own format pointing at the probe hook. Environment:
`PATH=bin:…`, `HOME=home`, the runtime's key, and four marker variables `YENOP_PROBE_MARKER`, `YENOP_HOME`,
`YENOP_NO_DAEMON`, `YENOP_RECORD_HOOKS`. One prompt asking the agent to run one `sh -c` command that prints
`pwd`, `command -v terraform cat curl`, `terraform version`, the marker, `$YENOP_HOME`, `$HOME`, and the
environment variable **names**. Afterwards: a scan of every file under the temporary directory for any key
value; a size-and-mtime inventory of the real `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini` before and
after; the temporary directory deleted.

Evidence labels: **run** = observed here today; **source** / **docs** = carried over from 2026-10-01, not
promoted.

---

## P1: environment pass-through

| Runtime | (a) hook subprocess received the four `YENOP_*` variables | (b) agent shell received them | Verdict |
|---|---|---|---|
| Claude Code 2.1.287 | yes: one hook call, all four present, `PATH` begins with `bin`, hook cwd = project | yes: marker and `YENOP_HOME` echoed; env names include the four and `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDECODE`; the key name `ANTHROPIC_API_KEY` is also in the agent's shell environment | **PASS (run)** |
| Gemini CLI 0.61.0 | yes: two hook calls (one per tool call), all four present, `PATH` begins with `bin`, hook cwd = project | yes: marker and `YENOP_HOME` echoed; env includes `GEMINI_CLI=1`, `GIT_CONFIG_*` overrides, `PAGER`; the key name `GEMINI_API_KEY` is in the agent's shell environment | **PASS (run)**, consistent with the source reading |
| Codex CLI 0.155.1 | yes: one hook call, all four present, hook cwd = project; `PATH` **does not** begin with `bin`: Codex prepends its own `codex-path` directory ahead of the inherited `PATH` | yes: marker and `YENOP_HOME` echoed | **PASS (run)**, with the `PATH` note under P3 |

Finding (all three): the API key variable is visible to the agent's shell. For the benchmark that is the
expected consequence of tier-2 credentials and the reason the keys are dedicated and capped; a scenario prompt
must never ask the agent to print its environment with values.

## P2 addendum: credential handling and isolation, observed today

| Runtime | Key acceptance | Persistence | Real home |
|---|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` in the environment works in non-bare `-p` mode with hooks on (the 2026-10-01 UNKNOWN is resolved) | no key value in any file under the temporary directory (7 files written under `CLAUDE_CONFIG_DIR`) | unchanged |
| Gemini CLI, headless | `GEMINI_API_KEY` in the environment works in `-p` mode | no key value persisted (7 files under the temporary home) | unchanged |
| Gemini CLI, **interactive** | the start-up dialog asks for an auth method; choosing "Use Gemini API Key" opens a field **pre-filled with the key from the environment, displayed in clear text**, and states the key "will be securely stored in your system keychain", i.e. the real login keychain, outside any temporary `HOME`. The session was killed without submitting; the two keychain items that mention Gemini on this machine date from 2026-09-22 and predate the probe | the tmux screen capture contained the key value; both capture files were scrubbed by value before being kept; the value also appeared in the operator's transcript during the probe and **the Gemini key should be rotated** | unchanged |
| Codex CLI | `OPENAI_API_KEY` in the environment is **ignored by the default provider** ("Missing bearer or basic authentication in header", 401). It works through a provider block in the temporary `config.toml` with `env_key = "OPENAI_API_KEY"`, which reads the environment at call time and writes nothing | no key value persisted (5,486 files under the temporary home, the plugin-marketplace clone again) | unchanged |

Two more runtime-owned side effects observed today, both outside the benchmark's control:

- **Gemini CLI updated itself during the interactive probe** ("Update successful! The new version will be used
  on your next run"): the global npm package went from 0.61.0 to 0.62.0 while running under a temporary
  `HOME`. The setting `disableAutoUpdate` exists in the bundle. Every Phase 2A Gemini run must set it in the
  temporary home's `settings.json`, and the version must be recorded at the end of a run as well as the start.
- **Codex's `codex-path` alias directory** contains one binary, `rg`. Shims for any other command are not
  shadowed; a shim for `rg` would be.

## P3: PATH and working directory of the agent's shell

| Runtime | `command -v terraform` | shim ran | `pwd` | Verdict |
|---|---|---|---|---|
| Claude Code | `bin/terraform` | yes | the project (as `/private/var/…`, the resolved form of the temporary path) | **PASS (run)** |
| Gemini CLI | `bin/terraform` | yes | the project | **PASS (run)** |
| Codex CLI | `bin/terraform` | yes | the project | **PASS (run)**; only `rg` is shadowed by Codex's alias directory |

## P4: Claude Code headless hooks and approvals

| Question | Observed | Verdict |
|---|---|---|
| Do project hooks fire under `claude -p`? | yes: the probe hook recorded one call with the project's `PreToolUse` configuration, in default (non-bare) mode | **PASS (run)** |
| Is the "would have prompted" path logged? | yes: with `--permission-prompts none`, every call that would have prompted is listed in the JSON result's `permission_denials` with `tool_name`, `tool_use_id` and the full `tool_input`; the denied command did not execute (directory absent afterwards) | **PASS (run)** for denials |
| Can an approval be answered by a prompt tool and logged? | not exercised: it needs an MCP server implementing the prompt tool, which is benchmark code; the flags `--permission-prompts host` and `--permission-prompt-tool` exist | **UNKNOWN** (deferred to Phase 2A implementation; not needed for the 05b `authorization-only` branch, which uses `--permission-mode acceptEdits` and records `NOT_ASKED`) |
| Safe read-only commands | `cat`, `echo` ran with no rule and no denial under `--permission-mode manual`: Claude Code auto-allows a set of read-only commands. A test of rule scope must use a command that prompts (`mkdir`, `touch`) | finding, recorded for 05a |

## P5: scope of standing approvals

| Runtime | Experiment | Observed | Verdict |
|---|---|---|---|
| Claude Code | project `permissions.allow: ["Bash(mkdir:*)"]`, prompt asks for `mkdir dir-one`, `mkdir dir-two`, `touch file-three`; control run with an empty allow list | with the rule: both directories created, `touch` denied and logged; without the rule: all three denied, nothing created | **PASS (run)**: a `Bash(<cmd>:*)` rule covers every invocation whose command begins with `<cmd>`, and nothing else. The exact rule the interactive "don't ask again" writes remains **docs-level** (not exercised; interactive) |
| Gemini CLI | interactive "allow for this session" | not reached: the interactive session requires storing the key in the real keychain (above), which the credential rule forbids; headless mode cannot present the dialog | **UNKNOWN (run)**; the source reading stands as source evidence only: scope = command root, session-only unless "and save". Failure class: **runtime limitation** (interactive auth design) combined with the benchmark's credential rule |
| Codex CLI | never asks | NOT_APPLICABLE | |

---

## Status after this rerun

| Probe | Claude Code 2.1.287 | Gemini CLI 0.61.0 (headless) | Codex CLI 0.155.1 |
|---|---|---|---|
| P1 env pass-through | PASS (run) | PASS (run) | PASS (run) |
| P2 isolation / key persistence | PASS (run) | PASS (run) headless; interactive mode **unusable** under the credential rule | PASS (run) via `env_key` provider |
| P3 PATH / cwd | PASS (run) | PASS (run) | PASS (run), `rg` shadowed |
| P4 headless hooks / approval logging | PASS (run) for hooks and denials; prompt-tool approvals UNKNOWN | n/a | n/a |
| P5 standing-approval scope | PASS (run) for rule semantics; written rule docs-level | UNKNOWN (run); source only | NOT_APPLICABLE |
| P6 transcripts | PASS (2026-10-01) | PASS (2026-10-01) | PASS (2026-10-01) |

**Remaining UNKNOWNs and why**

1. Claude Code prompt-tool approvals: needs an MCP prompt-tool server, which is Phase 2A code. Not required
   for the pilot's `authorization-only` branch.
2. Gemini "allow for this session" scope, empirically: interactive Gemini stores the key in the real keychain.
   Options for later, none taken now: a disposable Google account (tier 3), or accepting source-level evidence
   for 05a's Gemini row with the label "source". Not required for 05b.
3. The exact rule Claude Code's interactive "don't ask again" writes: interactive only. Not required for 05b.

**Methodology implications** (to fold into the design at its next revision; not applied now, none makes the
design impossible):

- Gemini auto-update must be disabled per run and the version recorded at run end; Codex's `rg` alias noted
  in the shim technique; the agent shell sees the key variable name, so no scenario prompt may print the
  environment with values.
- Codex needs the `env_key` provider block in the temporary `config.toml`; this is configuration, not a
  credential copy.
- Gemini interactive mode is excluded from Phase 2A (headless with `--approval-mode` only); its approval
  dialog path, which 05a needs, moves to the same operator-driven track as Cursor or waits for a tier-3
  account.

**Credential hygiene**: the Gemini key value was displayed by the runtime's own dialog and captured; rotate
it. The keys file is world-readable (`-rw-r--r--`); it should be `0600`.

**05b pilot readiness**: P1, P2, P3 are empirically satisfied for all three Phase 2A runtimes; P4 and P6 for
what the pilot's `authorization-only` branch needs. **Ready from the preconditions' side.** Not started.
