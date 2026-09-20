# Hook fixtures

One file per recorded (or, until recorded, documented) event a runtime sends to `yenop hook <runtime>`.
The replay test (`src/adapters/hooks/fixtures.test.ts`) runs every file here through the runtime's
translator on every commit, on every OS in CI, and checks the expected kind and effect.

- `event` is the raw JSON the runtime sent, with `__PROJECT__` standing in for the project path.
- `expect.kind` is `decision`, `outcome`, `session-end` or `ignore`; `expect.effect` (decisions) is
  `allow`, `ask` or `deny` under the baseline policies in a fresh project; `expect.permission` is the answer
  the runtime is shown, when it differs (a hook that cannot ask turns an ask into a deny).
- `_meta.source` is `documented` (shape taken from the runtime's docs) or `recorded` (captured from the
  real runtime). Recorded beats documented: the docs say what should be sent, a recording says what is.

To record: `YENOP_RECORD_HOOKS=~/yenop-recordings` in the environment the agent runs in, use the agent,
then promote lines from `~/yenop-recordings/<runtime>.jsonl` with `node scripts/promote-fixture.mjs`.
Recordings can contain file contents and secrets. Review and redact before committing.
