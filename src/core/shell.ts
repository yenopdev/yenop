/**
 * Shell command analysis. Turns a Bash command string into facts a policy can test,
 * instead of matching text patterns against the whole string.
 *
 * Why: whole-string globs match heredoc bodies, comments, and public-key file names.
 * Facts come from parsed arguments, so `cat > README.md <<'EOF' ... rm -rf ... EOF`
 * is a write to README.md, not a destructive command.
 */
import { homedir } from "node:os";

export interface SimpleCommand {
  argv: string[];
  /** True when this command reads its stdin from a pipe. */
  piped: boolean;
  redirects: { op: string; target: string }[];
}

export interface ShellFacts {
  /** Programs invoked, wrappers like sudo/env stripped. */
  programs: string[];
  /** Canonical operations, e.g. "git:push", "rm:-r", "terraform:destroy", "aws:ec2:terminate-instances". */
  ops: string[];
  /** Path-like arguments with ~ expanded. Heredoc bodies are never included. */
  paths: string[];
  /** Environment variables referenced, e.g. ["DATABASE_URL"]. */
  envRefs: string[];
  /** SQL statements of concern found in any argument, uppercased: "DROP TABLE", "DELETE FROM", ... */
  sql: string[];
  commandCount: number;
  heredoc: boolean;
  sudo: boolean;
  /** A download or other program's output is piped into an interpreter. */
  pipesToShell: boolean;
  /** Any path matches the secret-file patterns. */
  secretPath: boolean;
  /** An env var whose name looks like a credential is referenced. */
  secretEnv: boolean;
  /** A network client is invoked (curl, wget, ssh, scp, rsync, nc, git clone/pull/push, ...). */
  network: boolean;
  /** Hosts named in URLs and ssh-style targets. */
  hosts: string[];
  /** The network use reaches beyond this machine and private ranges (or the host could not be determined). */
  externalNetwork: boolean;
  /** Content is pulled in from the network: curl/wget fetches, git clone/pull/fetch. */
  download: boolean;
  /** Reads data that should not travel: credential variables, secret files, database clients, secret managers, environment dumps. */
  sensitiveRead: boolean;
  /** Something that sends data out: an HTTP write, ssh/scp/rsync, git push, npm publish, docker push. */
  outbound: boolean;
  /** Deletes, force-pushes, destroys, drops, prunes, wipes. */
  destructive: boolean;
}

/** Default secret-file patterns. `**` spans directories, `*` does not. A leading `!` excludes. */
export const DEFAULT_SECRET_PATTERNS: string[] = [
  "**/.ssh/id_*",
  "!**/.ssh/id_*.pub",
  "**/.ssh/config",
  "**/.aws/credentials",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/.env.sample",
  "!**/.env.template",
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/.gnupg/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
];

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "command", "exec", "nice", "ionice", "caffeinate", "timeout"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "perl", "ruby", "node"]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "http", "https"]);
const SUBCOMMAND_TOOLS = new Set(["git", "terraform", "pulumi", "kubectl", "helm", "docker", "docker-compose", "aws", "gcloud", "az", "npm", "pnpm", "yarn", "gh", "systemctl", "brew", "apt", "apt-get", "pip", "pip3", "cargo", "go", "make", "psql", "mysql", "redis-cli", "mongo", "mongosh", "flyctl", "fly", "vercel", "heroku", "supabase", "railway"]);
const CLOUD_CLIS = new Set(["aws", "gcloud", "az", "flyctl", "fly", "heroku", "vercel", "supabase", "railway", "doctl", "linode-cli"]);
const DESTRUCTIVE_SUBCOMMAND = /(^|[-_])(delete|destroy|terminate|remove|rm|rmi|purge|prune|wipe|drop|reset|uninstall|down|teardown)([-_]|$)/i;
const SQL_VERBS = ["DROP TABLE", "DROP DATABASE", "DROP SCHEMA", "DROP INDEX", "DELETE FROM", "TRUNCATE", "ALTER TABLE"];
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASS|PASSWORD|PASSWD|CRED|CREDENTIAL|PRIVATE|AUTH)/i;
const DB_CLIENTS = new Set(["psql", "pg_dump", "pg_dumpall", "mysql", "mysqldump", "mongosh", "mongo", "mongodump", "redis-cli", "sqlite3", "sqlcmd", "clickhouse-client", "bq", "snowsql"]);

/** Loopback, link-local, private ranges, and names that never leave the machine or the LAN. */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "host.docker.internal") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

