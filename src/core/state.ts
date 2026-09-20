import { DatabaseSync } from "node:sqlite";
import type { Decision, Effect, FlowFacts, Outcome, RunFacts, RunStateStore, StepRecord } from "./types.js";

interface StepRow {
  step: number;
  call_id: string | null;
  tool: string;
  summary: string;
  effect: string;
  untrusted: number;
  sensitive: number;
  receipt_id: string;
  outcome: string | null;
}
const toStep = (r: StepRow): StepRecord => {
  const s: StepRecord = {
    step: Number(r.step),
    tool: r.tool,
    summary: r.summary,
    effect: r.effect as Effect,
    ingestsUntrusted: Number(r.untrusted) > 0,
    readsSensitive: Number(r.sensitive) > 0,
    receiptId: r.receipt_id,
  };
  if (r.call_id) s.callId = r.call_id;
  if (r.outcome) s.outcome = r.outcome as Outcome;
  return s;
};

/** Schema version of the local state database, stored in PRAGMA user_version. 2 added run facts, 3 the step history. */
/** How long a repeated call id returns the earlier decision. Long enough for a double-fired hook, far too short to outlive a rebuild. */
export const REPLAY_WINDOW_MS = 30_000;

/** A run idle longer than this is treated as ended; the next call on its id starts fresh. Two hours: long enough
 * for a developer to step away mid-task, short enough that a crashed session does not haunt the next one. */
export const RUN_IDLE_MS = 2 * 60 * 60 * 1000;

export const STATE_VERSION = 3;

interface Row {
  steps: number;
  denies: number;
  asks: number;
  untrusted: number;
  sensitive: number;
  outbound: number;
  destructive: number;
}
const EMPTY: RunFacts = { steps: 0, denies: 0, asks: 0, untrusted: false, sensitive: false, outbound: 0, destructive: 0 };
const toFacts = (r: Row): RunFacts => ({
  steps: Number(r.steps),
  denies: Number(r.denies),
  asks: Number(r.asks),
  untrusted: Number(r.untrusted) > 0,
  sensitive: Number(r.sensitive) > 0,
  outbound: Number(r.outbound),
  destructive: Number(r.destructive),
});

