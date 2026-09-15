import { DatabaseSync } from "node:sqlite";
import type { Decision, Effect, RunStateStore } from "./types.js";

/** Run counters in a local SQLite file. One row per (tenant, run). Increments are atomic. */
export class SqliteRunState implements RunStateStore {
  private db: DatabaseSync;
  private bumpStmt;
  private peekStmt;
  private recallStmt;
  private rememberStmt;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        tenant TEXT NOT NULL,
        run_id TEXT NOT NULL,
        steps INTEGER NOT NULL DEFAULT 0,
        denies INTEGER NOT NULL DEFAULT 0,
        asks INTEGER NOT NULL DEFAULT 0,
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
    this.bumpStmt = this.db.prepare(`
      INSERT INTO runs (tenant, run_id, steps, denies, asks, started_at, last_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(tenant, run_id) DO UPDATE SET
        steps = steps + 1,
        denies = denies + excluded.denies,
        asks = asks + excluded.asks,
        last_at = excluded.last_at
      RETURNING steps, denies, asks
    `);
    this.peekStmt = this.db.prepare(`SELECT steps, denies, asks FROM runs WHERE tenant = ? AND run_id = ?`);
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

  bump(tenant: string, runId: string, effect: Effect): { steps: number; denies: number; asks: number } {
    const now = new Date().toISOString();
    const row = this.bumpStmt.get(tenant, runId, effect === "deny" ? 1 : 0, effect === "ask" ? 1 : 0, now, now) as
      | { steps: number; denies: number; asks: number }
      | undefined;
    if (!row) throw new Error("yenop: state bump returned no row");
    return { steps: Number(row.steps), denies: Number(row.denies), asks: Number(row.asks) };
  }

  peek(tenant: string, runId: string): { steps: number; denies: number; asks: number } {
    const row = this.peekStmt.get(tenant, runId) as { steps: number; denies: number; asks: number } | undefined;
    return row ? { steps: Number(row.steps), denies: Number(row.denies), asks: Number(row.asks) } : { steps: 0, denies: 0, asks: 0 };
  }

  close(): void {
    this.db.close();
  }
}

/** Counters that live only for the life of the process. Used by dry runs and tests. */
export class MemoryRunState implements RunStateStore {
  private runs = new Map<string, { steps: number; denies: number; asks: number }>();
  bump(tenant: string, runId: string, effect: Effect): { steps: number; denies: number; asks: number } {
    const k = `${tenant}\u0000${runId}`;
    const r = this.runs.get(k) ?? { steps: 0, denies: 0, asks: 0 };
    r.steps += 1;
    if (effect === "deny") r.denies += 1;
    if (effect === "ask") r.asks += 1;
    this.runs.set(k, r);
    return { ...r };
  }
  peek(tenant: string, runId: string): { steps: number; denies: number; asks: number } {
    return { ...(this.runs.get(`${tenant}\u0000${runId}`) ?? { steps: 0, denies: 0, asks: 0 }) };
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
