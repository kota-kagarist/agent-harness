#!/usr/bin/env node
// CLI entry point.
//   node src/index.js                          interactive chat (streaming)
//   node src/index.js --once "..."             one-shot prompt (no approval prompts)
//   node src/index.js --session <id>           resume/save history in
//                                              workspace/sessions/<id>.json
//   node src/index.js --outbox                 list undelivered notifications
//   node src/index.js --goals                  list goals (no LLM needed)
//   node src/index.js --doctor                 environment self-check (no LLM needed)
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { assertConfigured } from "./config.js";
import { runDoctor } from "./doctor.js";
import { listGoals } from "./goals.js";
import { closeMcp } from "./mcp.js";
import { listUndelivered, markDelivered } from "./outbox.js";
import { endSessionNote, loadSession, saveSession } from "./session.js";

function parseArgs(argv) {
  let sessionId = null;
  let showOutbox = false;
  let showGoals = false;
  let showDoctor = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      sessionId = argv[++i] ?? null;
    } else if (argv[i] === "--outbox") {
      showOutbox = true;
    } else if (argv[i] === "--goals") {
      showGoals = true;
    } else if (argv[i] === "--doctor") {
      showDoctor = true;
    } else {
      rest.push(argv[i]);
    }
  }
  return { sessionId, rest, showOutbox, showGoals, showDoctor };
}

function formatNotification(n) {
  return `[${n.createdAt}] (${n.source}) ${n.text}`;
}

// Record the session summary in today's memory note. A failure here must
// never lose the conversation itself, so it is reported, not thrown.
async function writeSessionNote(history) {
  try {
    await endSessionNote(history);
  } catch (err) {
    console.error(`session note: ${err.message}`);
  }
}

async function main() {
  const { sessionId, rest, showOutbox, showGoals, showDoctor } =
    parseArgs(process.argv.slice(2));

  // Peeking at the outbox needs no LLM configuration.
  if (showOutbox) {
    const pending = await listUndelivered();
    if (!pending.length) console.log("No undelivered notifications.");
    for (const n of pending) console.log(formatNotification(n));
    return;
  }

  // Listing goals needs no LLM configuration either.
  if (showGoals) {
    const goals = listGoals();
    if (!goals.length) console.log("No goals yet.");
    for (const g of goals) {
      console.log(`- ${g.slug} [${g.status}] ${g.title} (created ${g.created})`);
    }
    return;
  }

  // The self-check reports configuration problems itself, so it must run
  // before assertConfigured() would throw on them.
  if (showDoctor) {
    const { ok } = await runDoctor();
    if (!ok) process.exitCode = 1;
    return;
  }

  assertConfigured();

  if (rest[0] === "--once") {
    const prompt = rest.slice(1).join(" ");
    if (!prompt) throw new Error('Usage: --once "<prompt>"');
    const history = sessionId ? await loadSession(sessionId) : [];
    const { reply, history: next } = await runAgent(prompt, { history });
    if (sessionId) {
      await saveSession(sessionId, next);
      await writeSessionNote(next);
    }
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
  // rl.question() can hang forever when piped stdin reaches EOF while a
  // question is pending — the interface closes without ever settling the
  // promise, and the process then exits silently, skipping the
  // end-of-session note. Race every question against the interface
  // closing; null means "input is gone".
  const askLine = (prompt) =>
    new Promise((resolve) => {
      const onClose = () => resolve(null);
      rl.once("close", onClose);
      rl.question(prompt).then(
        (line) => {
          rl.removeListener("close", onClose);
          resolve(line);
        },
        () => {
          rl.removeListener("close", onClose);
          resolve(null);
        },
      );
    });
  const ask = async (tool, toolArgs) => {
    const answer = await askLine(
      `\n[approval] Run ${tool.name} with ${JSON.stringify(toolArgs)}? [y/N] `,
    );
    return answer?.trim().toLowerCase() === "y";
  };

  console.log("agent-harness — type 'exit' to quit.");
  let history = sessionId ? await loadSession(sessionId) : [];
  if (sessionId && history.length) {
    console.log(`(resumed session "${sessionId}": ${history.length} message(s))`);
  }
  for (;;) {
    const line = await askLine("\nyou> ");
    if (line === null) break; // stdin closed (piped input ended) — treat as exit
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
  await writeSessionNote(history);
  closeMcp();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