function hostsIn(arg: string): string[] {
  const out: string[] = [];
  for (const m of arg.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\/\s@]+@)?(\[[0-9a-f:]+\]|[^\/\s:?#]+)/gi)) out.push(m[1]!);
  return out;
}

/** Convert a glob with `*`, `**`, `?` into a RegExp matched against a full path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesSecretPattern(path: string, patterns: string[] = DEFAULT_SECRET_PATTERNS): boolean {
  let hit = false;
  for (const p of patterns) {
    const negate = p.startsWith("!");
    const re = globToRegExp(negate ? p.slice(1) : p);
    if (re.test(path)) hit = !negate;
  }
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

interface Tok {
  kind: "word" | "op" | "newline";
  text: string;
  /** For words: was any part quoted? Quoted words are never treated as operators. */
  quoted: boolean;
  /** Raw text inside $(...) or backticks found in this word, parsed as separate commands. */
  subshells: string[];
}

const OPS = ["2>&1", "&>", ">>", ">|", "||", "&&", "<<-", "<<<", "<<", "|&", ">", "<", "|", ";", "&", "(", ")"];

export function tokenize(src: string): { tokens: Tok[]; heredoc: boolean } {
  const tokens: Tok[] = [];
  let i = 0;
  let heredoc = false;
  const pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

  const skipHeredocBodies = () => {
    // Called at a newline: consume lines until each pending delimiter is seen.
    while (pendingHeredocs.length > 0) {
      const { delim, stripTabs } = pendingHeredocs.shift()!;
      for (;;) {
        if (i >= src.length) return;
        let end = src.indexOf("\n", i);
        if (end === -1) end = src.length;
        let line = src.slice(i, end);
        if (stripTabs) line = line.replace(/^\t+/, "");
        i = end + 1;
        if (line === delim) break;
      }
    }
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      tokens.push({ kind: "newline", text: "\n", quoted: false, subshells: [] });
      i++;
      if (pendingHeredocs.length) skipHeredocBodies();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", text: op, quoted: false, subshells: [] });
      i += op.length;
      if (op === "<<" || op === "<<-") {
        // read the delimiter word
        while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
        let delim = "";
        let quoted = false;
        while (i < src.length && !/[\s;|&<>()]/.test(src[i]!)) {
          const d = src[i]!;
          if (d === "'" || d === '"') {
            quoted = true;
            i++;
            continue;
          }
          delim += d;
          i++;
        }
        void quoted;
        pendingHeredocs.push({ delim, stripTabs: op === "<<-" });
        heredoc = true;
        tokens.push({ kind: "word", text: `<<${delim}`, quoted: true, subshells: [] });
      }
      continue;
    }
    // word
    let text = "";
    let quoted = false;
    const subshells: string[] = [];
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "'") {
        quoted = true;
        const end = src.indexOf("'", i + 1);
        const body = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
        text += body;
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < src.length) {
            text += src[i + 1];
            i += 2;
            continue;
          }
          if (src[i] === "$" && src[i + 1] === "(") {
            const [inner, next] = readBalanced(src, i + 1);
            subshells.push(inner);
            text += "$(...)";
            i = next;
            continue;
          }
          text += src[i];
          i++;
        }
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < src.length) {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && src[i + 1] === "(") {
        const [inner, next] = readBalanced(src, i + 1);
        subshells.push(inner);
        text += "$(...)";
        i = next;
        continue;
      }
      if (ch === "`") {
        const end = src.indexOf("`", i + 1);
        subshells.push(end === -1 ? src.slice(i + 1) : src.slice(i + 1, end));
        text += "$(...)";
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (/[\s;|&<>()]/.test(ch)) break;
      if (ch === "#" && text.length === 0) break;
      text += ch;
      i++;
    }
    tokens.push({ kind: "word", text, quoted, subshells });
  }
  return { tokens, heredoc };
}

/** Read from an opening "(" at index `open` to its matching ")"; returns [inner, indexAfter]. */
function readBalanced(src: string, open: number): [string, number] {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) return [src.slice(open + 1, j), j + 1];
    }
  }
  return [src.slice(open + 1), src.length];
}

// ---------------------------------------------------------------------------------------------
// Parsing into simple commands

