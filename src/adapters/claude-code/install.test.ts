import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCodeHook } from "./install.js";

describe("claude code hook installer", () => {
  it("installs once, then reports already installed, and leaves other hooks alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "yenop-install-"));
    mkdirSync(join(dir, ".claude"));
    const path = join(dir, ".claude", "settings.local.json");
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }] } }));
    const cmd = 'node "/opt/yenop/dist/cli/main.js" hook claude-code';
    expect(installClaudeCodeHook(path, cmd).changed).toBe(true);
    expect(installClaudeCodeHook(path, cmd).changed).toBe(false);
    const s = JSON.parse(readFileSync(path, "utf8")) as { permissions: unknown; hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    expect(s.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse.filter((g) => g.hooks[0]?.command === cmd)).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("echo other");
  });
  it("replaces a stale Yenop entry that points at an old path", () => {
    const dir = mkdtempSync(join(tmpdir(), "yenop-install-"));
    const path = join(dir, "settings.local.json");
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node /old/main.js hook claude-code" }] }] } }));
    expect(installClaudeCodeHook(path, "node /new/main.js hook claude-code").changed).toBe(true);
    const s = JSON.parse(readFileSync(path, "utf8")) as { hooks: { PreToolUse: { hooks: { command?: string }[] }[] } };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("node /new/main.js hook claude-code");
  });
});
