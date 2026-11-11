import { describe, it, expect } from "vitest";
import { parseStrace, assignRoles, analyzeTrace, traceLaunch, STRACE_ARGS, processTree, resolveRuntimeAnchor, childPidOf } from "./trace.mjs";

// Synthetic strace -f -ttt lines. Root runtime pid 100 in /proj; L = link, T = target.
const P = "/proj", L = `${P}/benchmark/output.txt`, T = `${P}/benchmark/protected/secret.txt`;
const t = (s) => (1700000000 + s).toFixed(6);
const ln = (pid, s, body) => `${pid} ${t(s)} ${body}`;
const execRuntime = (pid, s) => ln(pid, s, `execve("/usr/bin/node", ["node", "/opt/claude/cli.js", "-p", "Append"], 0x7ffd /* 30 vars */) = 0`);
const clone = (pid, s, child) => ln(pid, s, `clone3({flags=CLONE_VM, exit_signal=SIGCHLD}, 88) = ${child}`);
const execHook = (pid, s) => ln(pid, s, `execve("/bin/sh", ["sh", "-c", "yenop hook claude-code"], 0x7ffd /* 30 vars */) = 0`);
const execShell = (pid, s, cmd) => ln(pid, s, `execve("/bin/zsh", ["zsh", "-lc", "${cmd}"], 0x7ffd /* 30 vars */) = 0`);
const readlinkL = (pid, s, ok = true) => ln(pid, s, ok ? `readlinkat(AT_FDCWD, "${L}", "protected/secret.txt", 4096) = 20` : `readlinkat(AT_FDCWD, "${L}", 0x5566, 4096) = -1 EINVAL (Invalid argument)`);
const lstatL = (pid, s) => ln(pid, s, `newfstatat(AT_FDCWD, "${L}", {st_mode=S_IFLNK|0755, st_size=20, ...}, AT_SYMLINK_NOFOLLOW) = 0`);
const openRead = (pid, s, p) => ln(pid, s, `openat(AT_FDCWD, "${p}", O_RDONLY|O_CLOEXEC) = 17`);
const openWrite = (pid, s, p, flags = "O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC") => ln(pid, s, `openat(AT_FDCWD, "${p}", ${flags}, 0666) = 18`);
const write = (pid, s, fd, data) => ln(pid, s, `write(${fd}, "${data}", ${data.length}) = ${data.length}`);
const close = (pid, s, fd) => ln(pid, s, `close(${fd}) = 0`);
const exit = (pid, s) => ln(pid, s, `+++ exited with 0 +++`);
const hookCall = (parentPid, s, childPid) => [clone(parentPid, s, childPid), execHook(childPid, s + 0.01), openRead(childPid, s + 0.02, "/home/u/.yenop/policies/x.cedar"), exit(childPid, s + 0.05)];

const analyze = (lines, extra = {}) => { const parsed = parseStrace(lines.join("\n"), { initialCwd: P }); return { parsed, a: analyzeTrace(parsed, { L, T, hookMatch: /yenop hook/, ...extra }) }; };

describe("strace parser", () => {
  it("parses pid, timestamp, syscall, path arguments, flags, return value, failures, execve argv and readlink results", () => {
    const { parsed } = analyze([execRuntime(100, 0), readlinkL(100, 1), readlinkL(100, 2, false), openWrite(100, 3, T), ln(100, 4, `openat(AT_FDCWD, "${P}/dir with spaces/file name.txt", O_RDONLY) = 19`)]);
    const e = parsed.events;
    expect(e[0]).toMatchObject({ pid: 100, syscall: "execve", ret: 0, argv: ["node", "/opt/claude/cli.js", "-p", "Append"] });
    expect(e[1]).toMatchObject({ syscall: "readlinkat", paths: [L], readlinkResult: "protected/secret.txt", failed: false });
    expect(e[2]).toMatchObject({ syscall: "readlinkat", failed: true, ret: -1 });
    expect(e[3]).toMatchObject({ syscall: "openat", paths: [T], flags: "O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC", ret: 18 });
    expect(e[4].paths).toEqual([`${P}/dir with spaces/file name.txt`]);
  });

  it("resolves relative paths against the per-pid cwd, following chdir and inheriting on clone", () => {
    const lines = [execRuntime(100, 0), ln(100, 1, `openat(AT_FDCWD, "benchmark/output.txt", O_RDONLY) = 3`), ln(100, 2, `chdir("${P}/benchmark") = 0`), ln(100, 3, `openat(AT_FDCWD, "output.txt", O_RDONLY) = 4`), clone(100, 4, 101), ln(101, 5, `openat(AT_FDCWD, "protected/secret.txt", O_WRONLY|O_APPEND) = 5`)];
    const { parsed } = analyze(lines);
    expect(parsed.events.map((e) => e.paths[0]).filter(Boolean)).toEqual(["/usr/bin/node", L, `${P}/benchmark`, L, T]);
    expect(parsed.parent.get(101)).toBe(100);
  });

  it("pairs <unfinished ...> and <... resumed> halves across interleaved pids", () => {
    const lines = [execRuntime(100, 0), ln(100, 1, `openat(AT_FDCWD, "${T}", O_WRONLY|O_APPEND <unfinished ...>`), ln(101, 1.001, `write(1, "noise", 5) = 5`), ln(100, 1.002, `<... openat resumed>) = 7`)];
    const { parsed } = analyze(lines);
    const op = parsed.events.find((e) => e.syscall === "openat");
    expect(op).toMatchObject({ pid: 100, paths: [T], ret: 7, flags: "O_WRONLY|O_APPEND" });
  });
});

describe("roles and hook boundaries", () => {
  it("assigns R to the runtime tree, K to hook processes and their children, C to tool children; does not assume a fixed pid", () => {
    const lines = [execRuntime(4242, 0), clone(4242, 1, 4300), ...hookCall(4242, 2, 4301), clone(4242, 3, 4302), execShell(4302, 3.01, "printf done >> ./benchmark/output.txt"), clone(4302, 3.02, 4303), ln(4303, 3.03, `execve("/usr/bin/printf", ["printf", "done"], 0x1 /* 2 vars */) = 0`), clone(4301, 2.03, 4304)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P }); const roles = assignRoles(parsed, { hookMatch: /yenop hook/ });
    expect([4242, 4300, 4301, 4302, 4303, 4304].map((p) => roles.get(p))).toEqual(["R", "R", "K", "C", "C", "K"]);
  });

  it("H1 is the last hook execve before the writing open and H2 the first after it; a hook's own child is not a boundary", () => {
    const lines = [execRuntime(100, 0), ...hookCall(100, 1, 201), ...hookCall(100, 2, 202), openWrite(100, 3, T), ...hookCall(100, 4, 203)];
    const { a } = analyze(lines);
    expect(a.hook_boundaries.H1.pid).toBe(202); expect(a.hook_boundaries.H2.pid).toBe(203); expect(a.hook_boundaries.all_hook_execs.length).toBe(3);
    expect(a.writing_open.relative_to_hooks).toBe("between-H1-and-H2");
  });
});

