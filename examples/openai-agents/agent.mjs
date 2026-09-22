// A minimal OpenAI Agents SDK agent with Yenop in front of its tools.
//
//   cd examples/openai-agents && npm install
//   cd /path/to/a/project && OPENAI_API_KEY=... node /path/to/yenop/examples/openai-agents/agent.mjs "Run npm test"
//
// The agent has two tools, a shell and a file reader. Yenop judges every call before it runs: the boring ones
// go through silently, a secret read is refused with the reason handed back to the model, and a destructive
// command is put to you in the terminal before it runs. Receipts land in Yenop's log as for any other agent.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Agent, run, tool } from "@openai/agents";
import { yenopGuardrails } from "yenop/openai-agents";

const rl = createInterface({ input: stdin, output: stdout });

const guard = yenopGuardrails({
  tools: {
    run_shell: { kind: "shell" },
    read_file: { kind: "read", readOnly: true },
  },
  // Yenop cannot show a prompt from inside a guardrail; this is where the ask reaches a person.
  onAsk: async (decision, data) => {
    const answer = await rl.question(`\nYenop asks: ${decision.message}\n  ${data.toolCall.name} ${data.toolCall.arguments}\nAllow? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  },
});

const runShell = tool({
  name: "run_shell",
  description: "Run a shell command in the current project and return its output.",
  parameters: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    try {
      return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch (e) {
      return `exit ${e.status ?? "?"}: ${e.stderr ?? e.message}`;
    }
  },
  inputGuardrails: guard.inputGuardrails,
  outputGuardrails: guard.outputGuardrails,
});

const readFile = tool({
  name: "read_file",
  description: "Read a file from the current project.",
  parameters: z.object({ file_path: z.string() }),
  execute: async ({ file_path }) => readFileSync(file_path, "utf8").slice(0, 4000),
  inputGuardrails: guard.inputGuardrails,
  outputGuardrails: guard.outputGuardrails,
});

const agent = new Agent({
  name: "coder",
  instructions: "You are a coding assistant working in the current directory. Use the tools to do what is asked and report the result briefly. If a tool call is rejected, say why and stop.",
  tools: [runShell, readFile],
});

const prompts = process.argv.slice(2).length ? process.argv.slice(2) : ["Run npm test.", "Print the contents of the .npmrc file.", "Delete the build folder."];
for (const prompt of prompts) {
  console.log(`\n> ${prompt}`);
  const result = await run(agent, prompt); // each run is one Yenop run: its history follows the agent
  console.log(result.finalOutput);
}
rl.close();
guard.close();
console.log("\nReceipts: yenop receipts --last 10");
