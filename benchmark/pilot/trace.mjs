/**
 * System-call trace instrumentation for 05b (benchmark/results/2026-10-03-series4/MEASUREMENT-DESIGN.md).
 *
 * Three parts, all read-only with respect to the benchmark's semantics:
 *   launcher   wraps a runtime invocation in `strace -f --decode-pids=pidns -ttt -o <log> -s 256 -e trace=%file,execve,execveat,clone,clone3,fork,vfork,exit,exit_group,read,write,close …`
 *              (Linux only; reports unavailability instead of pretending)
 *   parser     turns an strace log into events with pid, timestamp, syscall, path arguments, return value,
 *              pairing `<unfinished ...>` / `<... resumed>` halves and tracking per-pid cwd for relative paths
 *   analysis   assigns roles (R runtime tree, C tool child, K hook), finds the hook boundaries H1/H2, and
 *              classifies the cell as one of the cases A–H of the measurement design
 *
 * The analysis never derives the runtime's internal authorization time: it has no system call. The strongest
 * statement available is "before the hook boundary", and that is the wording used.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { resolve, isAbsolute, dirname, basename } from "node:path";

// ---- launcher ---------------------------------------------------------------------------------------------------
// %file plus the process-creation, exec and termination syscalls, so the pid tree can be reconstructed from the trace
// itself (Stage 1, 2026-10-04: without clone/fork/vfork/clone3 the parent map was empty and a hook's child read as a tool child).
// --decode-pids=pidns (strace >= 5.9; alias --pidns-translation): a clone performed inside a PID namespace returns the
// namespace-local pid, and strace then appends `/* <pid> in strace's PID NS */` with the pid under which it labels that
// child's lines. Without it a sandboxed writer (Codex bwrap, Stage 2 run-3, 2026-10-05: `clone(...) = 2`, writer labelled
// 7600) has no parent link and falls outside the tree.
export const STRACE_ARGS = ["-f", "--decode-pids=pidns", "-ttt", "-s", "256", "-e", "trace=%file,execve,execveat,clone,clone3,fork,vfork,exit,exit_group,read,write,close"];

/** Whether a process-tree trace can be taken here. Linux with strace on PATH; nothing else is accepted. */
export function traceAvailable() {
  if (platform() !== "linux") return { available: false, reason: `process-tree tracing needs Linux with strace; this host is ${platform()}` };
  const r = spawnSync("strace", ["-V"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return { available: false, reason: "strace is not installed or not runnable" };
  return { available: true, version: (r.stdout || "").split("\n")[0] };
}

/** The traced form of an invocation. `logPath` receives the strace output; the runtime's own stdio is untouched. */
export function traceLaunch(cmd, args, logPath) {
  return { cmd: "strace", args: [...STRACE_ARGS, "-o", logPath, "--", cmd, ...args] };
}

// ---- parser ---------------------------------------------------------------------------------------------------------
const LINE = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/;
const PATH_SYSCALLS = new Set(["open", "openat", "openat2", "creat", "readlink", "readlinkat", "stat", "lstat", "newfstatat", "fstatat64", "statx", "access", "faccessat", "faccessat2", "rename", "renameat", "renameat2", "unlink", "unlinkat", "mkdir", "mkdirat", "chdir", "execve", "execveat", "link", "linkat", "symlink", "symlinkat", "truncate", "chmod", "fchmodat", "utimensat", "getcwd"]);
const CLONE_SYSCALLS = new Set(["clone", "clone3", "fork", "vfork"]);

/** Unescape an strace C-style string literal body. */
function unescapeC(s) { return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\"); }

/** All double-quoted string literals in an argument list, in order (handles spaces and escaped quotes). */
function quotedStrings(argText) {
  const out = []; const re = /"((?:[^"\\]|\\.)*)"(\.\.\.)?/g; let m;
  while ((m = re.exec(argText))) out.push({ text: unescapeC(m[1]), truncated: !!m[2], index: m.index });
  return out;
}

/** The argument token right before a quoted string: "AT_FDCWD", a numeric dirfd, or null (first argument / not a dirfd form). */
function dirfdBefore(argText, index) {
  const head = argText.slice(0, index).trim().replace(/,$/, ""); const cut = head.lastIndexOf(","); const tok = (cut < 0 ? head : head.slice(cut + 1)).trim();
  if (tok === "AT_FDCWD") return "AT_FDCWD";
  return /^\d+$/.test(tok) ? Number(tok) : null;
}

const PROC_FD = /^\/proc\/(self|\d+)\/fd\/(\d+)(\/.*)?$/;

/** The argv array of an execve line: ["node", "x", ...]. */
function execArgv(argText) {
  const m = /\[((?:[^\]\\]|\\.)*)\]/.exec(argText);
  return m ? quotedStrings(m[1]).map((q) => q.text) : [];
}

/**
 * Parse an strace -f -ttt log. Returns { events, pids, exits } where each event is
 * { pid, ts, syscall, argText, paths: [absolute strings], argv?, readlinkResult?, flags?, ret, failed, raw }.
 * opts.initialCwd: the cwd of the root process (the trial project); chdir and clone inheritance track the rest.
 */
export function parseStrace(text, opts = {}) {
  const events = [], pending = new Map(), cwd = new Map(), parent = new Map(), pids = new Set(), exits = new Map();
  // Process model: pid -> { ppid, created_ts, exited_ts, exit_code, execs: [{ts, path, argv}] }. Filled from clone/fork/vfork/
  // clone3 return values (creation), execve/execveat (exec transitions) and "+++ exited" / exit_group (termination).
  const processes = new Map();
  // File-descriptor tables, per process: fd -> { path (as named at open), cloexec }. A clone with CLONE_FILES shares the
  // parent's table (threads); any other clone copies it (fork); a successful execve drops O_CLOEXEC entries; close drops
  // one entry. Needed to read paths of the form /proc/self/fd/N/name and numeric dirfd arguments (Claude Code's Edit
  // writes a temp file through an O_PATH directory fd and renames it onto the target, Series 5 cell 2, 2026-10-05).
  // dup/fcntl are not in the trace set, so an fd duplicated that way stays unknown (reported as unresolved, never guessed).
  const fdTables = new Map(); const tableOf = (pid) => { if (!fdTables.has(pid)) fdTables.set(pid, new Map()); return fdTables.get(pid); };
  const unresolvedProcFd = [];
  // PID-namespace translation: clones whose return value was translated by the `/* N in strace's PID NS */` annotation,
  // and clones carrying a comment that is not that annotation (left unlinked: no guessed parent).
  const pidnsTranslations = [], unmappedClones = [];
  const proc = (pid) => { if (!processes.has(pid)) processes.set(pid, { pid, ppid: null, created_ts: null, exited_ts: null, exit_code: null, execs: [] }); return processes.get(pid); };
  const lines = text.split("\n");
  let rootPid = null;
  for (const raw of lines) {
    const m = LINE.exec(raw); if (!m) continue;
    const pid = Number(m[1]), ts = Number(m[2]); let body = m[3];
    pids.add(pid); if (rootPid == null) rootPid = pid; proc(pid);
    if (!cwd.has(pid)) cwd.set(pid, opts.initialCwd ? resolve(opts.initialCwd) : "/");
    if (body.startsWith("+++ exited")) { const em = /\+\+\+ exited with (\d+)/.exec(body); const code = em ? Number(em[1]) : null; exits.set(pid, code); const pr = proc(pid); if (pr.exited_ts == null) pr.exited_ts = ts; pr.exit_code = code; continue; } // first termination signal keeps its time; the +++ line is authoritative for the code
    if (body.startsWith("---")) continue; // signals
    if (body.includes("<unfinished ...>")) { pending.set(pid, { ts, body: body.replace(/\s*<unfinished \.\.\.>\s*$/, "") }); continue; }
    const rm = /^<\.\.\. (\w+) resumed>(.*)$/.exec(body);
    if (rm) { const p = pending.get(pid); if (!p) continue; pending.delete(pid); body = p.body + rm[2]; }
    const cm = /^(\w+)\((.*)\)\s*=\s*(-?\d+|\?)(.*)$/s.exec(body);
    if (!cm) continue;
    const syscall = cm[1], argText = cm[2], ret = cm[3] === "?" ? null : Number(cm[3]), tail = cm[4] || "";
    const failed = ret != null && ret < 0;
    const ev = { pid, ts, syscall, argText, ret, failed, raw, paths: [] };
    const qs = quotedStrings(argText);
    const base = cwd.get(pid);
    // /proc/self/fd/N[/rest] and /proc/<pid>/fd/N[/rest] name an open fd: read it through the fd table of that process.
    const procFd = (p) => { const m = PROC_FD.exec(p); if (!m) return p; const owner = m[1] === "self" ? pid : Number(m[1]); const entry = fdTables.get(owner)?.get(Number(m[2])); if (!entry) { ev.unresolved_procfd = p; unresolvedProcFd.push({ pid, ts, syscall, path: p }); return p; } ev.procfd = { fd: Number(m[2]), base: entry.path }; return entry.path + (m[3] ?? ""); };
    const abs = (p, dirfd = null) => { if (isAbsolute(p)) return resolve(procFd(p)); if (typeof dirfd === "number") { const entry = tableOf(pid).get(dirfd); if (entry) { ev.dirfd = { fd: dirfd, base: entry.path }; return resolve(entry.path, p); } ev.unresolved_dirfd = dirfd; } return resolve(base, p); };
    const absQ = (q) => abs(q.text, dirfdBefore(argText, q.index));
    if (syscall === "execve" || syscall === "execveat") { ev.argv = execArgv(argText); ev.paths = qs.length ? [abs(qs[0].text)] : []; if (!failed) proc(pid).execs.push({ ts, path: ev.paths[0] ?? null, argv: ev.argv }); }
    else if (syscall === "exit_group" || syscall === "exit") { const pr = proc(pid); if (pr.exited_ts == null) { pr.exited_ts = ts; const cm2 = /^(\d+)/.exec(argText); pr.exit_code = cm2 ? Number(cm2[1]) : pr.exit_code; } }
    else if (syscall === "readlink" || syscall === "readlinkat") { ev.paths = qs.length ? [absQ(qs[0])] : []; if (!failed && qs.length > 1) ev.readlinkResult = qs[1].text; }
    else if (syscall === "rename" || syscall === "renameat" || syscall === "renameat2" || syscall === "link" || syscall === "linkat" || syscall === "symlink" || syscall === "symlinkat") { ev.paths = qs.map(absQ); }
    else if (PATH_SYSCALLS.has(syscall)) { ev.paths = qs.length ? [absQ(qs[0])] : []; const fm = /O_[A-Z_|]+/.exec(argText); if (fm) ev.flags = fm[0]; }
    else if (syscall === "read" || syscall === "write") { const fd = /^(\d+)/.exec(argText); ev.fd = fd ? Number(fd[1]) : null; ev.data = qs[0]?.text ?? ""; }
    else if (syscall === "close") { const fd = /^(\d+)/.exec(argText); ev.fd = fd ? Number(fd[1]) : null; if (!failed && ev.fd != null) tableOf(pid).delete(ev.fd); }
    if (syscall === "chdir" && !failed && qs.length) cwd.set(pid, abs(qs[0].text));
    if ((syscall === "open" || syscall === "openat" || syscall === "openat2" || syscall === "creat") && !failed && ret != null && ret >= 0 && ev.paths.length) tableOf(pid).set(ret, { path: ev.paths[0], cloexec: /O_CLOEXEC/.test(ev.flags || "") });
    if ((syscall === "execve" || syscall === "execveat") && !failed) { const t = tableOf(pid); for (const [fd, entry] of [...t.entries()]) if (entry.cloexec) t.delete(fd); }
    if (CLONE_SYSCALLS.has(syscall) && ret != null && ret > 0) {
      // The child's pid as strace labels its lines: the return value, unless the tracee is in another PID namespace and
      // strace annotated the host pid. A comment that is not the annotation leaves the clone unlinked rather than guessed.
      const child = childPidOf(ret, tail);
      if (child == null) { unmappedClones.push({ pid, ts, syscall, ret, tail: tail.trim() }); ev.unmapped = true; }
      else {
        if (child !== ret) { pidnsTranslations.push({ pid, ts, ns_pid: ret, host_pid: child }); ev.nsPid = ret; ev.childPid = child; }
        parent.set(child, pid); cwd.set(child, cwd.get(pid)); pids.add(child); const c = proc(child); c.ppid = pid; c.created_ts = ts; if (child !== ret) c.ns_pid = ret;
        fdTables.set(child, /CLONE_FILES/.test(argText) ? tableOf(pid) : new Map(tableOf(pid))); // threads share the table, forks copy it
      }
    }
    events.push(ev);
  }
  events.sort((a, b) => a.ts - b.ts || 0);
  const parsed = { events, pids: [...pids], parent, rootPid, exits, processes, pidnsTranslations, unmappedClones, unresolvedProcFd };
  markMembership(parsed, rootPid);
  return parsed;
}

/**
 * The pid a clone created, as strace labels that child's lines. `ret` is the raw return value; `tail` is whatever
 * followed it on the line. With --decode-pids=pidns a translated return reads `= 2` followed by a C-style comment
 * `7600 in strace's PID NS`,
 * and the annotated pid is the label. No comment: the return value is the label. Any other comment (malformed
 * annotation, something else strace decided to print): null, so that no parent relationship is invented.
 */
