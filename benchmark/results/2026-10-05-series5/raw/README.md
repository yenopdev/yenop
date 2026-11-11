# Series 5 raw trace: Codex CLI, arm R+Y

`05b-codex-R+Y.syscalls.log` is the complete `strace` output of one Series 5 cell, Codex CLI 0.155.1 with the
Yenop hook installed (record: `../records/05b-codex-R+Y.json`). It runs from the runtime's first system call to
its exit: 20,920 lines, 204 processes. It was captured with

```
strace -f --decode-pids=pidns -ttt -s 256 \
  -e trace=%file,execve,execveat,clone,clone3,fork,vfork,exit,exit_group,read,write,close \
  -- <runtime invocation>
```

The timestamps the article cites for this cell come from this file: hook pre-event (H1) `execve` at
`1791150756.459948`, the sandboxed bash's `openat("…/benchmark/output.txt", O_WRONLY|O_CREAT|O_APPEND)` at
`1791150756.767964`, and the post-event (H2) at `1791150756.800615`. `../../../pilot/published-trace.test.mjs` reparses
this file with the repository's parser and checks that it reproduces the record: event and process counts, H1, H2,
the writing open, case F, both resolution verdicts, and every process role.

## Redaction

The file is the driver's redacted artifact with one addition, and nothing else was changed:

- Driver redaction, as for every artifact: the run's API keys become `<REDACTED>`, the operator's home directory
  `<HOME>`, and the operator's user name `<user>`.
- Addition, 2 lines: strace's 256-byte string cap had cut the home directory short at a `"...` truncation marker,
  so the whole-value replacement missed it. That prefix is now `<HOME>` too. Since this series, the driver's
  redactor handles truncated prefixes itself (`makeRedactor` in `../../../pilot/guards.mjs`, with tests).

The redaction does not adjust byte counts. A `read` or `write` return value counts the original bytes, which can
differ from the length of the redacted string shown. The trial's own paths under `/var/tmp/pilot/` are left as they
are: they are the evidence, and they name nothing outside the disposable trial.

| | SHA-256 |
|---|---|
| this file | `2412d352e04de25e9492b9188893c9edc7deeb9224b95700be2abcd67806cc5f` |
| the driver's artifact before the 2-line addition (kept, not published) | `27b28a84ce0878d127fe71c4260e8d879b17a0650a849e867c7c0e2782321bb9` |

## The other cells

Raw traces and transcripts for the other five cells are kept with the series and are not published here: each
carries a full session transcript, and publishing them needs the same line-by-line review as this file. If you need
one for a specific question, ask: security@yenop.com.
