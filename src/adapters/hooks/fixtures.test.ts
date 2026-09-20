/**
 * Replay every fixture under fixtures/hooks/<runtime>/ through that runtime's translator, on every OS.
 * A fixture is what a runtime really sends (or, until recorded, what its docs say). If a runtime changes its
 * contract, or a translator regresses, this is the test that notices, without needing the runtime installed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openYenop, type Yenop } from "../../core/index.js";
import { hookTranslator, hookRuntimes } from "./registry.js";
import { decideEvent } from "./pipeline.js";

interface Fixture {
  _meta: { source: string };
  /** effect = the engine's verdict under baseline policy; permission = the answer the runtime is shown (may differ, e.g. ask→deny where a hook cannot ask) */
  expect: { kind: string; effect?: "allow" | "ask" | "deny"; permission?: string };
  event: Record<string, unknown>;
}

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "fixtures", "hooks");
let home: string;
let project: string;
let y: Yenop;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "yenop-fx-"));
  project = join(home, "project");
  mkdirSync(join(project, ".cursor"), { recursive: true });
  y = openYenop({ home, cwd: project }); // baseline policies, enforce mode, fresh run state
});
afterAll(() => {
  y.close();
  rmSync(home, { recursive: true, force: true });
});

const runtimes = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("hook fixtures replay", () => {
  it("has a fixture directory for every hookable runtime, and no directory for an unknown one", () => {
    for (const r of hookRuntimes()) expect(runtimes, `fixtures/hooks/${r} missing`).toContain(r);
    for (const r of runtimes) expect(hookRuntimes(), `fixtures/hooks/${r} has no translator`).toContain(r);
  });

  for (const runtime of runtimes) {
    const files = readdirSync(join(root, runtime)).filter((f) => f.endsWith(".json"));
    describe(runtime, () => {
      for (const file of files) {
        it(`${file} parses and decides as expected`, async () => {
          const t = await hookTranslator(runtime);
          expect(t).toBeDefined();
          const fx = JSON.parse(readFileSync(join(root, runtime, file), "utf8")) as Fixture;
          // the placeholder lives inside JSON strings, so the replacement must be JSON-escaped (Windows paths have backslashes)
          const raw = JSON.stringify(fx.event).split("__PROJECT__").join(JSON.stringify(project).slice(1, -1));
          const event = t!.parse(raw); // must not throw: a real event the translator cannot read is a bug
          expect(event.kind).toBe(fx.expect.kind);
          if (event.kind === "decision") {
            const body = decideEvent(y, t!, event); // null is a valid answer where allow is silence (Claude Code, Codex); Cursor always answers
            // effect is checked against the engine directly, so the fixture's expectation is about policy, not rendering
            const d = y.decide({ ...event.request, callId: `${file}:${Math.random()}` });
            if (fx.expect.effect) expect(d.effect).toBe(fx.expect.effect);
            if (fx.expect.permission) {
              expect(body, "an expected answer needs a body").not.toBeNull();
              const b = body as Record<string, unknown> & { hookSpecificOutput?: { permissionDecision?: string } };
              expect(b["permission"] ?? b.hookSpecificOutput?.permissionDecision).toBe(fx.expect.permission);
            }
          }
        });
      }
    });
  }
});