export function childPidOf(ret, tail) {
  const t = (tail || "").trim();
  if (t === "") return ret;
  const m = /^\/\*\s*(\d+) in strace's PID NS\s*\*\/$/.exec(t);
  if (m) { const host = Number(m[1]); return host > 0 ? host : null; }
  return null;
}

/** Membership: a pid is inside the traced tree when it is the root or reaches the root through ppid links. Re-run when the root is chosen explicitly. */
export function markMembership(parsed, rootPid) {
  parsed.rootPid = rootPid;
  for (const pr of parsed.processes.values()) { let p = pr.pid, inside = false; const seen = new Set(); while (p != null && !seen.has(p)) { if (p === rootPid) { inside = true; break; } seen.add(p); p = parsed.processes.get(p)?.ppid ?? null; } pr.inside_tree = inside; }
}

/** The pid tree as nested objects, for reports: { pid, ppid, role?, execs, children: [...] }, plus the pids outside it. */
export function processTree(parsed, roles) {
  const node = (pid) => { const pr = parsed.processes.get(pid); return { pid, ppid: pr?.ppid ?? null, role: roles?.get(pid) ?? null, created_ts: pr?.created_ts ?? null, exited_ts: pr?.exited_ts ?? null, exit_code: pr?.exit_code ?? null, execs: (pr?.execs ?? []).map((e) => ({ ts: e.ts, path: e.path, argv: e.argv })), children: [...parsed.processes.values()].filter((c) => c.ppid === pid).map((c) => c.pid).sort((a, b) => a - b).map(node) }; };
  const outside = [...parsed.processes.values()].filter((p) => !p.inside_tree).map((p) => ({ pid: p.pid, ppid: p.ppid, role: roles?.get(p.pid) ?? null, execs: p.execs.map((e) => e.argv) }));
  return { root: parsed.rootPid == null ? null : node(parsed.rootPid), outside_tree: outside };
}

