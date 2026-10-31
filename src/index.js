#!/usr/bin/env node
// CLI entry point.
//   node src/index.js                interactive chat
//   node src/index.js --once "..."   one-shot prompt (no approval prompts)
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { assertConfigured } from "./config.js";

async function main() {
  assertConfigured();
  const args = process.argv.slice(2);

  if (args[0] === "--once") {
    const prompt = args.slice(1).join(" ");
    if (!prompt) throw new Error('Usage: --once "<prompt>"');
    const { reply } = await runAgent(prompt);
    console.log(reply);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (tool, toolArgs) => {
    const answer = await rl.question(
      `\n[approval] Run ${tool.name} with ${JSON.stringify(toolArgs)}? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y";
  };

  console.log("agent-harness — type 'exit' to quit.");
  let history = [];
  for (;;) {
    const line = await rl.question("\nyou> ");
    if (line.trim() === "exit") break;
    if (!line.trim()) continue;
    const { reply, history: next } = await runAgent(line, {
      history,
      ask,
      onEvent: (e) => console.log(`  [tool] ${e.name} (${e.approved ? "approved" : "denied"})`),
    });
    history = next;
    console.log(`\nagent> ${reply}`);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
