#!/usr/bin/env node
// CLI entry point.
//   node src/index.js                          interactive chat (streaming)
//   node src/index.js --once "..."             one-shot prompt (no approval prompts)
//   node src/index.js --session <id>           resume/save history in
//                                              workspace/sessions/<id>.json
//   node src/index.js --outbox                 list undelivered notifications
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { assertConfigured } from "./config.js";
import { closeMcp } from "./mcp.js";
import { listUndelivered, markDelivered } from "./outbox.js";
import { loadSession, saveSession } from "./session.js";

function parseArgs(argv) {
  let sessionId = null;
  let showOutbox = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      sessionId = argv[++i] ?? null;
    } else if (argv[i] === "--outbox") {
      showOutbox = true;
    } else {
      rest.push(argv[i]);
    }
  }
  return { sessionId, rest, showOutbox };
}

function formatNotification(n) {
  return `[${n.createdAt}] (${n.source}) ${n.text}`;
}

async function main() {
  const { sessionId, rest, showOutbox } = parseArgs(process.argv.slice(2));

  // Peeking at the outbox needs no LLM configuration.
  if (showOutbox) {
    const pending = await listUndelivered();
    if (!pending.length) console.log("No undelivered notifications.");
    for (const n of pending) console.log(formatNotification(n));
    return;
  }

  assertConfigured();

  if (rest[0] === "--once") {
    const prompt = rest.slice(1).join(" ");
    if (!prompt) throw new Error('Usage: --once "<prompt>"');
    const history = sessionId ? await loadSession(sessionId) : [];
    const { reply, history: next } = await runAgent(prompt, { history });
    if (sessionId) await saveSession(sessionId, next);
    closeMcp();
    console.log(reply);
    return;
  }

  // Show queued notifications (from jobs / the notify tool) and mark them
  // delivered. Runs at startup and after every turn. The startup call
  // happens before readline opens, so piped stdin is not consumed early.
  const showPending = async () => {
    const pending = await listUndelivered();
    if (!pending.length) return;
    console.log("\n--- notifications ---");
    for (const n of pending) console.log(formatNotification(n));
    await markDelivered(pending.map((n) => n.id));
  };
  await showPending();

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
    let line;
    try {
      line = await rl.question("\nyou> ");
    } catch {
      break; // stdin closed (piped input ended) — treat as exit
    }
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
    await showPending();
  }
  rl.close();
  closeMcp();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
