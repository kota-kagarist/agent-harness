#!/usr/bin/env node
// CLI entry point.
//   node src/index.js                          interactive chat (streaming)
//   node src/index.js --once "..."             one-shot prompt (no approval prompts)
//   node src/index.js --session <id>           resume/save history in
//                                              workspace/sessions/<id>.json
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { assertConfigured } from "./config.js";
import { loadSession, saveSession } from "./session.js";

function parseArgs(argv) {
  let sessionId = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      sessionId = argv[++i] ?? null;
    } else {
      rest.push(argv[i]);
    }
  }
  return { sessionId, rest };
}

async function main() {
  assertConfigured();
  const { sessionId, rest } = parseArgs(process.argv.slice(2));

  if (rest[0] === "--once") {
    const prompt = rest.slice(1).join(" ");
    if (!prompt) throw new Error('Usage: --once "<prompt>"');
    const history = sessionId ? await loadSession(sessionId) : [];
    const { reply, history: next } = await runAgent(prompt, { history });
    if (sessionId) await saveSession(sessionId, next);
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
  let history = sessionId ? await loadSession(sessionId) : [];
  if (sessionId && history.length) {
    console.log(`(resumed session "${sessionId}": ${history.length} message(s))`);
  }
  for (;;) {
    const line = await rl.question("\nyou> ");
    if (line.trim() === "exit") break;
    if (!line.trim()) continue;
    let streamed = false;
    process.stdout.write("\nagent> ");
    const { reply, history: next } = await runAgent(line, {
      history,
      ask,
      stream: true,
      onToken: (chunk) => {
        streamed = true;
        process.stdout.write(chunk);
      },
      onEvent: (e) => console.log(`  [tool] ${e.name} (${e.approved ? "approved" : "denied"})`),
    });
    history = next;
    if (sessionId) await saveSession(sessionId, history);
    // If the reply was already streamed token by token, don't print it twice.
    console.log(streamed ? "" : reply);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