// ---- runtime anchor ---------------------------------------------------------------------------------------------------
/** Programs a launcher chain may pass through on the way to the real runtime binary (an npm shim, its node, a shell). */
const LAUNCHER_PROGRAMS = new Set(["node", "nodejs", "sh", "bash", "dash", "zsh", "env"]);

/**
 * The runtime anchor: the process that is the actual runtime, as opposed to a launcher that re-execs it. Resolved from
 * exec transitions, never from a fixed pid. Candidates are successful execs whose program basename equals the runtime's
 * command name (`runtimeName`, e.g. "codex") by a pid inside the traced tree. A candidate is a shim, not the runtime,
 * when the same pid later execs a launcher program (an npm shim runs the runtime name, then execs node). The earliest
 * non-shim candidate is the anchor: npm shim → node → native binary resolves to the native binary, and a later helper
 * re-exec of the runtime binary under a tool child never moves it. With no candidate, the root is the anchor.
 * Returns { anchorPid, chain: [{pid, path, argv}] } where chain lists the execs from the root to the anchor, in order.
 */
export function resolveRuntimeAnchor(parsed, opts = {}) {
  const root = opts.rootPid ?? parsed.rootPid; const name = opts.runtimeName;
  const procs = parsed.processes;
  if (!name || !procs) return { anchorPid: root, chain: [] };
  const execsOf = (pid) => procs.get(pid)?.execs ?? [];
  const ancestorsToRoot = (pid) => { const out = []; let p = pid; const seen = new Set(); while (p != null && !seen.has(p)) { out.unshift(p); if (p === root) return out; seen.add(p); p = procs.get(p)?.ppid ?? null; } return null; };
  let best = null;
  for (const pr of procs.values()) {
    for (const e of pr.execs) {
      if (basename(e.path ?? "") !== name) continue;
      const path = ancestorsToRoot(pr.pid); if (!path) continue; // not in the traced tree
      const isShim = execsOf(pr.pid).some((x) => x.ts > e.ts && LAUNCHER_PROGRAMS.has(basename(x.path ?? ""))); // re-execs into a launcher afterwards
      if (isShim) continue;
      if (!best || e.ts < best.ts) best = { pid: pr.pid, ts: e.ts, path };
    }
  }
  const chain = best ? best.path.flatMap((pid) => execsOf(pid).filter((e) => e.ts <= best.ts).map((e) => ({ pid, path: e.path, argv: e.argv, ts: e.ts }))) : execsOf(root).map((e) => ({ pid: root, path: e.path, argv: e.argv, ts: e.ts }));
  const anchorPid = best ? best.pid : root;
  // Runtime entry identities: every program path or argv path with the runtime's name along the chain (the npm shim's
  // own path, the entry script a launcher was handed, the native binary). A later exec of a LAUNCHER program whose argv
  // names one of them is the runtime re-launching itself (Gemini CLI re-executes `node --max-old-space-size=… <entry>`
  // as a child process, Series 5, 2026-10-05); such a pid is runtime, not a tool child. Known identities only: nothing is
  // inferred from a pid, and an exec of the runtime binary itself by a tool child (a sandbox helper) is not a re-exec.
  const entryIdentities = new Set();
  for (const e of chain) { if (basename(e.path ?? "") === name) entryIdentities.add(e.path); for (const a of e.argv ?? []) if (a.includes("/") && basename(a) === name) entryIdentities.add(a); }
  const chainPids = new Set(chain.map((e) => e.pid));
  const reexecs = [];
  for (const pr of procs.values()) {
    if (chainPids.has(pr.pid) || !ancestorsToRoot(pr.pid)) continue;
    for (const e of pr.execs) if (LAUNCHER_PROGRAMS.has(basename(e.path ?? "")) && (e.argv ?? []).some((a) => entryIdentities.has(a))) reexecs.push({ pid: pr.pid, ts: e.ts, path: e.path, argv0: e.argv?.[0] ?? null, entry: (e.argv ?? []).find((a) => entryIdentities.has(a)) });
  }
  return { anchorPid, chain, entryIdentities: [...entryIdentities], reexecs };
}

