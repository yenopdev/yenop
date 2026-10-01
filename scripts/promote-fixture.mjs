#!/usr/bin/env node
// Turn one recorded hook event into a fixture file, redacting the fields that can carry content or secrets.
// usage: node scripts/promote-fixture.mjs <recording.jsonl> <line-number> <runtime> <name> <expect-kind> [expect-effect]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [file, lineNo, runtime, name, kind, effect] = process.argv.slice(2);
if (!file || !lineNo || !runtime || !name || !kind) {
  console.error("usage: promote-fixture.mjs <recording.jsonl> <line> <runtime> <name> <kind> [effect]");
  process.exit(2);
}
const line = readFileSync(file, "utf8").split("\n")[Number(lineNo) - 1];
if (!line) throw new Error(`no line ${lineNo} in ${file}`);
const rec = JSON.parse(line);
const event = JSON.parse(rec.raw);

// Redact anything that can carry file contents or secrets. Add fields here as new runtimes appear.
const REDACT = ["content", "contents", "tool_output", "tool_response", "output", "result_json", "text", "prompt", "agent_message", "transcript_path", "user_email"];
const scrub = (o) => {
  if (Array.isArray(o)) return o.map(scrub);
  if (o && typeof o === "object") {
    for (const k of Object.keys(o)) o[k] = REDACT.includes(k) ? (o[k] === null ? null : "REDACTED") : scrub(o[k]);
  }
  return o;
};
scrub(event);
// Project paths become a placeholder so the fixture is machine-independent. Cursor sends cwd as "" on some
// events, so an empty cwd counts as absent, and every workspace root is replaced, not only the first: the model
// may have written an absolute path into its own command.
const roots = (Array.isArray(event.workspace_roots) ? event.workspace_roots : []).filter((r) => typeof r === "string" && r !== "");
const cwd = typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : undefined;
const projectPaths = [...new Set([cwd, ...roots].filter(Boolean))].sort((a, b) => b.length - a.length); // longest first
let text = JSON.stringify(event);
// the path appears JSON-escaped inside the serialized event (backslashes doubled on Windows)
for (const path of projectPaths) text = text.split(JSON.stringify(path).slice(1, -1)).join("__PROJECT__");
// A fixture is public. Refuse to write one that still names this machine's home directory.
const homeEscaped = JSON.stringify(homedir()).slice(1, -1);
if (text.includes(homeEscaped)) {
  console.error(`refusing to write: the event still contains the home directory after placeholder substitution; add the path to workspace_roots or cwd, or redact it by hand`);
  process.exit(1);
}
const fixture = { _meta: { source: "recorded", recordedAt: rec.ts, runtime }, expect: effect ? { kind, effect } : { kind }, event: JSON.parse(text) };
const dir = join("fixtures", "hooks", runtime);
mkdirSync(dir, { recursive: true });
const out = join(dir, `${name}.json`);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}  (review it before committing)`);