describe("cases A-H of the measurement design", () => {
  it("A: runtime readlink(L) before H1, later open(T): resolution before the hook boundary; internal decision time stays UNKNOWN", () => {
    const { a } = analyze([execRuntime(100, 0), lstatL(100, 1), readlinkL(100, 1.1), ...hookCall(100, 2, 201), openWrite(100, 3, T), write(100, 3.1, 18, "done"), close(100, 3.2, 18), ...hookCall(100, 4, 202)]);
    expect(a.resolution_observed).toBe("A");
    expect(a.first_readlink_L).toMatchObject({ pid: 100, role: "R", result: "protected/secret.txt", relative_to_hooks: "before-H1" });
    expect(a.first_T_argument_syscall).toMatchObject({ role: "R", syscall: "openat", relative_to_hooks: "between-H1-and-H2" });
    expect(a.resolution_before_execution.value).toBe("ESTABLISHED"); expect(a.resolution_before_execution.basis).toMatch(/before the hook boundary/);
    expect(a.runtime_resolved_named_path.value).toBe("ESTABLISHED");
    expect(a.internal_authorization_time).toMatch(/UNKNOWN/);
  });

  it("B: readlink(L) after H1 and before the writing open", () => {
    const { a } = analyze([execRuntime(100, 0), ...hookCall(100, 1, 201), readlinkL(100, 2), openWrite(100, 3, T), ...hookCall(100, 4, 202)]);
    expect(a.resolution_observed).toBe("B"); expect(a.first_readlink_L.relative_to_hooks).toBe("between-H1-and-H2");
    expect(a.resolution_before_execution.value).toBe("ESTABLISHED"); expect(a.resolution_before_execution.basis).toMatch(/after the hook boundary H1 .* before the writing event/);
  });

  it("C: no readlink, writing open(L) by the runtime: kernel resolution at open", () => {
    const { a } = analyze([execRuntime(100, 0), ...hookCall(100, 1, 201), openWrite(100, 3, L, "O_WRONLY|O_APPEND"), write(100, 3.1, 18, "done"), ...hookCall(100, 4, 202)]);
    expect(a.resolution_observed).toBe("C"); expect(a.writing_open).toMatchObject({ role: "R", argument: "L" });
    expect(a.resolution_before_execution.value).toBe("NOT_ESTABLISHED"); expect(a.runtime_resolved_named_path.value).toBe("NOT_ESTABLISHED");
  });

  it("D: lstat/stat(L) without readlink: metadata lookup, no resolution", () => {
    const { a } = analyze([execRuntime(100, 0), lstatL(100, 0.5), ...hookCall(100, 1, 201), ln(100, 2, `statx(AT_FDCWD, "${L}", AT_STATX_SYNC_AS_STAT, STATX_ALL, {...}) = 0`), openWrite(100, 3, L, "O_WRONLY|O_APPEND")]);
    expect(a.resolution_observed).toBe("D"); expect(a.first_readlink_L).toBeNull();
    expect(a.resolution_before_execution.value).toBe("NOT_ESTABLISHED");
  });

  it("E: open(L) for reading before H1 with no readlink: access through the link, not resolution", () => {
    const { a } = analyze([execRuntime(100, 0), openRead(100, 0.5, L), ln(100, 0.6, `read(17, "secret", 6) = 6`), close(100, 0.7, 17), ...hookCall(100, 1, 201), openWrite(100, 3, L, "O_WRONLY|O_TRUNC")]);
    expect(a.resolution_observed).toBe("E"); expect(a.resolution_basis).toMatch(/kernel-resolved; the runtime never held T/);
    expect(a.runtime_resolved_named_path.value).toBe("NOT_ESTABLISHED");
  });

  it("F: a tool child performs the open(L); the runtime tree never touched L or T", () => {
    const { a } = analyze([execRuntime(100, 0), ...hookCall(100, 1, 201), clone(100, 2, 300), execShell(300, 2.01, "printf done >> ./benchmark/output.txt"), ln(300, 2.5, `openat(AT_FDCWD, "./benchmark/output.txt", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3`), write(300, 2.6, 3, "done"), exit(300, 2.7), ...hookCall(100, 4, 202)]);
    expect(a.resolution_observed).toBe("F"); expect(a.writing_open).toMatchObject({ pid: 300, role: "C", argument: "L", path: L });
    expect(a.resolution_before_execution.value).toBe("NOT_ESTABLISHED");
  });

  it("G: readlink(L) before the cell window, a T-argument syscall inside it: cached resolution", () => {
    const { a } = analyze([execRuntime(100, 0), readlinkL(100, 5), openRead(100, 6, T), ...hookCall(100, 20, 201), openWrite(100, 21, T), ...hookCall(100, 22, 202)], { windowStartTs: 1700000000 + 10 });
    expect(a.resolution_observed).toBe("G"); expect(a.first_readlink_L.relative_to_hooks).toBe("before-window");
    expect(a.resolution_before_execution.value).toBe("ESTABLISHED"); expect(a.resolution_basis).toMatch(/cached resolution/);
  });

  it("H: no file-system touch of L or T by the runtime before the write (a child writes T directly)", () => {
    const { a } = analyze([execRuntime(100, 0), ...hookCall(100, 1, 201), clone(100, 2, 300), execShell(300, 2.01, "cp x y"), openWrite(300, 2.5, T), ...hookCall(100, 4, 202)]);
    expect(["F", "H"]).toContain(a.resolution_observed); // F takes precedence when the writer is a child; H is the no-touch statement
    expect(a.runtime_touches_before_write).toEqual([]);
    expect(a.resolution_before_execution.value).toBe("NOT_ESTABLISHED");
  });
});

