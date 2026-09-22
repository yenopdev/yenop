/**
 * OpenAI Agents SDK adapter: Yenop as tool guardrails, in process.
 *
 * The SDK (`@openai/agents`) runs an agent loop in the developer's own process and lets a tool carry
 * `inputGuardrails`, run before the tool executes, and `outputGuardrails`, run after. Yenop plugs in as one of
 * each: the input guardrail is the decision, the output guardrail records the outcome. The shapes below are
 * structural copies of `@openai/agents-core` 0.18.0 (`toolGuardrail.d.ts`); Yenop does not import the SDK,
 * so the developer's SDK version and Yenop's never have to agree, and the tests need no SDK at all.
 *
 *   import { tool } from "@openai/agents";
 *   import { yenopGuardrails } from "yenop/openai-agents";
 *   const guard = yenopGuardrails({ tools: { run_shell: { kind: "shell" }, write_file: { kind: "write" } } });
 *   const runShell = tool({ name: "run_shell", ..., inputGuardrails: guard.inputGuardrails, outputGuardrails: guard.outputGuardrails });
 *
 * What the developer must know:
 *  - Tools here are the developer's own functions, so Yenop cannot know what "run_shell" does by name. `tools`
 *    says what each tool can do; a tool not listed is judged as unknown and not read-only, which the baseline
 *    holds for a person. For a shell tool the argument must be named `command`, for file tools `file_path`
 *    (or several in `paths`), for web tools `url`; `mapArgs` renames anything else.
 *  - A guardrail cannot ask a person. `onAsk` is where the developer routes an ask (a terminal prompt, a
 *    Slack message, their approval UI) and answers true or false. Without `onAsk`, an ask is refused, never
 *    let through: Yenop only ever tightens.
 *  - A deny becomes `rejectContent` with the reason by default, so the agent learns why and can do something
 *    else; `onDeny: "throw"` escalates to the SDK's tripwire exception instead.
 *  - One SDK run is one Yenop run: the run id is bound to the SDK's RunContext object, so run-level facts
 *    (untrusted content taken in, sensitive data touched) follow the agent across its tool calls.
 *  - Yenop's own failure is a rejection, not an allow.
 */
import { randomUUID } from "node:crypto";
import { openYenop, type OpenOptions, type Yenop } from "../../core/index.js";
import { classifyTool } from "../../core/tools.js";
import type { Decision, DecisionRequest, ToolRef } from "../../core/types.js";
import { safeUser } from "../hooks/pipeline.js";

/** `protocol.FunctionCallItem`, the part a guardrail reads. */
export interface ToolCallLike {
  name: string;
  /** The model's arguments, as a JSON string. */
  arguments: string;
  callId: string;
}
/** `ToolInputGuardrailData`: the SDK's run context (one per `run()`), the agent, and the call. */
export interface GuardrailDataLike {
  context: object;
  agent: { name: string };
  toolCall: ToolCallLike;
}
export interface OutputGuardrailDataLike extends GuardrailDataLike {
  output: unknown;
}
export type GuardrailBehavior = { type: "allow" } | { type: "rejectContent"; message: string } | { type: "throwException" };
export interface GuardrailOutput {
  behavior: GuardrailBehavior;
  outputInfo?: unknown;
}
export interface ToolInputGuardrail {
  type: "tool_input";
  name: string;
  run: (data: GuardrailDataLike) => Promise<GuardrailOutput>;
}
export interface ToolOutputGuardrail {
  type: "tool_output";
  name: string;
  run: (data: OutputGuardrailDataLike) => Promise<GuardrailOutput>;
}

/** What one of the agent's tools can do. */
export interface ToolSpec {
  kind: ToolRef["kind"];
  /** Only reads; default false, the safe direction. */
  readOnly?: boolean;
  /** For kind "mcp": the server, so trustedServers/sensitiveServers in config apply. */
  server?: string;
}

export interface YenopGuardrailOptions extends OpenOptions {
  /** What each tool can do, by name. Unlisted tools are judged as unknown, not read-only. */
  tools?: Record<string, ToolSpec>;
  /** Rename or reshape a tool's arguments into what the engine reads (command, file_path, paths, url). */
  mapArgs?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
  /** Route an ask to a person. Resolve true to let the call run. Absent: every ask is refused. */
  onAsk?: (decision: Decision, data: GuardrailDataLike) => Promise<boolean> | boolean;
  /** How a deny reaches the agent. "reject" (default) tells it why; "throw" trips the SDK's exception. */
  onDeny?: "reject" | "throw";
  /** The runtime name in receipts. Default "openai-agents". */
  runtime?: string;
  /** The person the agent acts for, in receipts. Default: the OS user. */
  user?: string;
  /** Share an already-open Yenop instead of opening one. */
  yenop?: Yenop;
}

