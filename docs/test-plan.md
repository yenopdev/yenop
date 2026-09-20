# Test plan

Written for: the people building and releasing Yenop. This is the living checklist. Every roadmap item adds
to it; nothing ships that is not covered somewhere below.

Three rules, from the top:

1. **Security first.** Every change is checked for a bypass before anything else. A test that proves a block
   is worth more than ten that prove a feature.
2. **Fake secrets, disposable machines.** Adversarial and destructive tests never run on a machine that holds
   real credentials. Containers and throwaway VMs only.
3. **Strict locally, relaxed in CI.** Performance gates are hard on a developer machine and multiplied by
   `YENOP_CI_PERF_FACTOR` on shared runners, because a flaky gate gets ignored, which is worse than none.

## The four layers

| Layer | Runs | Where | Cadence |
|---|---|---|---|
| 1 | unit and integration suite, fixture replay, obfuscation corpus, air-gapped install, RHEL-family run | GitHub Actions: macOS, Ubuntu, Windows (`.github/workflows/ci.yml`) | every push |
| 2 | live systemd daemon, dangerous commands, daemon killed and port blocked, fleet of containers | containers and VMs on the developer's machine | before a release, and when touching those areas |
| 3 | real agents calling the hooks: Claude Code, Cursor, Codex, Gemini | the developer's Mac and Windows PC, real apps installed | once per adapter, then whenever the agent updates; each session ends by recording fixtures |
| 4 | a distro or setup we do not own: RHEL, a clean Windows, an EDR-equipped box | a cloud VM rented by the hour | when a customer's environment needs it |

## Layer 1: automated on every push

What CI runs, and what each job proves:

- `test` on Ubuntu and Windows with Node 24 on every push: the whole suite, typecheck and build. These are the
  two platforms we do not have on the desk, so they carry the most information per minute.
- `test-full` weekly (Mondays) and on demand (`workflow_dispatch`): macOS, and Ubuntu with Node 22 and 26.
  macOS runners bill at 10x on a private repo and the developer's Mac already covers macOS on every build.
  Run it by hand before a release. When the repository is public, standard runners are free and macOS can
  return to every push.
- `offline-install`: builds the offline bundle, then installs and runs it in a container with `--network none`.
  Proves the air-gapped story on every push.
- `rhel-family`: the suite inside a Rocky Linux 9 container, because that is what a bank runs.

Not in CI on purpose: the supervised daemon (needs a real init system), live agents (need the apps), and
anything destructive.

### Fixture replay

`fixtures/hooks/<runtime>/*.json` holds what each runtime really sends. `src/adapters/hooks/fixtures.test.ts`
replays every file through the runtime's translator and checks the kind, the engine's verdict, and the
answer the runtime is shown. When a runtime changes its hook contract, this test fails before a user does.

Recorded fixtures beat documented ones. To record (layer 3):

```sh
# in the environment the agent runs in (a terminal that then launches the agent, or the agent's own env)
export YENOP_RECORD_HOOKS=~/yenop-recordings
# use the agent normally for a while, then promote the interesting lines:
node scripts/promote-fixture.mjs ~/yenop-recordings/cursor.jsonl 12 cursor beforeshellexecution-rm decision ask
```

The promoter redacts fields that can carry file contents or secrets and replaces the project path with
`__PROJECT__`. Review the result before committing; recordings themselves are never committed.

### Performance gates

| Path | Local gate | What it protects |
|---|---|---|
| daemon round trip, warm | 15 ms | the decision itself |
| command hook, spawned, via daemon | about 50 ms (Node startup dominated) | the developer's patience |
| command hook, in-process fallback | about 130 ms | the no-daemon story |

Measure the spawned-command numbers by hand after touching anything on the hook path (`src/adapters/hooks`,
`src/adapters/<runtime>/hook.ts`, `src/daemon/fast.ts`); the rule in `docs/engineering.md` is that those
modules never import the policy engine.

## Layer 2: disposable, local

Recipes, all on the developer's machine with Docker Desktop or OrbStack (macOS) or WSL2 (Windows):

- **Air-gapped install by hand:** `npm run pack:offline`, then the same container command CI uses, to inspect
  interactively.
- **Live systemd:** a systemd-enabled container or a Multipass/Lima Ubuntu VM; `yenop service install`, then
  kill the daemon and confirm it returns on the same port; then `loginctl enable-linger` and log out.
- **Daemon under hostile conditions:** with the daemon running, `kill -9` it and hold its port with another
  process; every hook call must still answer correctly in-process, and receipts must say it ran without the
  daemon. Then make the home directory read-only and confirm the hook still denies rather than crashes open.
- **Dangerous commands and exfiltration:** the playground inside a container with fake `.env` and keys; run
  the demo script's live version against a real agent there, never on the host.
- **Fleet:** the private control plane plus two or three data-plane containers posting receipts, to see one
  timeline.

## Layer 3: real agents, by hand, then recorded

For each agent, on a fresh project with `yenop init` (enforce mode, playground is fine):

| Step | Claude Code | Cursor | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| ordinary work (`npm test`, an edit) | allowed, silent | allowed, silent | | |
| read `.env` | denied | denied (beforeReadFile) | | |
| `rm -rf build` | asked, with the run's history | asked | | |
| fetch a page, read env, call outside | third step asked | third step asked | | |
| an MCP write | asked | asked (beforeMCPExecution) | | |
| edit the hook config itself | asked (Claude Code can ask) | denied with explanation (Cursor cannot ask there) | | |
| approve an ask, then `yenop receipts` | shows the answer | shows the answer where the event carries an id | | |
| record fixtures for every event seen | `YENOP_RECORD_HOOKS` set | same | | |

Open items to verify live: Cursor's built-in tool names in `preToolUse` (the adapter matches by pattern);
Codex's shell-only hooks; Gemini's `BeforeTool` payload. Fill the empty columns as each adapter lands.

Windows: run the same table on the Windows PC. Expect the service integration to be absent (documented) and
the command hook to work; anything else that differs is a bug to file.

## Layer 4: rented, on demand

When a customer runs something we do not own: a RHEL or Rocky VM for their distro, a clean Windows VM to
reproduce a report without touching the developer's PC, and, when a pilot has endpoint security, a trial of
that product on a throwaway VM to learn whether it kills the daemon or blocks loopback. Document each finding
in `docs/on-prem.md`.

## Adversarial corpus

`src/core/shell.test.ts` and `src/core/sequence.test.ts` carry the bypass attempts found so far. Every new
bypass, from testing or from the wild, becomes a permanent case there before it is fixed. The corpus is the
memory of the shell-parsing treadmill; it is allowed to grow and never allowed to shrink.

## Release gate

A release means: CI green on all jobs; layer 2 recipes run once for anything touched since the last release;
layer 3 table complete for every adapter shipped; performance numbers re-measured and written into
`docs/engineering.md`; no fixture with `_meta.source: documented` for an adapter claimed as supported.
