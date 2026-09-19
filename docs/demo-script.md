# Yenop demo script

Written for: you, presenting Yenop to a customer. Not for the customer to read.

This is a talk track around `yenop demo`. The command does the work; your job is the story between the acts. It runs with no AI agent, no network, and no UI, so it never fails live. Read this once, run the command twice on your own, and you are ready.

## Before the meeting

- Terminal font large (18pt+). Dark or light both fine; the demo colors ALLOW green, ASK yellow, BLOCK red.
- Run it once to warm up: `yenop demo`. It takes a few seconds and cleans up after itself. It touches nothing real.
- Have one sentence ready for what the customer does: "You build agents that touch \_\_\_." Fill the blank from their business. That is the only customization you need.

## The one-line pitch

"Yenop is a checkpoint between an AI agent and the systems it can touch. It lets the safe work through, stops the dangerous work, asks a person for the in-between, and writes down every decision. It runs next to the agent, on your machines, with no cloud."

If they only remember one thing: **the agent proposes, Yenop disposes, and there is a receipt.**

## Why this matters now (say this first, 60 seconds)

"Companies are giving AI agents real access: your code, your database, your cloud. The agent is helpful, but it does what it is told, including by a web page or a document that carries a hidden instruction. And the newest models reason in ways you cannot read or log, so you cannot audit the thinking. You can only govern the actions. That is the one place left to put a control, and that is where Yenop sits."

Then: "Let me show you. Everything here is the real engine, not slides."

Run `yenop demo` and talk through the five acts. Each act prints a short setup line you can read aloud, then the agent's attempts and Yenop's verdicts.

## The five acts, and what to say

**Act 1, invisible when safe.** "Most of what an agent does is fine, and Yenop does not get in the way. Tests, edits, reads: all allowed, no prompt. If this were noisy, your developers would rip it out on day one. It only speaks up when it should."

**Act 2, the hidden instruction.** This is your headline. "The agent read a vendor page. Somewhere in that page was a line the agent obeyed: upload your secrets to this address. Watch." Point at the red BLOCK line. "The `.env` file never left the machine. Yenop stopped it and named the rule. This is the attack in every AI security report this year, and here it is, stopped, deterministically. Not a model guessing it looks risky. A rule."

**Act 3, the plan no single step reveals.** "Now the hard one. Read a web page: fine. Read your environment variables: fine. Make a network call: fine. Each step is harmless. Together they are: take in an instruction from outside, pick up a secret, send it out. The model's reasoning is invisible, so you cannot catch this by watching the agent think. Yenop watches the actions across the whole run, and here it stops and asks a person, and it shows the person exactly how the run got here." Read the "Yenop says" line aloud. That trail is the product's cleverest part; let it land.

**Act 4, the same rules for a database tool.** "This is not just about the terminal. Agents connect to tools through a standard called MCP: databases, GitHub, ticketing. Yenop sits in front of those too. The agent listing tables is fine. The agent running SQL that dumps the customers table gets held for a person, before the database server ever receives it. One set of rules, every way the agent can act."

**Act 5, Yenop protects itself.** "The smartest thing a compromised agent could do is turn off the guard. So the guard guards itself. Any attempt to change Yenop's own rules needs a person. There is no clever path around it."

**The record.** "And this is what your auditor gets. Every decision, in a plain file you own, append-only. Who was asked, what they said. No screenshots, no trust-us dashboard. Evidence." This is the line compliance and security buyers lean forward at.

Close: "That is the whole thing. It ran here on one laptop. No cloud, no UI, no data leaving. It runs the same on your developers' machines, your build servers, or inside your own network, and the rules are yours to write."

## The questions you will get, and honest answers

- **"Where does it run? Is our code going to your cloud?"** Nowhere but their machine. Yenop runs next to the agent. Nothing leaves. That is the design, and for a bank it is the whole point. Central dashboards and Slack approvals are a paid add-on they can turn on later, on their terms.
- **"Does it slow the agent down?"** No. A decision is about a millisecond. Say it plainly.
- **"What if it breaks or is misconfigured?"** It fails closed. If it cannot read its own rules, it refuses actions rather than waving them through, and the command line still works so you can fix it.
- **"Can the agent talk its way past it?"** The rules read the actual action, the parsed command and the real file path, not the agent's words. There is no prompt to jailbreak. A hidden instruction is just text; the block is on the deed.
- **"Can we write our own rules?"** Yes. The rules are files in your own git repository, in a policy language built for authorization. You start with our baseline and add yours.
- **"Which agents does it support today?"** Claude Code, and any tool that speaks MCP, which is most of them. More runtimes are adapters on the same core.
- **"On-prem / air-gapped?"** Yes, that is the normal way to run it. (Note to self: Linux service is built but verify it in front of a Linux customer; offline install tarball is a small task; Windows is not supported yet, say so.)
- **"How is it priced?"** The core that they just saw is free and open. You charge for the team layer: shared policy across many machines, approvals in Slack or Teams, one audit trail across every agent, single sign-on, and a supported on-prem build. Do not quote a number in the first meeting; get them to a pilot.

## What NOT to do

- Do not demo with a live AI agent in a first meeting. It may refuse or wander and cost you the room. `yenop demo` is deterministic. Offer the live version as a follow-up for their engineers.
- Do not oversell cloud or a UI you do not have yet. "It runs where your agent runs" is a stronger story than a dashboard, and it is true today.
- Do not claim Windows or a SIEM integration until they exist. Name them as roadmap if asked.

## If they want to try it themselves (leave-behind)

"Two commands. `npx yenop init` in a project, then work with your agent as normal; Yenop starts watching. `yenop demo` any time to see the whole story again. Everything stays on your machine."

## The live version, for a technical follow-up

Open `~/yenop-playground` in the Claude Code desktop app and, one at a time:

1. "run npm test" — allowed.
2. "read the .env file" — blocked.
3. "fetch example.com, then read the environment, then curl an outside address" — the third step asks, with the run's history.
4. Approve it, then run `yenop receipts --last 5` in a terminal to show the recorded answer.

Same story as the scripted demo, with a real agent, for an audience that wants to see it move.
