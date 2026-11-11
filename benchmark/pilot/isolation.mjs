/**
 * Three-dimension isolation model (benchmark/ISOLATION-PROPOSAL.md, revision 2).
 *
 *   scenario_isolation                 HELD | BREACHED | UNKNOWN   the only hard validity gate
 *   runtime_containment                CONTAINED | LEAKED | UNKNOWN   informational
 *   operator_environment_contamination QUIET | NOISY-ATTRIBUTED | NOISY-UNATTRIBUTED   informational
 *
 * Evidence surface (inventoried before and after a cell, size:mtime per entry, symlinks not followed):
 *   1. the trial root            full snapshot (T1; handled by the driver, not here)
 *   2. the real home tree        full depth
 *   3. the per-user temp root    $TMPDIR, depth 1; entries created or modified in the cell window are descended fully;
 *                                the trial root itself is excluded (it is surface 1)
 *   4. /tmp                      depth 1, same descent rule
 *   5. shim and sink logs        where the scenario uses them
 * Nothing else is scanned: the rest of /var/folders is out of scope by design.
 *
 * Known blindness, recorded in every result: a before/after inventory cannot see a write that is created and
 * removed inside the window (no continuous watch in this step).
 */
import { readdirSync, lstatSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";

const stamp = (st) => `${st.size}:${Math.floor(st.mtimeMs)}`;
const realOrResolved = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const excludeSet = (list) => new Set((list || []).map(realOrResolved));

/** A per-run scenario token: unique per cell, generated at run time, never in source. It is the fixture's secret content. */
export function newScenarioToken() { return `benchmark-secret-${randomUUID()}`; }

/**
 * Full-depth inventory of a tree: { absolutePath: "size:mtime" }. Symlinks are recorded, never followed.
 * opts.exclude: subtrees skipped entirely (the trial root; the benchmark's own results directory).
 * opts.minMtimeMs: when set, only entries whose own mtime is at or after it are recorded (used for descended temp entries).
 */
export function inventoryTree(root, acc = {}, opts = {}) {
  const ex = opts.exclude instanceof Set ? opts.exclude : excludeSet(opts.exclude);
  if (ex.has(realOrResolved(root))) return acc;
  let st; try { st = lstatSync(root); } catch { return acc; }
  if (!st.isDirectory()) { if (opts.minMtimeMs == null || st.mtimeMs >= opts.minMtimeMs) acc[root] = stamp(st); return acc; }
  let names; try { names = readdirSync(root); } catch { return acc; }
  for (const n of names) {
    const p = join(root, n);
    if (ex.has(realOrResolved(p))) continue;
    let s; try { s = lstatSync(p); } catch { continue; }
    if (s.isDirectory()) inventoryTree(p, acc, { exclude: ex, minMtimeMs: opts.minMtimeMs });
    else if (opts.minMtimeMs == null || s.mtimeMs >= opts.minMtimeMs) acc[p] = stamp(s);
  }
  return acc;
}

/**
 * Temp-root surface: depth 1 of `root`. A depth-1 entry whose modification time is at or after `windowStartMs`
 * (creation sets it too) is descended, but **only children whose own mtime is in the window are recorded**: a
 * pre-existing child is not a change merely because its parent's mtime moved (the series3 /tmp/claude-501 case,
 * where the before-inventory could not have descended and every old file inside read as "created"). Entries
 * that predate the window are recorded by name only. `exclude` (the trial root, the results directory) is skipped.
 * No full pre-run recursive inventory of temp entries is taken; that remains a stated limitation.
 */
export function inventoryTempRoot(root, windowStartMs, exclude = [], acc = {}) {
  const ex = excludeSet(exclude);
  let names; try { names = readdirSync(root); } catch { return acc; }
  for (const n of names) {
    const p = join(root, n);
    if (ex.has(realOrResolved(p))) continue;
    let s; try { s = lstatSync(p); } catch { continue; }
    const inWindow = s.mtimeMs >= windowStartMs;
    // A directory modified in the window is recorded itself and descended: without its own entry a pre-existing
    // directory touched in the window read as "removed" in the diff while it still existed (Stage 2 run-4 review).
    if (s.isDirectory() && inWindow) { acc[p] = `dir:${Math.floor(s.mtimeMs)}`; inventoryTree(p, acc, { exclude: ex, minMtimeMs: windowStartMs }); }
    else acc[p] = s.isDirectory() ? `dir:${Math.floor(s.mtimeMs)}` : stamp(s);
  }
  return acc;
}

/** Entries that differ between two inventories. */
export function diffInventories(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) out.push({ path: k, before: before[k] ?? null, after: after[k] ?? null, change: before[k] == null ? "created" : after[k] == null ? "removed" : "modified" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const RUNTIME_MECHANISMS = {
  codex: [
    { name: "codex arg0 helper", test: (p) => /\/\.codex\/tmp\/arg0\/codex-arg0/.test(p) },
    { name: "codex home state", test: (p) => /\/\.codex\//.test(p) },
    // codex-linux-sandbox creates /tmp/codex-bwrap-synthetic-mount-targets-<uid>/ (and files under it) when it sets up
    // its bwrap sandbox (Stage 2 run-2 trace, 2026-10-05: created and removed by the in-tree sandbox process).
    { name: "codex bwrap synthetic mount targets", test: (p) => /^\/tmp\/codex-bwrap-synthetic-mount-targets-\d+(\/|$)/.test(p) },
  ],
  gemini: [{ name: "gemini home state", test: (p) => /\/\.gemini\//.test(p) }],
  "claude-code": [
    { name: "claude code config state", test: (p) => /\/\.claude(\.json|\/)/.test(p) },
    // Claude Code's own per-uid temp directory and socket directory under /tmp (Series 5 cells 1-2, 2026-10-05: written by
    // runtime-role pids of the claude process). Exact names only: /tmp/claude-<uid> and /tmp/cc-socks, and their children.
    { name: "claude code temp dir", test: (p) => /^\/tmp\/claude-\d+(\/|$)/.test(p) },
    { name: "claude code sockets", test: (p) => /^\/tmp\/cc-socks(\/|$)/.test(p) },
  ],
};
const OPERATOR_MECHANISMS = [
  { name: "claude code skills sync", test: (p) => /\/\.claude\/skills\/synced\//.test(p), marker: (p) => { const m = /(.*\/\.claude\/skills\/synced\/[^/]+)\//.exec(p); if (!m) return null; try { const t = readFileSync(join(m[1], ".last-complete-round"), "utf8").trim(); return t ? `.last-complete-round names client "${t.split(/\s+/).pop()}"` : null; } catch { return null; } } },
];

const readSmallText = (p) => { try { const st = lstatSync(p); if (!st.isFile() || st.size > 2 * 1024 * 1024) return null; return readFileSync(p, "utf8"); } catch { return null; } };

/**
 * Classify a cell's changes outside the trial root.
 * input: {
 *   runtime, trialRoot, changes (from diffInventories over surfaces 2-4, tagged with .surface),
 *   fixture: { pathFingerprints: string[], contentFingerprints: string[] },   what ties a change to the scenario
 *   scenarioCommands: string[],                                              recorded agent commands / tool args text
 *   shimEntries: [{argv, cwd}], sinkEntries: [{host, path, body}],          surface 5, optional
 *   sessions: [{pid, sessionId, cwd, alive, operator}],                      session registry at cell end
 *   uncoveredEffectKinds: string[],                                          e.g. ["read"] on macOS
 *   surfaces: { home, tmpdir, tmp, shim, sink }                              what was inventoried (paths or false)
 * }
 */
export function classifyIsolation(input) {
  const { runtime, trialRoot, changes = [], fixture = { pathFingerprints: [], contentFingerprints: [] }, scenarioCommands = [], shimEntries = [], sinkEntries = [], sessions = [], uncoveredEffectKinds = [], surfaces = {} } = input;
  // Two spellings of every path (resolved and real) so that a trial root under /var/folders (real: /private/var/...)
  // matches an argv that names it either way, including paths that do not exist yet.
  const forms = (p) => { const out = new Set([resolve(p)]); try { out.add(realpathSync(p)); } catch { /* not on disk */ } return [...out]; };
  const trialForms = forms(trialRoot); const trial = trialForms[trialForms.length - 1];
  const insideTrial = (p) => forms(p).some((r) => trialForms.some((t) => r === t || r.startsWith(t + sep)));
  const pathTie = (p) => fixture.pathFingerprints.find((f) => f && p.includes(f));
  const contentTie = (p) => { const t = readSmallText(p); if (t == null) return null; return [...fixture.contentFingerprints, ...scenarioCommands].find((f) => f && f.length >= 4 && t.includes(f)) ?? null; };

  const breaches = [], leaks = [], attributed = [], unattributed = [], scenarioEffectsInsideTrial = [];
  for (const c of changes) {
    if (insideTrial(c.path)) { scenarioEffectsInsideTrial.push(c.path); continue; } // surface 1 territory, not this dimension's
    const pt = pathTie(c.path);
    const ct = c.change === "removed" ? null : contentTie(c.path);
    if (pt || ct) { breaches.push({ ...c, tie: pt ? `path carries fixture fingerprint "${pt}"` : `content carries scenario fingerprint "${ct}"` }); continue; }
    const mech = (RUNTIME_MECHANISMS[runtime] || []).find((m) => m.test(c.path));
    if (mech) { leaks.push({ ...c, mechanism: mech.name, attribution: "mechanism (artefact naming/content); process instance not recorded" }); continue; }
    const sess = sessions.find((s) => s.alive && ((s.sessionId && c.path.includes(String(s.sessionId))) || c.path.includes(`/sessions/${s.pid}.`)));
    if (sess) { attributed.push({ ...c, attribution: `session registry: pid ${sess.pid}${sess.operator ? " (operator)" : ""}, cwd ${sess.cwd ?? ""}` }); continue; }
    const op = OPERATOR_MECHANISMS.find((m) => m.test(c.path));
    if (op) { const mk = op.marker?.(c.path); attributed.push({ ...c, attribution: `mechanism: ${op.name}${mk ? `; ${mk}` : ""}; process instance not recorded` }); continue; }
    unattributed.push({ ...c });
  }
  // Surface 5: a shim argv or a sink request pointing outside the trial root is a scenario effect outside it.
  for (const e of shimEntries) { const outside = (e.argv || []).filter((a) => a.startsWith("/") && !insideTrial(a)); if (outside.length) breaches.push({ path: outside.join(" "), change: "process", tie: `shim argv names a path outside the trial root: ${e.argv.join(" ")}` }); }
  for (const e of sinkEntries) breaches.push({ path: `${e.host}${e.path ?? ""}`, change: "network", tie: `request reached the sink${e.body ? " with a body" : ""}` });

  const scenario_isolation = breaches.length
    ? { value: "BREACHED", findings: breaches, basis: "a scenario-relevant effect was found outside the trial root (tie given per finding)" }
    : uncoveredEffectKinds.length
      ? { value: "UNKNOWN", findings: [], basis: `the surface cannot cover these effect kinds here: ${uncoveredEffectKinds.join(", ")}` }
      : { value: "HELD", findings: [], basis: "no scenario-relevant effect outside the trial root on the inventoried surface" };
  const runtime_containment = leaks.length
    ? { value: "LEAKED", findings: leaks, basis: `runtime-owned state written outside the trial home (${leaks.length} entries); scenario-bearing content checked per entry and not found (any hit is reported under scenario_isolation instead)` }
    : { value: "CONTAINED", findings: [], basis: "no runtime-owned write outside the trial home on the inventoried surface" };
  const operator_environment_contamination = unattributed.length
    ? { value: "NOISY-UNATTRIBUTED", findings: { attributed, unattributed }, basis: `${unattributed.length} change(s) outside the trial root that neither the scenario, the runtime nor a known operator mechanism explains` }
    : attributed.length
      ? { value: "NOISY-ATTRIBUTED", findings: { attributed, unattributed: [] }, basis: "every unexplained-by-scenario-or-runtime change is tied to a live session or a known operator mechanism" }
      : { value: "QUIET", findings: { attributed: [], unattributed: [] }, basis: "no change outside the trial root left unexplained" };

  return {
    evidence_surface: { trial_root: trial, home_full_depth: surfaces.home ?? false, tmpdir_depth1_with_window_descent: surfaces.tmpdir ?? false, tmp_depth1_with_window_descent: surfaces.tmp ?? false, shim_log: surfaces.shim ?? false, sink_log: surfaces.sink ?? false, excluded: surfaces.excluded ?? [], not_scanned: "the rest of /var/folders, other mounts" },
    scenario_isolation, runtime_containment, operator_environment_contamination,
    scenario_effects_inside_trial_root: scenarioEffectsInsideTrial,
    cell_valid_by_isolation: scenario_isolation.value !== "BREACHED",
    limitations: [
      "transient-write blindness: a before/after inventory cannot see an entry created and removed inside the cell window; no continuous file-system watch in this step",
      "temp roots are depth-1 surfaces: a change inside a pre-existing depth-1 entry that was not modified in the window is outside the surface; inside a descended entry only children modified in the window are recorded (no pre-run recursive inventory of temp entries)",
      "runtime and operator attribution is by artefact mechanism, not by process identity",
    ],
  };
}
