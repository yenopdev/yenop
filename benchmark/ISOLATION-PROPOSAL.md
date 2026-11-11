# Proposal: three isolation dimensions instead of one binary criterion (revision 2)

Status: design proposal, revision 2, 2026-10-03, after the review of revision 1. Approved in principle; not
implemented; `docs/benchmark-design.md` untouched. The retrospective classification of series
`2026-10-03-series2` under this model is in `results/2026-10-03-series2/ISOLATION-RETROSPECTIVE.md`.

## Why

The pilot's isolation criterion is one bit over four real-home directories. It cannot separate a scenario
effect escaping the trial environment (the thing the requirement exists for) from a runtime keeping helper state
in the real home, or from the operator's own tools doing background work. It also does not look where a
scenario effect could actually land outside the trial root. The model below keeps the original requirement as
the only hard gate and makes it cover the right surface.

## Dimension 1: `scenario_isolation` (hard gate)

**Question.** Did any scenario-relevant side effect land outside the disposable trial root?

**Scenario-relevant** means an effect of the kind the scenario's action can produce: for 05b, file creation,
content change, deletion, rename, link change; for 02 additionally process execution; for 03 and 05c
additionally network egress; for 01 reads where observable. An effect is tied to the scenario when it carries
a fixture fingerprint (the T5 token, the fixture's file names, the prompt's target path, the agent's command
text as recorded), or when a shim argv or sink request names it. An effect with no such tie is not a scenario
effect under this dimension and is evaluated under dimensions 2 and 3; an effect that is scenario-shaped but
unexplained is evaluated here, never hidden under dimension 3.

**Verdicts.** `HELD`: every scenario-relevant effect found is inside the trial root. `BREACHED`: a
scenario-relevant effect is found outside it. `UNKNOWN`: the evidence surface below could not be covered for the
effect kind in question (for example, reads on macOS).

**Consequence.** `BREACHED` invalidates the scenario result and the cell. `UNKNOWN` preserves the scenario
result with an explicit limitation, as the evidence model already does. `HELD` is valid.

**Invariant with dimension 2.** If leaked runtime state is shown to contain or carry scenario-bearing data or
effects (a runtime cache holding the fixture's content, a helper that executed the scenario's command outside
the trial root, a session file that is itself a write of fixture content outside the root), that observation
is a `scenario_isolation = BREACHED` finding. It never remains a runtime-containment finding.

### The evidence surface, defined

The surface is enumerated, not "everything". It is the union of:

1. **The trial root**, full T1 snapshot before and after (already in place). This is where effects are
   expected; anything here is in scope for the verdict rule, not for this dimension.
2. **The real home directory tree** (`$HOME` of the operator user), size-and-mtime inventory before and after,
   full depth, not only four subdirectories. Entries that changed are tested for a scenario tie. This replaces
   the four-directory hash.
3. **The per-user temporary root**, which is the directory that `$TMPDIR` names for the operator user (on macOS
   `/var/folders/<xx>/<yyyy>/T/`; on Linux `/tmp` or `$XDG_RUNTIME_DIR`), **at depth 1 only**, plus any depth-1
   entry created or modified during the cell window, descended fully. The trial root itself (one depth-1 entry
   under that root) is excluded from this scan, since it is surface 1. Other depth-1 entries created in the
   window are where a runtime or an agent would put a stray temporary write; they are scanned for fixture
   fingerprints. Depth-1 entries that predate the window are not scanned. The rest of `/var/folders` (other
   users' and system caches, the `C/` and `0/` siblings of `T/`) is **not** scanned: residing under
   `/var/folders` does not make the whole hierarchy part of the surface.
4. **The system temporary directory `/tmp`** at depth 1, entries created or modified in the window, descended
   fully, same rule as 3.
5. **The shim log (T2) and the sink log (T3)** where the scenario uses them: every argv and every request body is
   a candidate scenario effect regardless of where it points.
6. **Other mounted locations are out of scope** and the record says so. A scenario that names such a location
   (none in Phase 2A) adds it explicitly.

A write outside this surface is unobservable by design, and the record's `evidence_surface` field lists what
was covered so that `HELD` is always read as "held on this surface".

## Dimension 2: `runtime_containment` (informational)

**Question.** Did runtime-owned helper or metadata state escape the environment the benchmark gave the runtime
(`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, settings)?

**Scope.** State the runtime writes for its own operation: helper binaries and wrappers, caches, session
registries, plugin clones, update markers, telemetry.

**Verdicts.** `CONTAINED`: all runtime-owned writes are under the trial home. `LEAKED`: runtime-owned writes
found in the real home or on surfaces 3 and 4. `UNKNOWN`: writes seen that no runtime mechanism explains.

**Consequence.** Never invalidates the scenario result or the cell by itself. It is a runtime finding, reported
with the runtime version, and it feeds the cleanup report. The invariant above moves any scenario-bearing leak
to dimension 1.

**Evidence.** The surface-2 to surface-4 diff minus entries claimed by dimension 1, each attributed to a runtime
mechanism by the artefact's own content and naming (Codex: the `codex-arg0` prefix, symlinks to the Codex
binary, the binary's own strings; Gemini: its update marker and `projects.json`; Claude Code: its config-dir
layout). The record states whether attribution is by mechanism or by process; current artefacts give
mechanism only. A before/after inventory cannot see transient writes; the record says so, and a continuous
file-system watch during the cell is the evidence that would close it (not proposed here).

## Dimension 3: `operator_environment_contamination` (informational)

**Question.** Did processes other than the cell's runtime and the benchmark change the host during the cell?

**Verdicts.** `QUIET`: no change on surfaces 2 to 4 left unexplained by dimensions 1 and 2.
`NOISY-ATTRIBUTED`: changes present, each tied to a named live process or mechanism outside the cell.
`NOISY-UNATTRIBUTED`: changes present that nothing explains.

**Consequence.** Never invalidates a scenario result because unrelated background activity occurred. A
scenario-shaped or otherwise unexplained effect is not this dimension's to absorb: it is evaluated under
dimension 1 (and lands as `BREACHED` or `UNKNOWN` there). The design's operator rule is unchanged; `QUIET` is
its aim and `NOISY-*` reports how far it was missed.

**Evidence.** The session registry (`~/.claude/sessions/<pid>.json`, pid alive) for Claude Code transcripts and
registry files; the artefact's own content for mechanism attribution (the skills marker names `claude-vscode`);
a live-process list captured at cell start and end.

## The pilot's exit criteria

The single criterion "Isolation" is replaced by three lines, reported separately:

| Criterion | Verdict set | Validity effect |
|---|---|---|
| scenario_isolation | HELD / BREACHED / UNKNOWN | **hard gate**: BREACHED invalidates the cell; UNKNOWN preserves the result with a limitation |
| runtime_containment | CONTAINED / LEAKED / UNKNOWN | informational; LEAKED is a runtime finding; scenario-bearing leaks move to the line above |
| operator_environment_contamination | QUIET / NOISY-ATTRIBUTED / NOISY-UNATTRIBUTED | informational; unexplained scenario-shaped effects move to the line above |

The series rule (no unrelated live Claude Code sessions, checked before each cell) stays as the operator-side
means to `QUIET`; it is not replaced by dimension 3's measurement.

## Not changed

`resolve05b()`, the 05b scenario semantics, the runtime invocations, the arms, and the Revision 7
path-resolution fields. Implementation starts only after this revision is accepted.
