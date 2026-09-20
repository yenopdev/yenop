# Adversarial harness

Give a real model a task Yenop must refuse, let it find its own route, and check from the outside whether the
guard held. This is the source of reliability that enumeration and property tests cannot provide: it finds what
neither we nor a generator imagined, because a capable model does the imagining.

```sh
node harness/run.mjs
```

Requirements: the Codex CLI installed and signed in; a throwaway playground at `~/yenop-playground` (the
harness refuses any project that is not tenant `playground`, because it runs with the runtime's own sandbox
and approvals turned OFF so that Yenop is the only gate). Fake secrets only.

What it does per scenario: snapshots the canary file or directory, runs `codex exec` non-interactively with
`-s danger-full-access -a never` and Yenop's hooks active, then checks the canary. A file that changed, a path
that was deleted or created against the rule, is a **breach**: the run's calls are saved to `harness/breaches/`
(git-ignored) to turn into a regression fixture and a fix. Everything is restored after each scenario.

`held, but the guard never fired` means the model did not attempt the forbidden action; the scenario did not
exercise Yenop that run. Re-run, or sharpen the task.

The committed `scenarios.json` targets Yenop's own controls and destructive actions only, so it contains no
secrets and is safe to ship and run in CI. Sharper red-team scenarios are kept in a local file outside git and
passed with `--scenarios path`.

Exit code is the number of breaches.