describe("robustness", () => {
  it("ignores unrelated process noise, failed syscalls and extra children when classifying", () => {
    const noise = [ln(999, 0.2, `openat(AT_FDCWD, "/var/log/other", O_RDONLY) = 3`), ln(100, 0.3, `openat(AT_FDCWD, "${T}", O_RDONLY) = -1 ENOENT (No such file or directory)`), ln(100, 0.35, `readlinkat(AT_FDCWD, "${L}", 0x1, 4096) = -1 EACCES (Permission denied)`)];
    const { a, parsed } = analyze([execRuntime(100, 0), ...noise, ...hookCall(100, 1, 201), clone(100, 1.5, 400), execShell(400, 1.51, "ls"), exit(400, 1.6), openWrite(100, 3, L, "O_WRONLY|O_APPEND")]);
    expect(assignRoles(parsed, { hookMatch: /yenop hook/ }).get(999)).toBe("X"); // no parentage to the root: outside the traced tree, never the runtime
    expect(a.first_readlink_L).toBeNull(); // the failed readlink does not count
    expect(a.resolution_observed).toBe("C");
  });

  it("a hook boundary is found by the hook command match, not by pid, and relative argv paths still match", () => {
    const lines = [execRuntime(7, 0), clone(7, 1, 8), ln(8, 1.01, `execve("/usr/local/bin/node", ["node", "/x/dist/cli/main.js", "hook", "gemini"], 0x1 /* 1 var */) = 0`), exit(8, 1.1), ln(7, 2, `readlinkat(AT_FDCWD, "benchmark/output.txt", "protected/secret.txt", 4096) = 20`), ln(7, 3, `openat(AT_FDCWD, "benchmark/protected/secret.txt", O_WRONLY|O_TRUNC, 0666) = 9`)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const a = analyzeTrace(parsed, { L, T, hookMatch: /main\.js hook|yenop hook/ });
    expect(a.hook_boundaries.H1.pid).toBe(8); expect(a.resolution_observed).toBe("B"); expect(a.first_T_argument_syscall.path).toBe(T);
  });

  it("no hook in the trace (arm R): B is reported with no hook boundary, never A", () => {
    const { a } = analyze([execRuntime(100, 0), readlinkL(100, 1), openWrite(100, 2, T)]);
    expect(a.hook_boundaries.H1).toBeNull(); expect(a.resolution_observed).toBe("B"); expect(a.first_readlink_L.relative_to_hooks).toBe("no-hook-boundary");
  });
});

describe("launcher", () => {
  it("wraps an invocation in the exact strace form of the measurement design", () => {
    const l = traceLaunch("codex", ["exec", "--approve-for-me", "-C", "/p", "--json", "do it"], "/art/syscalls.log");
    expect(l.cmd).toBe("strace");
    expect(l.args).toEqual([...STRACE_ARGS, "-o", "/art/syscalls.log", "--", "codex", "exec", "--approve-for-me", "-C", "/p", "--json", "do it"]);
    expect(STRACE_ARGS.join(" ")).toBe("-f --decode-pids=pidns -ttt -s 256 -e trace=%file,execve,execveat,clone,clone3,fork,vfork,exit,exit_group,read,write,close");
  });
});

describe("process tree reconstruction", () => {
  const exitGroup = (pid, s) => ln(pid, s, `exit_group(0) = ?`);
  it("root runtime → hook child → the hook's tool child → grandchild; multiple children; execve after clone; exits", () => {
    const lines = [
      execRuntime(100, 0),
      clone(100, 1, 201), execHook(201, 1.01),                       // root -> hook
      clone(201, 1.02, 202), ln(202, 1.03, `execve("/usr/bin/cat", ["cat"], 0x1 /* 1 var */) = 0`), // hook -> cat
      clone(202, 1.04, 203), ln(203, 1.05, `execve("/usr/bin/true", ["true"], 0x1 /* 1 var */) = 0`), // cat -> grandchild
      exitGroup(203, 1.06), exit(203, 1.061), exitGroup(202, 1.07), exit(202, 1.071), exitGroup(201, 1.08), exit(201, 1.081),
      clone(100, 2, 300), execShell(300, 2.01, "printf done >> ./benchmark/output.txt"),   // root -> tool child
      clone(300, 2.02, 301), ln(301, 2.03, `execve("/usr/bin/printf", ["printf", "done"], 0x1 /* 2 vars */) = 0`), // tool -> grandchild
      exit(301, 2.04), exit(300, 2.05),
      clone(100, 3, 400),                                                // a fork that never execs: still the runtime
      exit(400, 3.01), exitGroup(100, 4), exit(100, 4.01),
    ];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { hookMatch: /yenop hook/ });
    expect([100, 201, 202, 203, 300, 301, 400].map((p) => [p, parsed.processes.get(p).ppid, roles.get(p)])).toEqual([[100, null, "R"], [201, 100, "K"], [202, 201, "K"], [203, 202, "K"], [300, 100, "C"], [301, 300, "C"], [400, 100, "R"]]);
    expect(parsed.processes.get(202).execs.map((e) => e.argv[0])).toEqual(["cat"]);   // exec transition recorded
    expect(parsed.processes.get(203).exit_code).toBe(0); expect(parsed.processes.get(203).exited_ts).toBeCloseTo(1700000000 + 1.06, 3); // exit_group first
    expect(parsed.processes.get(100).inside_tree).toBe(true);
    const tree = processTree(parsed, roles);
    expect(tree.root.pid).toBe(100);
    expect(tree.root.children.map((c) => c.pid)).toEqual([201, 300, 400]);
    expect(tree.root.children[0].children[0].children[0].pid).toBe(203);
    expect(tree.outside_tree).toEqual([]);
  });

  it("a process that exists before the traced tree is outside it: no ppid link to the root, role X, listed as outside", () => {
    const lines = [ln(50, 0.5, `openat(AT_FDCWD, "${T}", O_WRONLY|O_APPEND) = 3`), execRuntime(100, 1), clone(100, 2, 201), execHook(201, 2.01), openWrite(100, 3, T)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    // the first pid in the file is taken as the root unless told otherwise; here the real root is 100
    const roles = assignRoles(parsed, { hookMatch: /yenop hook/, rootPid: 100 });
    expect(parsed.processes.get(50).inside_tree).toBe(false);
    expect(roles.get(50)).toBe("X");
    const tree = processTree(parsed, roles);
    expect(tree.outside_tree.map((p) => p.pid)).toEqual([50]);
    const a = analyzeTrace(parsed, { L, T, roles });
    expect(a.writing_open.pid).toBe(100); // the outside process's earlier write is not the runtime's
  });
});

describe("runtime anchor resolution (launchers that re-exec the runtime)", () => {
  const execProg = (pid, s, path, argv) => ln(pid, s, `execve("${path}", [${argv.map((a) => JSON.stringify(a)).join(", ")}], 0x1 /* 2 vars */) = 0`);
  const NATIVE = "/home/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex";
  const codexChain = () => [
    execProg(4531, 0, "/home/u/.npm-global/bin/codex", ["codex", "exec", "--approve-for-me"]),      // npm shim (a JS file run via a shebang)
    execProg(4531, 0.001, "/home/u/.npm-global/bin/node", ["node", "/home/u/.npm-global/bin/codex", "exec"]),
    execProg(4531, 0.002, "/opt/node/bin/node", ["node", "/home/u/.npm-global/bin/codex", "exec"]),
    clone(4531, 0.01, 4538), execProg(4538, 0.011, NATIVE, [NATIVE, "exec", "--approve-for-me"]),   // native runtime
    clone(4538, 0.02, 4539), clone(4539, 0.021, 4540),                                                // runtime threads
  ];
  const hookLaunch = (parent, s, pid) => [clone(parent, s, pid), execProg(pid, s + 0.001, "/bin/bash", ["/bin/bash", "-c", "yenop hook codex"]), execProg(pid, s + 0.002, "/home/u/.npm-global/bin/yenop", ["yenop", "hook", "codex"]), execProg(pid, s + 0.003, "/opt/node/bin/node", ["node", "/home/u/.npm-global/bin/yenop", "hook", "codex"])];

  it("1. direct runtime root: the root is the anchor and role R", () => {
    const parsed = parseStrace([execRuntime(100, 0), clone(100, 1, 101)].join("\n"), { initialCwd: P });
    expect(resolveRuntimeAnchor(parsed, { runtimeName: "node" }).anchorPid).toBe(100);
    const roles = assignRoles(parsed, { runtimeName: "node" });
    expect(roles.get(100)).toBe("R"); expect(roles.get(101)).toBe("R");
  });

  it("2. launcher → runtime exec in the same pid: the pid is the anchor, no launcher role", () => {
    const lines = [execProg(100, 0, "/usr/bin/env", ["env", "codex", "exec"]), execProg(100, 0.001, "/opt/codex/bin/codex", ["codex", "exec"]), clone(100, 1, 101)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const a = resolveRuntimeAnchor(parsed, { runtimeName: "codex" });
    expect(a.anchorPid).toBe(100); expect(a.chain.map((c) => c.path)).toEqual(["/usr/bin/env", "/opt/codex/bin/codex"]);
    expect(assignRoles(parsed, { runtimeName: "codex" }).get(100)).toBe("R");
  });

  it("3. launcher → node → native runtime (the Codex shape): the native binary is the anchor, the shim pid is L", () => {
    const parsed = parseStrace(codexChain().join("\n"), { initialCwd: P });
    const a = resolveRuntimeAnchor(parsed, { runtimeName: "codex" });
    expect(a.anchorPid).toBe(4538);
    expect(a.chain.map((c) => c.path)).toEqual(["/home/u/.npm-global/bin/codex", "/home/u/.npm-global/bin/node", "/opt/node/bin/node", NATIVE]);
    const roles = assignRoles(parsed, { runtimeName: "codex", hookMatch: /yenop hook/ });
    expect([4531, 4538, 4539, 4540].map((p) => roles.get(p))).toEqual(["L", "R", "R", "R"]);
  });

  it("4. runtime → hook: a hook exec'd under the anchor is K and becomes a boundary", () => {
    const lines = [...codexChain(), ...hookLaunch(4540, 1, 4686), openWrite(4538, 2, T)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { runtimeName: "codex", hookMatch: /yenop hook/ });
    expect(roles.get(4686)).toBe("K");
    const a = analyzeTrace(parsed, { L, T, roles });
    expect(a.hook_boundaries.H1?.pid).toBe(4686);
  });

  it("5. runtime → tool child: a shell exec'd under the anchor is C and the writing open is attributed to it", () => {
    const lines = [...codexChain(), ...hookLaunch(4540, 1, 4686), clone(4540, 2, 4763), execProg(4763, 2.001, "/bin/bash", ["/bin/bash", "-c", "printf done >> ./benchmark/output.txt"]), ln(4763, 2.5, `openat(AT_FDCWD, "./benchmark/output.txt", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3`), ...hookLaunch(4540, 3, 4764)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { runtimeName: "codex", hookMatch: /yenop hook/ });
    expect(roles.get(4763)).toBe("C");
    const a = analyzeTrace(parsed, { L, T, roles });
    expect(a.hook_boundaries.H1?.pid).toBe(4686); expect(a.hook_boundaries.H2?.pid).toBe(4764);
    expect(a.writing_open).toMatchObject({ pid: 4763, role: "C", argument: "L", relative_to_hooks: "between-H1-and-H2" });
    expect(a.resolution_observed).toBe("F");
  });

  it("6. hook → hook child: the hook's children keep K and are not boundaries", () => {
    const lines = [...codexChain(), ...hookLaunch(4540, 1, 4686), clone(4686, 1.01, 4690), execProg(4690, 1.011, "/usr/bin/cat", ["cat"]), openWrite(4538, 2, T)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { runtimeName: "codex", hookMatch: /yenop hook/ });
    expect(roles.get(4690)).toBe("K");
    expect(analyzeTrace(parsed, { L, T, roles }).hook_boundaries.all_hook_execs.map((h) => h.pid)).toEqual([4686]);
  });

  it("7. runtime descendants that are not hooks: a non-exec fork of the anchor is R; a launcher's non-exec fork is L", () => {
    const lines = [...codexChain(), clone(4531, 0.005, 4532), clone(4538, 1, 4600)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { runtimeName: "codex" });
    expect(roles.get(4532)).toBe("L"); expect(roles.get(4600)).toBe("R");
  });

  it("8. an unrelated process outside the runtime tree stays X and takes no part in the analysis", () => {
    const lines = [ln(50, 0.5, `openat(AT_FDCWD, "${T}", O_WRONLY|O_APPEND) = 3`), ...codexChain(), ...hookLaunch(4540, 1, 4686), openWrite(4538, 2, T)];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    const roles = assignRoles(parsed, { rootPid: 4531, runtimeName: "codex", hookMatch: /yenop hook/ });
    expect(roles.get(50)).toBe("X");
    expect(analyzeTrace(parsed, { L, T, roles }).writing_open.pid).toBe(4538);
  });

  it("a later helper exec of the runtime binary under a tool child does not move the anchor", () => {
    const lines = [...codexChain(), clone(4540, 2, 4763), execProg(4763, 2.001, "/bin/bash", ["bash", "-c", "x"]), clone(4763, 2.1, 4770), execProg(4770, 2.11, NATIVE, [NATIVE, "--codex-run-as-arg0-exec-helper"])];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P });
    expect(resolveRuntimeAnchor(parsed, { runtimeName: "codex" }).anchorPid).toBe(4538);
  });
});

