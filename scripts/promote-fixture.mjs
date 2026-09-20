#!/usr/bin/env node
// Turn one recorded hook event into a fixture file, redacting the fields that can carry content or secrets.
// usage: node scripts/promote-fixture.mjs <recording.jsonl> <line-number> <runtime> <name> <expect-kind> [expect-effect]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
// Project paths become a placeholder so the fixture is machine-independent.
const roots = Array.isArray(event.workspace_roots) ? event.workspace_roots : [];
const cwd = typeof event.cwd === "string" ? event.cwd : roots[0];
let text = JSON.stringify(event);
// the path appears JSON-escaped inside the serialized event (backslashes doubled on Windows)
if (cwd) text = text.split(JSON.stringify(cwd).slice(1, -1)).join("__PROJECT__");
const fixture = { _meta: { source: "recorded", recordedAt: rec.ts, runtime }, expect: effect ? { kind, effect } : { kind }, event: JSON.parse(text) };
const dir = join("fixtures", "hooks", runtime);
mkdirSync(dir, { recursive: true });
const out = join(dir, `${name}.json`);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}  (review it before committing)`);
