/**
 * The shared hook pipeline. Every runtime that calls a command before acting (Claude Code, Cursor, Codex,
 * Gemini CLI, ...) goes through this: one translator per runtime turns that runtime's event into a
 * DecisionRequest and turns Yenop's decision back into the runtime's answer. The engine, the policies, the
 * run state and the receipts never know which runtime asked.
 *
 * Security rules of this file, in order:
 *  - Fail closed. Input that cannot be parsed, or that a translator rejects, is a deny, never "no opinion".
 *    A permission hook that prints nothing when it should have judged is a bypass.
 *  - stdin is untrusted. Translators validate shape and never trust a field they did not check.
 *  - Nothing the agent can influence weakens enforcement: the only escape hatch is observe mode, which is
 *    operator configuration and is honoured exactly as in every other path.
 *
 * Performance: the fast path posts the raw event to the resident daemon over a raw socket (about a
 * millisecond); the fallback decides in-process and then starts a daemon for next time. Both are shared, so
 * a new runtime costs a translator and nothing else.
 */
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import type { DecisionRequest, Outcome } from "../../core/types.js";
import type { Mode } from "../../core/config.js";

export type Effect = "allow" | "ask" | "deny";

export type HookEvent =
  | {
      kind: "decision";
      request: DecisionRequest;
      /** false when the runtime's hook can only allow or deny: an ask must then become a deny, never an allow. */
      askCapable: boolean;
      /** the runtime's own event name, for translators that answer differently per event */
      event: string;
    }
  | { kind: "outcome"; runId: string; callId: string; tool: string; outcome: Outcome; detail?: string }
  | { kind: "session-end"; runId: string }
  | { kind: "ignore" };

export interface HookRunResult {
  stdout: string;
  exitCode: number;
}

export interface HookTranslator {
  /** The runtime id, also the daemon route: /hooks/<runtime>. */
  runtime: string;
  /** Parse raw stdin. MUST throw on input it cannot make sense of; the pipeline turns that into a deny. */
  parse(raw: string): HookEvent;
  /** The runtime's answer for a decision. Always an object for a decision the runtime is waiting on. */
  body(effect: Effect, message: string, mode: Mode, event: Extract<HookEvent, { kind: "decision" }>): Record<string, unknown> | null;
  /** How to print a body: null or an empty object means print nothing. */
  result(body: Record<string, unknown> | null): HookRunResult;
  /** The answer when Yenop itself failed. MUST block. */
  failure(reason: string): HookRunResult;
}

export function yenopHome(): string {
  return process.env["YENOP_HOME"] ?? join(homedir(), ".yenop");
}

function isEmpty(o: Record<string, unknown> | null): boolean {
  return o === null || Object.keys(o).length === 0;
}

/**
 * Decide one raw hook event for a runtime. Daemon first, in-process second. Throws only on a Yenop failure,
 * which the caller renders with translator.failure() so the runtime blocks.
 */
export async function runHookWith(t: HookTranslator, raw: string): Promise<HookRunResult> {
  const home = yenopHome();
  const useDaemon = process.env["YENOP_NO_DAEMON"] !== "1";
  recordRawEvent(t.runtime, raw);

  if (useDaemon) {
    const { readDaemonInfoFast, rawPost } = await import("../../daemon/fast.js");
    const info = readDaemonInfoFast(home);
    if (info) {
      try {
        const r = await rawPost(info, `/hooks/${t.runtime}`, raw, 1500);
        if (r.status === 200) {
          const body = JSON.parse(r.body) as Record<string, unknown>;
          return t.result(isEmpty(body) ? null : body);
        }
      } catch {
        /* daemon not reachable: decide here */
      }
    }
  }

  const event = t.parse(raw); // throws on malformed input → caller fails closed
  if (event.kind === "ignore") return t.result(null);

  const { openYenop } = await import("../../core/index.js");
  const cwd = event.kind === "decision" ? event.request.cwd : undefined;
  const yenop = openYenop(cwd !== undefined ? { cwd } : {});
  try {
    return t.result(decideEvent(yenop, t, event));
  } finally {
    yenop.close();
    if (useDaemon) {
      const { startDaemonDetached } = await import("../../daemon/client.js");
      try {
        startDaemonDetached(home);
      } catch {
        /* next call will try again */
      }
    }
  }
}

/** Apply one parsed event to an open Yenop and produce the runtime's body. Shared by the daemon route. */
export function decideEvent(
  yenop: { decide: (r: DecisionRequest) => { effect: Effect; message: string }; recordOutcome: (runId: string, callId: string, tool: string, outcome: Outcome, detail?: string) => unknown; config: { mode: Mode } },
  t: HookTranslator,
  event: HookEvent,
): Record<string, unknown> | null {
  switch (event.kind) {
    case "outcome":
      yenop.recordOutcome(event.runId, event.callId, event.tool, event.outcome, event.detail);
      return null;
    case "session-end":
      return null; // run expiry lands with the run-state work; nothing to do yet
    case "ignore":
      return null;
    case "decision": {
      const d = yenop.decide(event.request);
      return t.body(d.effect, d.message, yenop.config.mode, event);
    }
  }
}

/**
 * Opt-in recorder for building test fixtures from what a runtime REALLY sends, rather than what its docs say.
 * `YENOP_RECORD_HOOKS=<dir>` appends one line per event to <dir>/<runtime>.jsonl. Off by default. Recordings can
 * contain file contents and secrets (Cursor's beforeReadFile carries the file), so they are reviewed and
 * redacted before becoming fixtures; see docs/test-plan.md. Errors here never affect the decision.
 */
function recordRawEvent(runtime: string, raw: string): void {
  const dir = process.env["YENOP_RECORD_HOOKS"];
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${runtime}.jsonl`), JSON.stringify({ runtime, ts: new Date().toISOString(), raw }) + "\n");
  } catch {
    /* recording is a convenience; the decision must not depend on it */
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