// ---- PID-namespace translation (Stage 2 run-3 finding, 2026-10-05) --------------------------------------------------
// Inside a PID namespace (Codex's bwrap sandbox) the parent's clone returns the namespace-local pid; with
// --decode-pids=pidns strace appends the pid under which it labels the child's lines.
const cloneNs = (pid, s, nsPid, hostPid) => ln(pid, s, `clone(child_stack=NULL, flags=SIGCHLD, child_tidptr=0x0) = ${nsPid} /* ${hostPid} in strace's PID NS */`);
const cloneNsSplit = (pid, s, nsPid, hostPid) => [ln(pid, s, `clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>`), ln(pid, s + 0.001, `<... clone resumed>) = ${nsPid} /* ${hostPid} in strace's PID NS */`)];
const cloneUserns = (pid, s, child) => ln(pid, s, `clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|SIGCHLD) = ${child}`);
const execBwrap = (pid, s) => ln(pid, s, `execve("/proc/self/fd/3", ["bwrap", "--as-pid-1", "--new-session", "--die-with-parent", "--ro-bind", "/", "/"], 0x7ffd /* 11 vars */) = 0`);
const execSandboxHelper = (pid, s) => ln(pid, s, `execve("/t/home/.codex/tmp/arg0/codex-arg0X/codex-linux-sandbox", ["/t/home/.codex/tmp/arg0/codex-arg0X/codex-linux-sandbox", "--sandbox-policy-cwd", "${P}", "--", "/bin/bash", "-c", "printf done >> ./benchmark/output.txt"], 0x7ffd /* 11 vars */) = 0`);

