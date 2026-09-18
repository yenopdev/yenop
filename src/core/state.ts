import { DatabaseSync } from "node:sqlite";
import type { Decision, Effect, FlowFacts, RunFacts, RunStateStore } from "./types.js";

/** Schema version of the local state database, stored in PRAGMA user_version. 2 added run facts. */
export const STATE_VERSION = 2;

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
    this.recallStmt = this.db.prepare(`SELECT decision FROM calls WHERE tenant = ? AND run_id = ? AND call_id = ?`);
    this.rememberStmt = this.db.prepare(`INSERT OR IGNORE INTO calls (tenant, run_id, call_id, decision, at) VALUES (?, ?, ?, ?, ?)`);
  }

  recallCall(tenant: string, runId: string, callId: string): Decision | undefined {
    const row = this.recallStmt.get(tenant, runId, callId) as { decision: string } | undefined;
    return row ? (JSON.parse(row.decision) as Decision) : undefined;
  }

  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void {
    this.rememberStmt.run(tenant, runId, callId, JSON.stringify(decision), new Date().toISOString());
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

  close(): void {
    this.db.close();
  }
}

/** Counters that live only for the life of the process. Used by dry runs and tests. */
export class MemoryRunState implements RunStateStore {
  private runs = new Map<string, RunFacts>();
  bump(tenant: string, runId: string, effect: Effect, flow?: FlowFacts): RunFacts {
    const k = `${tenant}\u0000${runId}`;
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
  private calls = new Map<string, Decision>();
  recallCall(tenant: string, runId: string, callId: string): Decision | undefined {
    return this.calls.get(`${tenant}\u0000${runId}\u0000${callId}`);
  }
  rememberCall(tenant: string, runId: string, callId: string, decision: Decision): void {
    this.calls.set(`${tenant}\u0000${runId}\u0000${callId}`, decision);
  }
  close(): void {}
}