export function parseCommands(src: string): { commands: SimpleCommand[]; heredoc: boolean } {
  const { tokens, heredoc } = tokenize(src);
  const commands: SimpleCommand[] = [];
  let cur: SimpleCommand = { argv: [], piped: false, redirects: [] };
  let nextPiped = false;
  const flush = () => {
    if (cur.argv.length || cur.redirects.length) commands.push(cur);
    cur = { argv: [], piped: nextPiped, redirects: [] };
    nextPiped = false;
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "newline") {
      flush();
      continue;
    }
    if (t.kind === "op") {
      switch (t.text) {
        case "|":
        case "|&":
          nextPiped = true;
          flush();
          break;
        case "||":
        case "&&":
        case ";":
        case "&":
        case "(":
        case ")":
          flush();
          break;
        case ">":
        case ">>":
        case ">|":
        case "&>":
        case "<":
        case "<<<": {
          const target = tokens[k + 1];
          if (target && target.kind === "word") {
            cur.redirects.push({ op: t.text, target: target.text });
            k++;
          }
          break;
        }
        case "2>&1":
        case "<<":
        case "<<-":
          break;
      }
      continue;
    }
    for (const sub of t.subshells) {
      const inner = parseCommands(sub);
      commands.push(...inner.commands);
    }
    if (t.text.startsWith("<<")) continue; // heredoc marker word
    cur.argv.push(t.text);
  }
  flush();
  return { commands, heredoc };
}

// ---------------------------------------------------------------------------------------------
// Facts

function stripWrappers(argv: string[]): { argv: string[]; sudo: boolean } {
  let sudo = false;
  let a = [...argv];
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]!)) a.shift(); // FOO=bar prefix
    if (!a.length) break;
    const p = base(a[0]!);
    if (!WRAPPERS.has(p)) break;
    if (p === "sudo" || p === "doas") sudo = true;
    a.shift();
    // drop wrapper options (and the value of -u / -g / -n for sudo/timeout)
    while (a.length && a[0]!.startsWith("-")) {
      const f = a.shift()!;
      if ((p === "sudo" && (f === "-u" || f === "-g")) || (p === "timeout" && f === "-s")) a.shift();
    }
    if (p === "timeout" && a.length && /^\d/.test(a[0]!)) a.shift(); // timeout DURATION cmd
  }
  return { argv: a, sudo };
}