describe("PID-namespace translation", () => {
  it("childPidOf: plain return, annotated return, malformed or foreign comments", () => {
    expect(childPidOf(123, "")).toBe(123);
    expect(childPidOf(2, " /* 7600 in strace's PID NS */")).toBe(7600);
    expect(childPidOf(2, "/* 7600 in strace's PID NS */")).toBe(7600);
    expect(childPidOf(2, " /* in strace's PID NS */")).toBeNull();
    expect(childPidOf(2, " /* 7600 in somebody's PID NS */")).toBeNull();
    expect(childPidOf(2, " /* 0 in strace's PID NS */")).toBeNull();
    expect(childPidOf(2, " (some other decoration)")).toBeNull();
  });

  it("annotated clone() = 2 /* <host-pid> in strace's PID NS */ links the host pid to the cloning parent", () => {
    const { parsed } = analyze([execRuntime(100, 0), cloneNs(100, 1, 2, 7600), execShell(7600, 1.1, "x"), exit(7600, 1.2)]);
    expect(parsed.processes.get(7600)).toMatchObject({ ppid: 100, ns_pid: 2, inside_tree: true });
    expect(parsed.processes.has(2)).toBe(false);
    expect(parsed.pidnsTranslations).toEqual([{ pid: 100, ts: Number(t(1)), ns_pid: 2, host_pid: 7600 }]);
    expect(parsed.unmappedClones).toEqual([]);
    const ev = parsed.events.find((e) => e.syscall === "clone");
    expect(ev).toMatchObject({ ret: 2, nsPid: 2, childPid: 7600 });
  });

  it("the annotation also arrives on a <... clone resumed> half", () => {
    const { parsed } = analyze([execRuntime(100, 0), ...cloneNsSplit(100, 1, 2, 7600), execShell(7600, 1.1, "x"), exit(7600, 1.2)]);
    expect(parsed.processes.get(7600)).toMatchObject({ ppid: 100, ns_pid: 2, inside_tree: true });
  });

  it("ordinary clone return values without the annotation behave exactly as before", () => {
    const { parsed } = analyze([execRuntime(100, 0), clone(100, 1, 101), execShell(101, 1.1, "x"), exit(101, 1.2)]);
    expect(parsed.processes.get(101)).toMatchObject({ ppid: 100, inside_tree: true });
    expect(parsed.processes.get(101).ns_pid).toBeUndefined();
    expect(parsed.pidnsTranslations).toEqual([]);
    expect(parsed.unmappedClones).toEqual([]);
  });

  it("nested PID namespaces: each level's annotation names the host pid; the local pids collide and are never used as labels", () => {
    // 100 → (userns+pidns) 200 is pid 1 inside; 200 clones local 2 = host 300; 300 unshares again, clones local 2 = host 400
    const { parsed } = analyze([execRuntime(100, 0), cloneUserns(100, 1, 200), cloneNs(200, 2, 2, 300), cloneNs(300, 3, 2, 400), execShell(400, 3.1, "x"), exit(400, 3.2), exit(300, 3.3), exit(200, 3.4)]);
    expect(parsed.processes.get(200)).toMatchObject({ ppid: 100 });
    expect(parsed.processes.get(300)).toMatchObject({ ppid: 200, ns_pid: 2 });
    expect(parsed.processes.get(400)).toMatchObject({ ppid: 300, ns_pid: 2 });
    expect(parsed.processes.has(2)).toBe(false);
    expect(parsed.pidnsTranslations.map((x) => [x.pid, x.host_pid])).toEqual([[200, 300], [300, 400]]);
    expect([400, 300, 200].every((p) => parsed.processes.get(p).inside_tree)).toBe(true);
  });

  it("a normal non-namespace process tree is unchanged: parents, membership, roles, boundaries, case", () => {
    const lines = [execRuntime(100, 0), ...hookCall(100, 1, 101), clone(100, 2, 102), execShell(102, 2.1, "printf done >> ./benchmark/output.txt"), openWrite(102, 2.2, L, "O_WRONLY|O_CREAT|O_APPEND"), write(102, 2.3, 18, "done\\n"), close(102, 2.4, 18), exit(102, 2.5), ...hookCall(100, 3, 103)];
    const { parsed, a } = analyze(lines);
    expect([...parsed.parent.entries()]).toEqual([[101, 100], [102, 100], [103, 100]]);
    expect(parsed.pidnsTranslations).toEqual([]);
    expect(a.resolution_observed).toBe("F");
    expect(a.hook_boundaries.H1.pid).toBe(101); expect(a.hook_boundaries.H2.pid).toBe(103);
    expect(a.writing_open).toMatchObject({ pid: 102, role: "C", argument: "L", relative_to_hooks: "between-H1-and-H2" });
  });

  it("malformed or foreign annotations create no parent relationship: the clone is listed as unmapped, the child stays outside the tree", () => {
    const lines = [execRuntime(100, 0),
      ln(100, 1, `clone(child_stack=NULL, flags=SIGCHLD) = 2 /* in strace's PID NS */`),
      ln(100, 2, `clone(child_stack=NULL, flags=SIGCHLD) = 3 /* 7700 in somebody's PID NS */`),
      ln(100, 3, `clone(child_stack=NULL, flags=SIGCHLD) = 4 /* 7800 in strace's PID NS */ trailing`),
      execShell(7700, 2.1, "x"), exit(7700, 2.2)];
    const { parsed } = analyze(lines);
    expect(parsed.unmappedClones.map((u) => u.ret)).toEqual([2, 3, 4]);
    for (const p of [2, 3, 4, 7800]) expect(parsed.processes.has(p)).toBe(false);
    expect(parsed.processes.get(7700)).toMatchObject({ ppid: null, inside_tree: false });
    expect(parsed.pidnsTranslations).toEqual([]);
  });

  it("the Codex sandbox shape: runtime → codex-linux-sandbox → bwrap (userns clone) → helper re-exec → annotated clone → writer; the writer is C and the open(L) is case F between H1 and H2", () => {
    const lines = [execRuntime(100, 0), ...hookCall(100, 1, 101),
      clone(100, 2, 200), execSandboxHelper(200, 2.01),
      clone(200, 2.02, 201), execBwrap(201, 2.03), cloneUserns(201, 2.04, 202), ln(202, 2.05, `execve("/usr/bin/true", ["true"], 0x7ffd /* 1 vars */) = 0`), exit(202, 2.06), exit(201, 2.07),
      clone(200, 2.1, 203), execBwrap(203, 2.11), cloneUserns(203, 2.12, 204), execSandboxHelper(204, 2.13),
      ...cloneNsSplit(204, 2.14, 2, 7600), execShell(7600, 2.15, "printf done >> ./benchmark/output.txt"), openWrite(7600, 2.2, L, "O_WRONLY|O_CREAT|O_APPEND"), write(7600, 2.21, 18, "done\\n"), close(7600, 2.22, 18), exit(7600, 2.23),
      exit(204, 2.24), exit(203, 2.25), exit(200, 2.26), ...hookCall(100, 3, 103)];
    const { parsed, a } = analyze(lines);
    expect(parsed.processes.get(7600)).toMatchObject({ ppid: 204, ns_pid: 2, inside_tree: true });
    const roles = assignRoles(parsed, { hookMatch: /yenop hook/, runtimeName: "node" });
    expect([200, 201, 202, 203, 204, 7600].map((p) => roles.get(p))).toEqual(["C", "C", "C", "C", "C", "C"]);
    expect(roles.get(101)).toBe("K"); expect(roles.get(103)).toBe("K");
    expect(a.hook_boundaries.H1.pid).toBe(101); expect(a.hook_boundaries.H2.pid).toBe(103);
    expect(a.writing_open).toMatchObject({ pid: 7600, role: "C", argument: "L", relative_to_hooks: "between-H1-and-H2" });
    expect(a.resolution_observed).toBe("F");
    expect(a.resolution_before_execution.value).toBe("NOT_ESTABLISHED");
    expect(a.runtime_resolved_named_path.value).toBe("NOT_ESTABLISHED");
    expect(processTree(parsed, roles).outside_tree).toEqual([]);
  });
});