/** Run facts in a local SQLite file. One row per (tenant, run). Updates are atomic. */
export class SqliteRunState implements RunStateStore {
  private db: DatabaseSync;
  private bumpStmt;
  private peekStmt;
  private recallStmt;
  private rememberStmt;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const found = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (found > STATE_VERSION) throw new Error(`yenop: state database is version ${found}; this Yenop understands up to ${STATE_VERSION}. Upgrade Yenop.`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        tenant TEXT NOT NULL,
        run_id TEXT NOT NULL,
        steps INTEGER NOT NULL DEFAULT 0,
        denies INTEGER NOT NULL DEFAULT 0,
        asks INTEGER NOT NULL DEFAULT 0,
        untrusted INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0,
        outbound INTEGER NOT NULL DEFAULT 0,
        destructive INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        PRIMARY KEY (tenant, run_id)
      );
      CREATE TABLE IF NOT EXISTS calls (
        tenant TEXT NOT NULL,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (tenant, run_id, call_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_steps (
        tenant TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        call_id TEXT,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        effect TEXT NOT NULL,
        untrusted INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0,
        receipt_id TEXT NOT NULL,
        outcome TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (tenant, run_id, step)
      );
      CREATE INDEX IF NOT EXISTS run_steps_call ON run_steps (tenant, run_id, call_id);
    `);
    // version 1 databases have the runs table without the fact columns
    const cols = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name));
    for (const c of ["untrusted", "sensitive", "outbound", "destructive"]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`PRAGMA user_version = ${STATE_VERSION}`);
    this.bumpStmt = this.db.prepare(`
      INSERT INTO runs (tenant, run_id, steps, denies, asks, untrusted, sensitive, outbound, destructive, started_at, last_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, run_id) DO UPDATE SET
        steps = steps + 1,
        denies = denies + excluded.denies,
        asks = asks + excluded.asks,
        untrusted = MAX(untrusted, excluded.untrusted),
        sensitive = MAX(sensitive, excluded.sensitive),
        outbound = outbound + excluded.outbound,
        destructive = destructive + excluded.destructive,
        last_at = excluded.last_at
      RETURNING steps, denies, asks, untrusted, sensitive, outbound, destructive
    `);
    this.peekStmt = this.db.prepare(`SELECT steps, denies, asks, untrusted, sensitive, outbound, destructive FROM runs WHERE tenant = ? AND run_id = ?`);
    // A repeated call id is replayed only within a short window. The reason idempotency exists is the desktop
    // app firing a hook twice within a second; a decision remembered for longer would outlive the rules or the
    // build that made it, and a stale "allow" is a bypass. Found when a security fix appeared not to work
    // because the recorded call ids replayed an hour-old allow.
    this.recallStmt = this.db.prepare(`SELECT decision FROM calls WHERE tenant = ? AND run_id = ? AND call_id = ? AND at > ?`);
    this.rememberStmt = this.db.prepare(`INSERT OR IGNORE INTO calls (tenant, run_id, call_id, decision, at) VALUES (?, ?, ?, ?, ?)`);
  }

  recallCall(tenant: string, runId: string, callId: string): Decision | undefined {
    const cutoff = new Date(Date.now() - REPLAY_WINDOW_MS).toISOString();
    const row = this.recallStmt.get(tenant, runId, callId, cutoff) as { decision: string } | undefined;
    return row ? (JSON.parse(row.decision) as Decision) : undefined;
  }

  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void {
    this.rememberStmt.run(tenant, runId, callId, JSON.stringify(decision), new Date().toISOString());
  }

  expireIfIdle(tenant: string, runId: string, idleMs: number): boolean {
    const row = this.db.prepare(`SELECT last_at FROM runs WHERE tenant = ? AND run_id = ?`).get(tenant, runId) as { last_at?: string } | undefined;
    if (!row?.last_at) return false;
    if (Date.now() - new Date(row.last_at).getTime() <= idleMs) return false;
    this.endRun(tenant, runId);
    return true;
  }

  endRun(tenant: string, runId: string): void {
    this.db.prepare(`DELETE FROM runs WHERE tenant = ? AND run_id = ?`).run(tenant, runId);
    this.db.prepare(`DELETE FROM run_steps WHERE tenant = ? AND run_id = ?`).run(tenant, runId);
    this.db.prepare(`DELETE FROM calls WHERE tenant = ? AND run_id = ?`).run(tenant, runId);
  }

  bump(tenant: string, runId: string, effect: Effect, flow?: FlowFacts): RunFacts {
    const now = new Date().toISOString();
    // A denied call did not happen, so it leaves no mark on the run.
    const f = effect === "deny" ? undefined : flow;
    const row = this.bumpStmt.get(
      tenant,
      runId,
      effect === "deny" ? 1 : 0,
      effect === "ask" ? 1 : 0,
      f?.ingestsUntrusted ? 1 : 0,
      f?.readsSensitive ? 1 : 0,
      f?.sendsOut ? 1 : 0,
      f?.changesState ? 1 : 0,
      now,
      now,
    ) as Row | undefined;
    if (!row) throw new Error("yenop: state bump returned no row");
    return toFacts(row);
  }

  peek(tenant: string, runId: string): RunFacts {
    const row = this.peekStmt.get(tenant, runId) as Row | undefined;
    return row ? toFacts(row) : { ...EMPTY };
  }

  recordStep(tenant: string, runId: string, s: StepRecord): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO run_steps (tenant, run_id, step, call_id, tool, summary, effect, untrusted, sensitive, receipt_id, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(tenant, runId, s.step, s.callId ?? null, s.tool, s.summary, s.effect, s.ingestsUntrusted ? 1 : 0, s.readsSensitive ? 1 : 0, s.receiptId, new Date().toISOString());
  }

  recentSteps(tenant: string, runId: string, limit: number): StepRecord[] {
    const rows = this.db.prepare(`SELECT * FROM run_steps WHERE tenant = ? AND run_id = ? ORDER BY step DESC LIMIT ?`).all(tenant, runId, limit) as unknown as StepRow[];
    return rows.map(toStep).reverse();
  }

  markSources(tenant: string, runId: string): { untrusted?: StepRecord; sensitive?: StepRecord } {
    const first = (col: "untrusted" | "sensitive") =>
      this.db.prepare(`SELECT * FROM run_steps WHERE tenant = ? AND run_id = ? AND ${col} = 1 AND effect != 'deny' ORDER BY step ASC LIMIT 1`).get(tenant, runId) as unknown as StepRow | undefined;
    const out: { untrusted?: StepRecord; sensitive?: StepRecord } = {};
    const u = first("untrusted");
    const s = first("sensitive");
    if (u) out.untrusted = toStep(u);
    if (s) out.sensitive = toStep(s);
    return out;
  }

  setOutcome(tenant: string, runId: string, callId: string, outcome: Outcome): StepRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM run_steps WHERE tenant = ? AND run_id = ? AND call_id = ? ORDER BY step DESC LIMIT 1`).get(tenant, runId, callId) as unknown as StepRow | undefined;
    if (!row || row.outcome) return undefined;
    this.db.prepare(`UPDATE run_steps SET outcome = ? WHERE tenant = ? AND run_id = ? AND step = ?`).run(outcome, tenant, runId, row.step);
    return toStep({ ...row, outcome });
  }