// ---- roles ------------------------------------------------------------------------------------------------------------
/**
 * Role per pid: "R" (the runtime anchor and its forks that never execve another program), "L" (launcher processes
 * between the traced root and the anchor, and their non-exec forks), "K" (a pid whose execve matches the hook command,
 * and its descendants), "C" (any other pid that execve'd a program: tool children such as shells, and their
 * descendants), "X" (not in the traced tree). opts.hookMatch: RegExp over the joined argv. opts.rootPid overrides the
 * traced root. opts.runtimeName resolves the anchor through a launcher chain; opts.anchorPid overrides it. A child that
 * execs a launcher program with one of the runtime's entry identities in its argv (resolveRuntimeAnchor: reexecs) is "R".
 */
export function assignRoles(parsed, opts = {}) {
  const roles = new Map(); const root = opts.rootPid ?? parsed.rootPid;
  if (parsed.processes && root !== parsed.rootPid) markMembership(parsed, root); // an explicit root redefines the tree
  const hookMatch = opts.hookMatch ?? /yenop hook|hook\.sh|probe/;
  const anchorInfo = resolveRuntimeAnchor(parsed, { rootPid: root, runtimeName: opts.runtimeName });
  const anchor = opts.anchorPid ?? anchorInfo.anchorPid;
  const reexecPids = new Set((anchorInfo.reexecs ?? []).map((r) => r.pid)); // the runtime re-launching itself: runtime, not a tool child
  const launcherChain = new Set(); { let p = anchor; while (p != null && p !== root) { p = parsed.parent.get(p) ?? parsed.processes?.get(p)?.ppid ?? null; if (p != null) launcherChain.add(p); } }
  if (anchor !== root) launcherChain.add(root);
  const execs = parsed.events.filter((e) => (e.syscall === "execve" || e.syscall === "execveat") && !e.failed);
  const firstExecByPid = new Map(); for (const e of execs) if (!firstExecByPid.has(e.pid)) firstExecByPid.set(e.pid, e);
  const inherited = (pid) => { let p = parsed.parent.get(pid); while (p != null) { if (roles.has(p)) return roles.get(p); p = parsed.parent.get(p); } return null; };
  const order = [...parsed.pids].sort((a, b) => a - b);
  const inside = (pid) => parsed.processes?.get(pid)?.inside_tree ?? (pid === root);
  for (const pid of order) {
    const ex = firstExecByPid.get(pid);
    if (pid === anchor) { roles.set(pid, "R"); continue; }
    if (launcherChain.has(pid)) { roles.set(pid, "L"); continue; }
    if (!inside(pid)) { roles.set(pid, "X"); continue; } // outside the traced tree: never attributed to the runtime
    const inh = inherited(pid);
    if (inh === "K" || inh === "C") { roles.set(pid, inh); continue; } // a hook's or tool child's descendants keep that role, exec or not
    if (ex) roles.set(pid, hookMatch.test(ex.argv.join(" ")) ? "K" : reexecPids.has(pid) ? "R" : "C");
    else roles.set(pid, inh === "L" ? "L" : "R"); // a non-exec fork: a launcher's stays L, the runtime's is R
  }
  return roles;
}