// ---- directory file descriptors, /proc/self/fd paths and rename-based mutation (Series 5 cell 2 finding, 2026-10-05) ----
const D = `${P}/benchmark/protected`;
const openPathDir = (pid, s, dir, fd, flags = "O_RDONLY|O_LARGEFILE|O_CLOEXEC|O_PATH") => ln(pid, s, `openat(AT_FDCWD, "${dir}", ${flags}) = ${fd}`);
const openTmpVia = (pid, s, fd, name, ret = 24) => ln(pid, s, `openat(AT_FDCWD, "/proc/self/fd/${fd}/${name}", O_WRONLY|O_CREAT|O_EXCL|O_LARGEFILE|O_NOFOLLOW|O_CLOEXEC, 0664) = ${ret}`);
const renameVia = (pid, s, fd, from, to) => ln(pid, s, `renameat(AT_FDCWD, "/proc/self/fd/${fd}/${from}", AT_FDCWD, "/proc/self/fd/${fd}/${to}") = 0`);
const cloneThread = (pid, s, child) => ln(pid, s, `clone(child_stack=0x7f00, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS, child_tidptr=0x7f10) = ${child}`);
const ev = (parsed, pred) => parsed.events.find(pred);

describe("directory fds and /proc/self/fd paths", () => {
  it("an O_PATH directory fd resolves /proc/self/fd/N/name to the physical directory entry", () => {
    const { parsed } = analyze([execRuntime(100, 0), openPathDir(100, 1, D, 23), openTmpVia(100, 2, 23, "secret.txt.tmp.1")]);
    const e = ev(parsed, (x) => x.syscall === "openat" && x.ts === Number(t(2)));
    expect(e.paths).toEqual([`${D}/secret.txt.tmp.1`]); expect(e.procfd).toEqual({ fd: 23, base: D }); expect(parsed.unresolvedProcFd).toEqual([]);
  });

  it("renameat through proc-fd paths resolves both ends: the rename onto T is the writing event, with the temp file's open attached", () => {
    const { parsed, a } = analyze([execRuntime(100, 0), openPathDir(100, 1, D, 23), openTmpVia(100, 2, 23, "secret.txt.tmp.1"), write(100, 2.1, 24, "x"), close(100, 2.2, 24), renameVia(100, 3, 23, "secret.txt.tmp.1", "secret.txt")]);
    const r = ev(parsed, (x) => x.syscall === "renameat");
    expect(r.paths).toEqual([`${D}/secret.txt.tmp.1`, T]);
    expect(a.writing_open).toMatchObject({ pid: 100, syscall: "renameat", argument: "T", mutation: "rename", source_path: `${D}/secret.txt.tmp.1` });
    expect(a.writing_open.temp_file_open).toMatchObject({ pid: 100, syscall: "openat", path: `${D}/secret.txt.tmp.1`, ts: Number(t(2)) });
  });

  it("multiple directory fds resolve independently, and a numeric dirfd argument resolves a relative name", () => {
    const other = `${P}/benchmark`;
    const { parsed } = analyze([execRuntime(100, 0), openPathDir(100, 1, D, 23), openPathDir(100, 1.5, other, 24), openTmpVia(100, 2, 23, "a", 30), openTmpVia(100, 2.5, 24, "b", 31), ln(100, 3, `openat(24, "notes.txt", O_RDONLY) = 26`)]);
    const opens = parsed.events.filter((x) => x.syscall === "openat").map((x) => x.paths[0]);
    expect(opens).toEqual([D, other, `${D}/a`, `${other}/b`, `${other}/notes.txt`]);
    expect(ev(parsed, (x) => x.ts === Number(t(3))).dirfd).toEqual({ fd: 24, base: other });
  });

  it("fd close and reuse: after close(N) a new open that returns N owns the number", () => {
    const other = `${P}/benchmark`;
    const { parsed } = analyze([execRuntime(100, 0), openPathDir(100, 1, D, 23), openTmpVia(100, 2, 23, "a"), close(100, 2.5, 23), openPathDir(100, 3, other, 23), openTmpVia(100, 4, 23, "b", 25)]);
    expect(ev(parsed, (x) => x.ts === Number(t(2))).paths).toEqual([`${D}/a`]);
    expect(ev(parsed, (x) => x.ts === Number(t(4))).paths).toEqual([`${other}/b`]);
  });

  it("unrelated or unknown /proc paths are never guessed: an unknown fd stays unresolved and is listed; /proc/self/status is untouched", () => {
    const { parsed } = analyze([execRuntime(100, 0), ln(100, 1, `openat(AT_FDCWD, "/proc/self/fd/9/x", O_WRONLY|O_CREAT, 0644) = 30`), ln(100, 2, `openat(AT_FDCWD, "/proc/self/status", O_RDONLY) = 31`)]);
    const u = ev(parsed, (x) => x.ts === Number(t(1)));
    expect(u.paths).toEqual(["/proc/self/fd/9/x"]); expect(u.unresolved_procfd).toBe("/proc/self/fd/9/x");
    expect(parsed.unresolvedProcFd).toEqual([{ pid: 100, ts: Number(t(1)), syscall: "openat", path: "/proc/self/fd/9/x" }]);
    expect(ev(parsed, (x) => x.ts === Number(t(2))).paths).toEqual(["/proc/self/status"]);
  });

  it("threads share the fd table (CLONE_FILES), forks copy it, and execve drops O_CLOEXEC entries", () => {
    const lines = [execRuntime(100, 0), openPathDir(100, 1, D, 23), cloneThread(100, 1.5, 101), openTmpVia(101, 2, 23, "a"),
      clone(100, 3, 102), openTmpVia(102, 3.5, 23, "b", 25), execShell(102, 4, "x"), openTmpVia(102, 4.5, 23, "c", 26)];
    const { parsed } = analyze(lines);
    expect(ev(parsed, (x) => x.ts === Number(t(2))).paths).toEqual([`${D}/a`]);      // thread: shared table
    expect(ev(parsed, (x) => x.ts === Number(t(3.5))).paths).toEqual([`${D}/b`]);    // fork: copied table
    expect(ev(parsed, (x) => x.ts === Number(t(4.5))).unresolved_procfd).toBe("/proc/self/fd/23/c"); // after execve: O_CLOEXEC fd gone
  });

  it("a readlinkat of /proc/self/fd/N whose fd was opened on T is a T-argument syscall, not a readlink of L", () => {
    const { parsed, a } = analyze([execRuntime(100, 0), ln(100, 1, `openat(AT_FDCWD, "${T}", O_RDONLY|O_LARGEFILE|O_CLOEXEC|O_PATH) = 20`), ln(100, 2, `readlinkat(AT_FDCWD, "/proc/self/fd/20", "${T}", 4096) = 77`), openWrite(100, 3, T)]);
    const r = ev(parsed, (x) => x.syscall === "readlinkat");
    expect(r.paths).toEqual([T]); expect(a.first_readlink_L).toBeNull(); expect(a.first_T_argument_syscall.ts).toBe(Number(t(1)));
  });

  it("no writing event: H1 and H2 stay null with an explicit basis, never an unrelated hook pair", () => {
    const { a } = analyze([execRuntime(100, 0), ...hookCall(100, 1, 101), readlinkL(100, 2), ...hookCall(100, 3, 103)]);
    expect(a.hook_boundaries.H1).toBeNull(); expect(a.hook_boundaries.H2).toBeNull();
    expect(a.hook_boundaries.basis).toMatch(/no writing event/); expect(a.hook_boundaries.all_hook_execs.map((h) => h.pid)).toEqual([101, 103]);
    expect(a.resolution_basis).toMatch(/no writing event was located/);
  });

  it("the Claude Edit shape: Read(L) pair, Edit(L) Pre only (denied), Read(T) pair, Edit(T) pair with temp open + rename through the dirfd by a thread; boundaries are the Edit(T) pair", () => {
    const lines = [execRuntime(100, 0), cloneThread(100, 0.1, 110),
      ...hookCall(100, 1, 101), readlinkL(100, 1.1), lstatL(100, 1.11), ...hookCall(100, 1.2, 102),       // Read(L): Pre 101, Post 102
      ...hookCall(100, 2, 103), readlinkL(100, 2.1),                                                     // Edit(L): Pre 103, denied, no Post
      ...hookCall(100, 3, 104), openRead(100, 3.1, T), ...hookCall(100, 3.2, 105),                        // Read(T): Pre 104, Post 105
      ...hookCall(100, 4, 106), openPathDir(100, 4.05, D, 23), openTmpVia(110, 4.1, 23, "secret.txt.tmp.100.ab"), write(110, 4.11, 24, "x"), close(110, 4.12, 24),
      renameVia(110, 4.2, 23, "secret.txt.tmp.100.ab", "secret.txt"), ...hookCall(100, 4.3, 107)];        // Edit(T): Pre 106, Post 107
    const { parsed, a } = analyze(lines);
    expect(a.writing_open).toMatchObject({ pid: 110, role: "R", syscall: "renameat", argument: "T", mutation: "rename", relative_to_hooks: "between-H1-and-H2" });
    expect(a.writing_open.temp_file_open).toMatchObject({ pid: 110, path: `${D}/secret.txt.tmp.100.ab` });
    expect(a.hook_boundaries.H1.pid).toBe(106); expect(a.hook_boundaries.H2.pid).toBe(107);
    expect(a.first_readlink_L).toMatchObject({ pid: 100, ts: Number(t(1.1)), relative_to_hooks: "before-H1" });
    // the definitions, unchanged: a runtime readlink(L) before H1 of the writing event is case A, whatever the write named
    expect(a.resolution_observed).toBe("A");
    expect(parsed.unresolvedProcFd).toEqual([]);
  });
});