  close(): void {
    this.db.close();
  }
}

/** Counters that live only for the life of the process. Used by dry runs and tests. */
export class MemoryRunState implements RunStateStore {
  private runs = new Map<string, RunFacts>();
  private lastAt = new Map<string, number>();
  expireIfIdle(tenant: string, runId: string, idleMs: number): boolean {
    const k = `${tenant}\u0000${runId}`;
    const last = this.lastAt.get(k);
    if (last === undefined || Date.now() - last <= idleMs) return false;
    this.endRun(tenant, runId);
    return true;
  }
  endRun(tenant: string, runId: string): void {
    const k = `${tenant}\u0000${runId}`;
    this.runs.delete(k);
    this.steps.delete(k);
    this.calls.forEach((_v, key) => {
      if (key.startsWith(`${tenant}\u0000${runId}\u0000`)) this.calls.delete(key);
    });
    this.lastAt.delete(k);
  }
  bump(tenant: string, runId: string, effect: Effect, flow?: FlowFacts): RunFacts {
    const k = `${tenant}\u0000${runId}`;
    this.lastAt.set(k, Date.now());
    const r = this.runs.get(k) ?? { ...EMPTY };
    r.steps += 1;
    if (effect === "deny") r.denies += 1;
    if (effect === "ask") r.asks += 1;
    if (effect !== "deny" && flow) {
      r.untrusted ||= flow.ingestsUntrusted;
      r.sensitive ||= flow.readsSensitive;
      if (flow.sendsOut) r.outbound += 1;
      if (flow.changesState) r.destructive += 1;
    }
    this.runs.set(k, r);
    return { ...r };
  }
  peek(tenant: string, runId: string): RunFacts {
    return { ...(this.runs.get(`${tenant}\u0000${runId}`) ?? EMPTY) };
  }
  private steps = new Map<string, StepRecord[]>();
  recordStep(tenant: string, runId: string, s: StepRecord): void {
    const k = `${tenant}\u0000${runId}`;
    const list = this.steps.get(k) ?? [];
    list.push({ ...s });
    this.steps.set(k, list);
  }
  recentSteps(tenant: string, runId: string, limit: number): StepRecord[] {
    return (this.steps.get(`${tenant}\u0000${runId}`) ?? []).slice(-limit).map((s) => ({ ...s }));
  }
  markSources(tenant: string, runId: string): { untrusted?: StepRecord; sensitive?: StepRecord } {
    const list = (this.steps.get(`${tenant}\u0000${runId}`) ?? []).filter((s) => s.effect !== "deny");
    const out: { untrusted?: StepRecord; sensitive?: StepRecord } = {};
    const u = list.find((s) => s.ingestsUntrusted);
    const se = list.find((s) => s.readsSensitive);
    if (u) out.untrusted = { ...u };
    if (se) out.sensitive = { ...se };
    return out;
  }
  setOutcome(tenant: string, runId: string, callId: string, outcome: Outcome): StepRecord | undefined {
    const list = this.steps.get(`${tenant}\u0000${runId}`) ?? [];
    const s = [...list].reverse().find((x) => x.callId === callId);
    if (!s || s.outcome) return undefined;
    s.outcome = outcome;
    return { ...s };
  }
  private calls = new Map<string, { decision: Decision; at: number }>();
  recallCall(tenant: string, runId: string, callId: string): Decision | undefined {
    const hit = this.calls.get(`${tenant}\u0000${runId}\u0000${callId}`);
    return hit && Date.now() - hit.at <= REPLAY_WINDOW_MS ? hit.decision : undefined;
  }
  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void {
    this.calls.set(`${tenant}\u0000${runId}\u0000${callId}`, { decision, at: Date.now() });
  }
  close(): void {}
}