function base(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function isPathLike(tok: string): boolean {
  return tok.includes("/") || tok.startsWith("~") || /^\.[A-Za-z]/.test(tok) || /\.(pem|key|p12|pfx)$/i.test(tok);
}

function expandHome(tok: string, home: string): string {
  if (tok === "~") return home;
  if (tok.startsWith("~/")) return home + tok.slice(1);
  if (tok.startsWith("$HOME/")) return home + tok.slice(5);
  return tok;
}

export function analyzeShell(command: string, opts: { secretPatterns?: string[]; home?: string } = {}): ShellFacts {
  const home = opts.home ?? homedir();
  const patterns = opts.secretPatterns ?? DEFAULT_SECRET_PATTERNS;
  const { commands, heredoc } = parseCommands(command);
  const programs = new Set<string>();
  const ops = new Set<string>();
  const paths = new Set<string>();
  const envRefs = new Set<string>();
  const sql = new Set<string>();
  const hosts = new Set<string>();
  let sudo = false;
  let pipesToShell = false;
  let network = false;
  let outbound = false;
  let destructive = false;
  let download = false;
  let sensitiveRead = false;
  let hostUnknown = false;

  // env refs and SQL from every argument, including quoted strings
  for (const c of commands) {
    for (const a of c.argv) {
      for (const m of a.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) envRefs.add(m[1]!);
      const up = a.toUpperCase();
      for (const v of SQL_VERBS) if (up.includes(v)) sql.add(v);
    }
  }

  const visit = (cmd: SimpleCommand) => {
    const { argv, sudo: s } = stripWrappers(cmd.argv);
    if (s) sudo = true;
    if (!argv.length) {
      // `env` with nothing after it prints the whole environment
      if (cmd.argv.some((a) => base(a) === "env")) sensitiveRead = true;
      return;
    }
    const prog = base(argv[0]!);
    const args = argv.slice(1);
    programs.add(prog);

    for (const r of cmd.redirects) {
      if (r.op !== "<<<" && isPathLike(r.target)) paths.add(expandHome(r.target, home));
      if ((r.op === ">" || r.op === ">|" || r.op === "&>") && /^\/dev\/(sd|disk|nvme|hd|mmcblk)/.test(r.target)) destructive = true;
    }
    for (const a of args) if (isPathLike(a) && !a.startsWith("-")) paths.add(expandHome(a, home));

    // an interpreter fed by a pipe with no script file: `curl ... | sh`, `... | python3 -`
    if (INTERPRETERS.has(prog) && cmd.piped) {
      const positional = args.filter((a) => !a.startsWith("-"));
      if (positional.length === 0 || (positional.length === 1 && positional[0] === "-")) pipesToShell = true;
    }
    // `bash -c "..."`, `sh -c '...'`: analyze the inner command too
    if (INTERPRETERS.has(prog)) {
      const ci = args.indexOf("-c");
      if (ci !== -1 && args[ci + 1]) {
        for (const inner of parseCommands(args[ci + 1]!).commands) visit(inner);
      }
      if (prog === "python" || prog === "python3" || prog === "node" || prog === "perl" || prog === "ruby") {
        if (args.includes("-c") || args.includes("-e")) ops.add(`${prog}:inline`);
      }
    }
    if (prog === "xargs" && args.length) {
      // skip xargs's own options (and the value of -I / -n / -P), then the rest is the command
      let k = 0;
      while (k < args.length && args[k]!.startsWith("-")) {
        if (["-I", "-n", "-P", "-L", "-s", "-d", "-E"].includes(args[k]!)) k++;
        k++;
      }
      const inner = args.slice(k);
      if (inner.length) visit({ argv: inner, piped: false, redirects: [] });
    }

    if (NETWORK.has(prog)) {
      network = true;
      const before = hosts.size;
      for (const a of args) {
        for (const h of hostsIn(a)) hosts.add(h);
        if (["ssh", "scp", "sftp", "rsync"].includes(prog) && !a.startsWith("-")) {
          const m = /^(?:[^@\s/]+@)?([A-Za-z0-9._-]+):/.exec(a) ?? (prog === "ssh" ? /^(?:[^@\s/]+@)?([A-Za-z0-9._-]+)$/.exec(a) : null);
          if (m && m[1] && !m[1].startsWith(".") && m[1].includes(".") ) hosts.add(m[1]);
          else if (m && m[1] && prog === "ssh") hosts.add(m[1]);
        }
      }
      if (hosts.size === before) hostUnknown = true;
      if ((prog === "curl" || prog === "wget" || prog === "http" || prog === "https")) download = true;
    }
    if (DB_CLIENTS.has(prog)) sensitiveRead = true;
    if (prog === "printenv") sensitiveRead = true;

    // short flags: -rf -> -r, -f
    const flags = new Set<string>();
    for (const a of args) {
      if (/^--[a-zA-Z]/.test(a)) flags.add(a.split("=")[0]!);
      else if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(`-${ch}`);
    }
    const sub = SUBCOMMAND_TOOLS.has(prog) ? args.find((a) => !a.startsWith("-")) : undefined;
    if (sub) ops.add(`${prog}:${sub}`);
    if (CLOUD_CLIS.has(prog)) {
      const words = args.filter((a) => !a.startsWith("-")).slice(0, 3);
      if (words.length >= 2) ops.add(`${prog}:${words.join(":")}`);
      if (words.some((w) => DESTRUCTIVE_SUBCOMMAND.test(w))) destructive = true;
    }
    for (const f of flags) ops.add(`${prog}:${f}`);

    switch (prog) {
      case "rm":
        if (flags.has("-r") || flags.has("-R") || flags.has("-f") || flags.has("--recursive") || flags.has("--force")) destructive = true;
        break;
      case "rmdir":
      case "mkfs":
      case "shred":
      case "wipefs":
      case "shutdown":
      case "reboot":
      case "halt":
      case "killall":
        destructive = true;
        break;
      case "dd":
        if (args.some((a) => a.startsWith("of=/dev/"))) destructive = true;
        break;
      case "chmod":
      case "chown":
      case "chgrp":
        if (flags.has("-R")) destructive = true;
        break;
      case "git":
        if (sub === "clone" || sub === "pull" || sub === "fetch" || sub === "push" || (sub === "remote" && args.includes("update")) || sub === "ls-remote") {
          network = true;
          const before = hosts.size;
          for (const a of args) {
            for (const h of hostsIn(a)) hosts.add(h);
            const m = /^(?:[^@\s/]+@)([A-Za-z0-9._-]+):/.exec(a);
            if (m && m[1]) hosts.add(m[1]);
          }
          if (hosts.size === before) hostUnknown = true;
          if (sub !== "push") download = true;
        }
        if (sub === "push") {
          outbound = true;
          if (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease") || args.includes("+")) destructive = true;
          if (args.some((a) => a.startsWith("+"))) destructive = true;
        }
        if (sub === "reset" && flags.has("--hard")) destructive = true;
        if (sub === "clean" && (flags.has("-f") || flags.has("--force"))) destructive = true;
        if (sub === "branch" && flags.has("-D")) destructive = true;
        if (sub === "checkout" && args.includes("--")) destructive = true;
        if (sub === "stash" && args.includes("drop")) destructive = true;
        break;
      case "terraform":
      case "tofu":
        if (sub === "destroy" || sub === "apply") destructive = true;
        break;
      case "pulumi":
        if (sub === "destroy" || sub === "up") destructive = true;
        break;
      case "kubectl":
        if (sub === "delete" || sub === "drain" || sub === "cordon") destructive = true;
        break;
      case "helm":
        if (sub === "uninstall" || sub === "delete") destructive = true;
        break;
      case "docker":
      case "docker-compose":
      case "podman":
        if (sub === "rm" || sub === "rmi" || sub === "kill" || sub === "down" || (sub === "system" && args.includes("prune")) || (sub === "volume" && args.includes("rm"))) destructive = true;
        if (sub === "push") outbound = true;
        break;
      case "npm":
      case "pnpm":
      case "yarn":
        if (sub === "publish") outbound = true;
        if (sub === "unpublish") destructive = true;
        break;
      case "gh":
        if (sub === "auth" && (args.includes("token") || args.includes("status"))) sensitiveRead = true;
        if (sub === "pr" && args.includes("merge")) outbound = true;
        if (sub === "release") outbound = true;
        if (sub === "repo" && args.includes("delete")) destructive = true;
        break;
      case "curl":
        if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--json"].some((f) => flags.has(f) || args.some((a) => a.startsWith(f + "=")))) outbound = true;
        {
          const xi = args.findIndex((a) => a === "-X" || a === "--request");
          const method = xi !== -1 ? args[xi + 1] : args.find((a) => a.startsWith("-X") && a.length > 2)?.slice(2);
          if (method && /^(POST|PUT|PATCH|DELETE)$/i.test(method)) outbound = true;
          if (method && /^DELETE$/i.test(method)) destructive = true;
        }
        break;
      case "wget":
        if (flags.has("--post-data") || flags.has("--post-file") || flags.has("--method")) outbound = true;
        break;
      case "ssh":
      case "scp":
      case "sftp":
      case "rsync":
        outbound = true;
        break;
      case "psql":
      case "mysql":
      case "sqlite3":
      case "mongosh":
      case "mongo":
      case "redis-cli":
        if (args.includes("FLUSHALL") || args.includes("FLUSHDB")) destructive = true;
        break;
    }
    if (sql.size > 0) destructive = true;

    // secret managers and credential stores
    const words = args.filter((a) => !a.startsWith("-"));
    if (
      (prog === "aws" && (words.includes("secretsmanager") || (words.includes("ssm") && words.some((w) => w.startsWith("get-parameter"))) || (words[0] === "configure" && words[1] === "get"))) ||
      (prog === "gcloud" && (words[0] === "secrets" || (words[0] === "auth" && words.some((w) => w.startsWith("print-"))))) ||
      (prog === "az" && words[0] === "keyvault") ||
      (prog === "vault" && (words[0] === "read" || words[0] === "kv")) ||
      (prog === "op" && (words[0] === "read" || words[0] === "item")) ||
      (prog === "doppler" && words[0] === "secrets") ||
      (prog === "kubectl" && words[0] === "get" && /^secrets?$/.test(words[1] ?? "")) ||
      (prog === "security" && /^find-(generic|internet)-password$/.test(words[0] ?? "")) ||
      (prog === "pass" && words.length > 0)
    ) {
      sensitiveRead = true;
    }
  };
  for (const c of commands) visit(c);

  const secretPath = [...paths].some((p) => matchesSecretPattern(p, patterns));
  const secretEnv = [...envRefs].some((e) => SECRET_ENV.test(e));
  if (secretPath || secretEnv) sensitiveRead = true;
  const externalNetwork = network && (hostUnknown || [...hosts].some((h) => !isInternalHost(h)));

  return {
    programs: [...programs],
    ops: [...ops],
    paths: [...paths],
    envRefs: [...envRefs],
    sql: [...sql],
    commandCount: commands.length,
    heredoc,
    sudo,
    pipesToShell,
    secretPath,
    secretEnv,
    network,
    hosts: [...hosts],
    externalNetwork,
    download,
    sensitiveRead,
    outbound,
    destructive,
  };
}