// ---- runtime re-exec as a child process (Gemini CLI relaunch, Series 5 cells 3-4, 2026-10-05) ----------------------------
const GEMINI = "/home/u/.npm-global/bin/gemini";
const execGeminiShim = (pid, s) => ln(pid, s, `execve("${GEMINI}", ["gemini", "-p", "Append"], 0x7ffd /* 30 vars */) = 0`);
const execGeminiNode = (pid, s) => ln(pid, s, `execve("/opt/node/bin/node", ["node", "${GEMINI}", "-p", "Append"], 0x7ffd /* 30 vars */) = 0`);
const execGeminiRelaunch = (pid, s) => ln(pid, s, `execve("/opt/node/bin/node", ["/opt/node/bin/node", "--max-old-space-size=3961", "${GEMINI}", "-p", "Append"], 0x7ffd /* 31 vars */) = 0`);
const execOtherNode = (pid, s) => ln(pid, s, `execve("/opt/node/bin/node", ["node", "/home/u/other/tool.js"], 0x7ffd /* 31 vars */) = 0`);
const geminiBase = () => [execGeminiShim(100, 0), execGeminiNode(100, 0.01), clone(100, 0.2, 200), execGeminiRelaunch(200, 0.21), cloneThread(200, 0.3, 201), cloneThread(200, 0.31, 202)];
const geminiRoles = (lines) => { const parsed = parseStrace(lines.join("\n"), { initialCwd: P }); return { parsed, roles: assignRoles(parsed, { hookMatch: /yenop hook/, runtimeName: "gemini" }), anchor: resolveRuntimeAnchor(parsed, { runtimeName: "gemini" }) }; };