export interface YenopGuardrails {
  inputGuardrails: ToolInputGuardrail[];
  outputGuardrails: ToolOutputGuardrail[];
  /** The run id Yenop is using for an SDK run context, once the first call has been judged. */
  runIdFor(context: object): string | undefined;
  close(): void;
}

function parseArgs(text: string): Record<string, unknown> | undefined {
  if (text === "" || text === undefined) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function yenopGuardrails(opts: YenopGuardrailOptions = {}): YenopGuardrails {
  const { tools, mapArgs, onAsk, onDeny, runtime, user, yenop: shared, ...open } = opts;
  // The project the agent works in decides the tenant and the policy layers; without an explicit cwd it is the
  // current directory, the same rule the CLI hooks follow. (Found live: decisions had landed under "local".)
  const cwd = open.cwd ?? process.cwd();
  const y = shared ?? openYenop({ ...open, cwd });
  const owned = shared === undefined;
  const rt = runtime ?? "openai-agents";
  const who = user ?? safeUser();
  const runs = new WeakMap<object, string>();
  const runIdOf = (context: object): string => {
    let id = runs.get(context);
    if (!id) {
      id = `${rt}:${randomUUID()}`;
      runs.set(context, id);
    }
    return id;
  };
  const toolRef = (name: string): ToolRef => {
    const spec = tools?.[name];
    if (!spec) return { ...classifyTool(name), kind: "unknown", readOnly: false };
    const ref: ToolRef = { name, kind: spec.kind, readOnly: spec.readOnly ?? false };
    if (spec.server !== undefined) ref.server = spec.server;
    return ref;
  };
  const reject = (message: string): GuardrailOutput => ({ behavior: { type: "rejectContent", message } });

  const input: ToolInputGuardrail = {
    type: "tool_input",
    name: "yenop",
    async run(data) {
      const { name, callId } = data.toolCall;
      let request: DecisionRequest;
      let d: Decision;
      try {
        const raw = parseArgs(data.toolCall.arguments);
        if (raw === undefined) return reject(`Yenop: the arguments for ${name} are not a JSON object; the call is refused.`);
        const args = mapArgs ? mapArgs(name, raw) : raw;
        request = { runId: runIdOf(data.context), principal: { runtime: rt, agent: data.agent.name, user: who }, tool: toolRef(name), args, cwd, callId };
        d = y.decide(request);
      } catch (e) {
        return reject(`Yenop failed and refuses by default: ${(e as Error).message}. Run "yenop status".`);
      }
      const info = { receiptId: d.receiptId, effect: d.effect, reasons: d.reasons, mode: d.mode };
      if (d.mode === "observe" || d.effect === "allow") return { behavior: { type: "allow" }, outputInfo: info };
      if (d.effect === "deny") return onDeny === "throw" ? { behavior: { type: "throwException" }, outputInfo: info } : { ...reject(`Yenop: ${d.message}`), outputInfo: info };
      // ask
      if (!onAsk) {
        y.recordOutcome(request.runId, callId, name, "denied", "no onAsk handler: the agent cannot ask a person");
        return { ...reject(`Yenop: ${d.message} This agent has no way to ask a person, so the call is refused; give yenopGuardrails an onAsk handler to route approvals.`), outputInfo: info };
      }
      let ok = false;
      try {
        ok = (await onAsk(d, data)) === true;
      } catch (e) {
        y.recordOutcome(request.runId, callId, name, "denied", `onAsk failed: ${(e as Error).message}`);
        return { ...reject(`Yenop: the approval handler failed (${(e as Error).message}); the call is refused.`), outputInfo: info };
      }
      if (ok) return { behavior: { type: "allow" }, outputInfo: { ...info, approvedBy: "person" } };
      y.recordOutcome(request.runId, callId, name, "denied", "declined by the person");
      return { ...reject(`Yenop: a person declined this call. ${d.message}`), outputInfo: info };
    },
  };

  const output: ToolOutputGuardrail = {
    type: "tool_output",
    name: "yenop-outcome",
    async run(data) {
      try {
        const runId = runs.get(data.context);
        if (runId) y.recordOutcome(runId, data.toolCall.callId, data.toolCall.name, "ran");
      } catch {
        /* recording never blocks the output */
      }
      return { behavior: { type: "allow" } };
    },
  };

  return {
    inputGuardrails: [input],
    outputGuardrails: [output],
    runIdFor: (context) => runs.get(context),
    close: () => {
      if (owned) y.close();
    },
  };
}
