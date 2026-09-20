/**
 * The runtimes Yenop can hook. `yenop hook <runtime>` and the daemon's /hooks/<runtime> route both look here,
 * so adding a runtime is one translator and one line. Loading is lazy on purpose: the command hook must stay
 * close to bare Node startup, so it loads its own translator and nothing else.
 */
import type { HookTranslator } from "./pipeline.js";

const LOADERS: Record<string, () => Promise<HookTranslator>> = {
  "claude-code": async () => (await import("../claude-code/hook.js")).claudeCodeTranslator,
  cursor: async () => (await import("../cursor/hook.js")).cursorTranslator,
  codex: async () => (await import("../codex/hook.js")).codexTranslator,
};

export async function hookTranslator(runtime: string): Promise<HookTranslator | undefined> {
  const load = Object.prototype.hasOwnProperty.call(LOADERS, runtime) ? LOADERS[runtime] : undefined;
  return load ? load() : undefined;
}
export function hookRuntimes(): string[] {
  return Object.keys(LOADERS);
}