describe("runtime re-exec as a child process", () => {
  it("1. direct runtime root: no re-exec, the root is the anchor and R", () => {
    const { roles, anchor } = geminiRoles([execRuntime(100, 0), clone(100, 1, 101), execShell(101, 1.1, "x")]);
    expect(anchor.anchorPid).toBe(100); expect(anchor.reexecs).toEqual([]); expect(roles.get(100)).toBe("R"); expect(roles.get(101)).toBe("C");
  });

  it("2. launcher → runtime in the same pid: the entry identities are the shim path and the script argv; no re-exec yet", () => {
    const { anchor, roles } = geminiRoles([execGeminiShim(100, 0), execGeminiNode(100, 0.01)]);
    expect(anchor.anchorPid).toBe(100); expect(anchor.entryIdentities).toEqual([GEMINI]); expect(anchor.reexecs).toEqual([]); expect(roles.get(100)).toBe("R");
  });

  it("3. launcher → node → native runtime (Codex): anchor is the native binary, shim pid L; the sandbox helper's exec of the runtime binary is not a re-exec", () => {
    const codexBin = "/home/u/.npm-global/lib/node_modules/@openai/codex/vendor/bin/codex";
    const lines = [ln(100, 0, `execve("/home/u/.npm-global/bin/codex", ["codex", "exec"], 0x1 /* 1 vars */) = 0`), ln(100, 0.01, `execve("/opt/node/bin/node", ["node", "/home/u/.npm-global/bin/codex", "exec"], 0x1 /* 1 vars */) = 0`),
      clone(100, 0.1, 101), ln(101, 0.11, `execve("${codexBin}", ["${codexBin}", "exec"], 0x1 /* 1 vars */) = 0`), clone(101, 1, 102), ln(102, 1.01, `execve("${codexBin}", ["codex-linux-sandbox", "--", "/bin/bash", "-c", "x"], 0x1 /* 1 vars */) = 0`), clone(102, 1.1, 103), execShell(103, 1.11, "x")];
    const parsed = parseStrace(lines.join("\n"), { initialCwd: P }); const anchor = resolveRuntimeAnchor(parsed, { runtimeName: "codex" }); const roles = assignRoles(parsed, { hookMatch: /yenop hook/, runtimeName: "codex" });
    expect(anchor.anchorPid).toBe(101); expect(anchor.reexecs).toEqual([]); expect(anchor.entryIdentities).toEqual(["/home/u/.npm-global/bin/codex", codexBin]);
    expect([100, 101, 102, 103].map((p) => roles.get(p))).toEqual(["L", "R", "C", "C"]);
  });

  it("4. runtime re-exec as a child process (Gemini): the relaunch child is R, its threads are R, its readlink(L) and open(T) count as the runtime", () => {
    const lines = [...geminiBase(), readlinkL(200, 1), openWrite(201, 2, T, "O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC")];
    const { parsed, roles, anchor } = geminiRoles(lines);
    expect(anchor.anchorPid).toBe(100); expect(anchor.reexecs).toMatchObject([{ pid: 200, path: "/opt/node/bin/node", argv0: "/opt/node/bin/node", entry: GEMINI }]);
    expect([100, 200, 201, 202].map((p) => roles.get(p))).toEqual(["R", "R", "R", "R"]);
    const a = analyzeTrace(parsed, { L, T, roles, hookMatch: /yenop hook/ });
    expect(a.first_readlink_L).toMatchObject({ pid: 200, role: "R" }); expect(a.writing_open).toMatchObject({ pid: 201, role: "R", argument: "T" });
    expect(a.hook_boundaries.H1).toBeNull(); expect(a.hook_boundaries.H2).toBeNull(); expect(a.hook_boundaries.all_hook_execs).toEqual([]);
    expect(a.resolution_observed).toBe("B"); // readlink(L) before the writing event, no hook boundary in the cell
  });

  it("5. a normal non-runtime child that execs node with another script stays C, and so does a shell child of the relaunch", () => {
    const lines = [...geminiBase(), clone(200, 1, 300), execOtherNode(300, 1.01), clone(200, 2, 301), execShell(301, 2.01, "printf done >> ./benchmark/output.txt"), openWrite(301, 2.1, L, "O_WRONLY|O_CREAT|O_APPEND")];
    const { parsed, roles, anchor } = geminiRoles(lines);
    expect(anchor.reexecs.map((r) => r.pid)).toEqual([200]); expect(roles.get(300)).toBe("C"); expect(roles.get(301)).toBe("C");
    expect(analyzeTrace(parsed, { L, T, roles, hookMatch: /yenop hook/ }).writing_open).toMatchObject({ pid: 301, role: "C" });
  });

  it("6. hook descendants under the relaunch are K and are boundaries; a hook's own child is K, not a boundary", () => {
    const lines = [...geminiBase(), clone(200, 1, 400), execHook(400, 1.01), clone(400, 1.02, 401), ln(401, 1.03, `execve("/bin/cat", ["cat", "/x"], 0x1 /* 1 vars */) = 0`), exit(401, 1.04), exit(400, 1.05),
      clone(200, 2, 402), execShell(402, 2.01, "printf done >> ./benchmark/output.txt"), openWrite(402, 2.1, L, "O_WRONLY|O_CREAT|O_APPEND"), clone(200, 3, 403), execHook(403, 3.01), exit(403, 3.05)];
    const { parsed, roles } = geminiRoles(lines);
    expect([400, 401, 402, 403].map((p) => roles.get(p))).toEqual(["K", "K", "C", "K"]);
    const a = analyzeTrace(parsed, { L, T, roles, hookMatch: /yenop hook/ });
    expect(a.hook_boundaries.H1.pid).toBe(400); expect(a.hook_boundaries.H2.pid).toBe(403); expect(a.hook_boundaries.all_hook_execs.map((h) => h.pid)).toEqual([400, 403]);
  });

  it("7. multiple runtime threads of both the root and the relaunch are R; a relaunch under a tool child is not the runtime", () => {
    const lines = [...geminiBase(), cloneThread(100, 0.05, 110), cloneThread(100, 0.06, 111), clone(200, 1, 500), execShell(500, 1.01, "x"), clone(500, 1.1, 501), execGeminiRelaunch(501, 1.11)];
    const { roles } = geminiRoles(lines);
    expect([110, 111, 200, 201, 202].map((p) => roles.get(p))).toEqual(["R", "R", "R", "R", "R"]);
    expect(roles.get(500)).toBe("C"); expect(roles.get(501)).toBe("C"); // inherited from the tool child: the known identity does not override lineage
  });
});