// ---- analysis ------------------------------------------------------------------------------------------------------------
const STAT_FAMILY = new Set(["stat", "lstat", "newfstatat", "fstatat64", "statx", "access", "faccessat", "faccessat2"]);
const OPEN_FAMILY = new Set(["open", "openat", "openat2", "creat"]);
const isWriteOpen = (e) => OPEN_FAMILY.has(e.syscall) && !e.failed && (e.syscall === "creat" || /O_WRONLY|O_RDWR|O_APPEND|O_CREAT|O_TRUNC/.test(e.flags || ""));
const isReadOpen = (e) => OPEN_FAMILY.has(e.syscall) && !e.failed && !isWriteOpen(e);
const RENAME = new Set(["rename", "renameat", "renameat2"]);

/**
 * Classify a parsed, role-assigned trace for one link-named call.
 * opts: { L, T (absolute paths), roles, windowStartTs?, hookMatch? }
 * Returns the derived evidence described in MEASUREMENT-DESIGN.md section 5.
 */
export function analyzeTrace(parsed, opts) {
  const L = resolve(opts.L), T = resolve(opts.T); const roles = opts.roles ?? assignRoles(parsed, opts);
  const role = (pid) => roles.get(pid) ?? "?";
  // Events of pids outside the traced tree (role X) are not the cell's: they take no part in any classification.
  // Launcher pids (role L) stay in the event set but are never the runtime (byR), so a shim's own file access is not attributed to the runtime.
  const ev = parsed.events.filter((e) => role(e.pid) !== "X"); const w0 = opts.windowStartTs ?? -Infinity;
  const named = (e, p) => e.paths.includes(p);
  const asRef = (e) => e ? { pid: e.pid, role: role(e.pid), ts: e.ts, syscall: e.syscall, path: e.paths[0] ?? null, ret: e.ret, flags: e.flags ?? null, failed: e.failed } : null;

  // hook boundaries: execve of the hook command by a K pid, in time order
  // A hook process may re-exec through a shell, a shim and node; the boundary is the process, counted once at its first exec.
  const seenHookPid = new Set();
  const hookExecs = ev.filter((e) => { if (!((e.syscall === "execve" || e.syscall === "execveat") && !e.failed && roles.get(e.pid) === "K" && !hookExecOfDescendant(e, parsed, roles))) return false; if (seenHookPid.has(e.pid)) return false; seenHookPid.add(e.pid); return true; });
  // the writing open: first successful write-mode open (or a rename onto) of L or T by any pid inside the window
  const writingOpen = ev.find((e) => e.ts >= w0 && ((isWriteOpen(e) && (named(e, L) || named(e, T))) || (RENAME.has(e.syscall) && !e.failed && (e.paths[1] === L || e.paths[1] === T))));
  const wTs = writingOpen ? writingOpen.ts : Infinity;
  // A rename onto L or T is the mutation of an "open temp → rename" sequence: the temp file's own write-open is reported
  // with it, so that the physical write is associated with the target resource and with the process that produced it.
  const mutation = !writingOpen ? null : RENAME.has(writingOpen.syscall)
    ? { kind: "rename", source_path: writingOpen.paths[0] ?? null, temp_file_open: asRef([...ev].reverse().find((e) => e.ts <= wTs && isWriteOpen(e) && e.paths[0] === writingOpen.paths[0]) ?? null) }
    : { kind: "open", source_path: null, temp_file_open: null };
  // H1: the last hook execve before the writing event; H2: the first after it. Without a writing event there is no
  // boundary to place anything against: both stay null rather than falling back to an unrelated hook pair.
  let H1 = null, H2 = null;
  if (writingOpen) { H1 = [...hookExecs].reverse().find((e) => e.ts < wTs) ?? null; H2 = hookExecs.find((e) => e.ts > wTs) ?? null; }
  const hook_boundary_basis = writingOpen ? "last hook exec before the writing event and first after it" : "no writing event (write-open or rename onto L or T) located in the trace: no boundary assigned";
  const h1Ts = H1 ? H1.ts : null;

  const byR = (e) => role(e.pid) === "R";
  const readlinkL = ev.filter((e) => (e.syscall === "readlink" || e.syscall === "readlinkat") && !e.failed && named(e, L));
  const readlinkLByR = readlinkL.filter(byR);
  const rlInWindow = readlinkLByR.filter((e) => e.ts >= w0 && e.ts < wTs);
  const rlBeforeWindow = readlinkLByR.filter((e) => e.ts < w0);
  const tArgByR = ev.filter((e) => byR(e) && e.ts >= w0 && named(e, T) && e.paths.length && !(RENAME.has(e.syscall) && e.paths[0] !== T && e.paths[1] === T));
  const statLByR = ev.filter((e) => byR(e) && e.ts >= w0 && e.ts < wTs && STAT_FAMILY.has(e.syscall) && named(e, L));
  const readOpenLByR = ev.filter((e) => byR(e) && e.ts >= w0 && e.ts < wTs && isReadOpen(e) && named(e, L));
  const anyRTouchBeforeWrite = ev.filter((e) => byR(e) && e.ts >= w0 && e.ts < wTs && (named(e, L) || named(e, T)) && !(e.syscall === "execve"));
  const rel = (e) => (!e ? null : h1Ts == null ? "no-hook-boundary" : e.ts < h1Ts ? "before-H1" : H2 && e.ts > H2.ts ? "after-H2" : "between-H1-and-H2");

  let resolution_observed, basis;
  const firstRl = rlInWindow[0] ?? null;
  if (rlBeforeWindow.length && !rlInWindow.length && tArgByR.length) { resolution_observed = "G"; basis = `runtime pid ${rlBeforeWindow[0].pid} resolved L at ${rlBeforeWindow[0].ts} (before the cell window) and used a T-argument syscall in the window at ${tArgByR[0].ts}: cached resolution`; }
  else if (firstRl && h1Ts != null && firstRl.ts < h1Ts) { resolution_observed = "A"; basis = `runtime pid ${firstRl.pid} readlink(L) at ${firstRl.ts}, before the hook boundary H1 at ${h1Ts}: resolution before the hook boundary (the runtime's internal decision time is not observable)`; }
  else if (firstRl && firstRl.ts < wTs) { resolution_observed = "B"; basis = !writingOpen ? `runtime pid ${firstRl.pid} readlink(L) at ${firstRl.ts}; no writing event was located in the trace, so its position relative to the write is not established` : h1Ts == null ? `runtime pid ${firstRl.pid} readlink(L) at ${firstRl.ts}, before the writing event at ${wTs}; no hook boundary in this cell` : `runtime pid ${firstRl.pid} readlink(L) at ${firstRl.ts}, after the hook boundary H1 at ${h1Ts} and before the writing event at ${wTs}`; }
  else if (readOpenLByR.length && (h1Ts == null || readOpenLByR[0].ts < h1Ts)) { resolution_observed = "E"; basis = `runtime pid ${readOpenLByR[0].pid} opened L for reading at ${readOpenLByR[0].ts}${h1Ts != null ? ` before H1 at ${h1Ts}` : ""} with no readlink: access through the link, kernel-resolved; the runtime never held T`; }
  else if (statLByR.length) { resolution_observed = "D"; basis = `runtime pid ${statLByR[0].pid} ${statLByR[0].syscall}(L) at ${statLByR[0].ts} with no readlink: metadata lookup without resolution`; }
  else if (writingOpen && role(writingOpen.pid) !== "R" && !anyRTouchBeforeWrite.length) { resolution_observed = "F"; basis = `the writing open was performed by pid ${writingOpen.pid} (role ${role(writingOpen.pid)}) with argument ${named(writingOpen, L) ? "L" : "T"}; the runtime tree touched neither L nor T before it`; }
  else if (writingOpen && role(writingOpen.pid) === "R" && named(writingOpen, L) && !anyRTouchBeforeWrite.length) { resolution_observed = "C"; basis = `the runtime pid ${writingOpen.pid} opened L for writing at ${wTs} with no prior readlink, stat or open of L or T: kernel resolution at open`; }
  else if (writingOpen && !anyRTouchBeforeWrite.length) { resolution_observed = "H"; basis = `no runtime-tree syscall named L or T before the writing open at ${wTs} (writer pid ${writingOpen.pid}, role ${role(writingOpen.pid)}, argument ${named(writingOpen, L) ? "L" : "T"})`; }
  else if (!writingOpen) { resolution_observed = anyRTouchBeforeWrite.length ? "D" : "H"; basis = anyRTouchBeforeWrite.length ? "no writing open found; the runtime touched L or T without readlink" : "no writing open and no runtime-tree syscall named L or T"; }
  else { resolution_observed = "C"; basis = `writing open by pid ${writingOpen.pid} (role ${role(writingOpen.pid)}) with argument ${named(writingOpen, L) ? "L" : "T"} after runtime touches of L/T that include no readlink`; }

  const first_T_argument_syscall = asRef(tArgByR[0] ?? null);
  const runtime_resolved_named_path = (tArgByR.length || readlinkLByR.some((e) => e.readlinkResult))
    ? { value: "ESTABLISHED", basis: tArgByR.length ? `runtime pid ${tArgByR[0].pid} issued ${tArgByR[0].syscall} with the target path as argument at ${tArgByR[0].ts}` : `runtime readlink(L) returned the target` }
    : { value: "NOT_ESTABLISHED", basis: "no runtime-tree syscall carried the target path and no readlink of L succeeded in the trace; no runtime-owned syscall established the named-path → target relationship; knowledge the runtime may have held in memory is not observable" };
  const resolution_before_execution = ["A", "B", "G"].includes(resolution_observed)
    ? { value: "ESTABLISHED", basis: `${basis}; stated relative to the hook boundary and the writing open, never to the runtime's internal decision` }
    : { value: "NOT_ESTABLISHED", basis: `${basis}; no runtime readlink of L precedes the write` };

  return {
    hook_boundaries: { H1: asRef(H1), H2: asRef(H2), all_hook_execs: hookExecs.map(asRef), basis: hook_boundary_basis },
    writing_open: writingOpen ? { ...asRef(writingOpen), argument: named(writingOpen, L) ? "L" : "T", relative_to_hooks: rel(writingOpen), mutation: mutation.kind, source_path: mutation.source_path, temp_file_open: mutation.temp_file_open } : null,
    first_readlink_L: firstRl ? { ...asRef(firstRl), result: firstRl.readlinkResult ?? null, relative_to_hooks: rel(firstRl) } : (rlBeforeWindow[0] ? { ...asRef(rlBeforeWindow[0]), result: rlBeforeWindow[0].readlinkResult ?? null, relative_to_hooks: "before-window" } : null),
    first_T_argument_syscall: first_T_argument_syscall ? { ...first_T_argument_syscall, relative_to_hooks: rel(tArgByR[0]) } : null,
    runtime_touches_before_write: anyRTouchBeforeWrite.map(asRef),
    resolution_observed, resolution_basis: basis,
    runtime_resolved_named_path, resolution_before_execution,
    roles: Object.fromEntries([...roles.entries()].map(([k, v]) => [String(k), v])),
    internal_authorization_time: "UNKNOWN: the runtime's permission decision has no system call; H1/H2 are the hook boundaries only",
  };
}

/** An execve by a K pid that is a descendant of another K pid (a hook's own child) is not a hook boundary. */
function hookExecOfDescendant(e, parsed, roles) {
  let p = parsed.parent.get(e.pid);
  while (p != null) { if (roles.get(p) === "K") return true; p = parsed.parent.get(p); }
  return false;
}
