#!/usr/bin/env node
// CLI entry point.
//   node src/index.js                          interactive chat (streaming,
//                                              slash commands — see /help)
//   node src/index.js --once "..."             one-shot prompt (no approval prompts)
//   node src/index.js --session <id>           resume/save history in
//                                              workspace/sessions/<id>.json
//   node src/index.js --outbox                 list undelivered notifications
//   node src/index.js --goals                  list goals (no LLM needed)
//   node src/index.js --permissions            list saved allow/deny rules
//                                              (no LLM needed)
//   node src/index.js --doctor                 environment self-check (no LLM needed)
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { commandHelp, parseCommand } from "./commands.js";
import { compactMessages } from "./compact.js";
import { assertConfigured, config } from "./config.js";
import { runDoctor } from "./doctor.js";
import { listGoals } from "./goals.js";
import { getUsageTotals } from "./llm.js";
import { closeMcp } from "./mcp.js";
import { buildSystemPrompt } from "./memory.js";
import { listUndelivered, markDelivered } from "./outbox.js";
import { loadPermissions, savePermission } from "./permissions.js";
import { endSessionNote, loadSession, saveSession } from "./session.js";

function parseArgs(argv) {
  let sessionId = null;
  let showOutbox = false;
  let showGoals = false;
  let showPermissions = false;
  let showDoctor = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      sessionId = argv[++i] ?? null;
    } else if (argv[i] === "--outbox") {
      showOutbox = true;
    } else if (argv[i] === "--goals") {
      showGoals = true;
    } else if (argv[i] === "--permissions") {
      showPermissions = true;
    } else if (argv[i] === "--doctor") {
      showDoctor = true;
    } else {
      rest.push(argv[i]);
    }
  }
  return { sessionId, rest, showOutbox, showGoals, showPermissions, showDoctor };
}

function formatNotification(n) {
  return `[${n.createdAt}] (${n.source}) ${n.text}`;
}

function printGoals() {
  const goals = listGoals();
  if (!goals.length) console.log("No goals yet.");
  for (const g of goals) {
    console.log(`- ${g.slug} [${g.status}] ${g.title} (created ${g.created})`);
  }
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
  const { sessionId, rest, showOutbox, showGoals, showPermissions, showDoctor } =
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
    printGoals();
    return;
  }

  // Neither does inspecting the saved permission rules.
  if (showPermissions) {
    const rules = loadPermissions();
    console.log("Saved permissions (workspace/permissions.json):");
    console.log(`  allow: ${rules.allow.length ? rules.allow.join(", ") : "(none)"}`);
    console.log(`  deny:  ${rules.deny.length ? rules.deny.join(", ") : "(none)"}`);
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
  // Lines are consumed from our own queue fed by readline's "line"
  // events, for two reasons:
  //  - rl.question() can hang forever when piped stdin reaches EOF while
  //    a question is pending — the interface closes without settling the
  //    promise and the process exits silently, skipping the
  //    end-of-session note. Here, close resolves any waiter with null
  //    ("input is gone") instead.
  //  - Lines piped in one chunk are emitted while no question is
  //    pending and would otherwise be discarded; the queue keeps them
  //    in order for the next prompt.
  const lineQueue = [];
  let lineWaiter = null;
  let inputClosed = false;
  rl.on("line", (line) => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    inputClosed = true;
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve(null);
    }
  });
  const askLine = (prompt) => {
    process.stdout.write(prompt);
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      lineWaiter = resolve;
    });
  };
  const ask = async (tool, toolArgs) => {
    const answer = await askLine(
      `\n[approval] Run ${tool.name} with ${JSON.stringify(toolArgs)}? [y/N/a=always allow] `,
    );
    const a = answer?.trim().toLowerCase();
    if (a === "a") {
      // Persist the decision: this tool stops asking from now on.
      savePermission(tool.name, "allow");
      console.log(`  (saved: ${tool.name} is always allowed — change it in workspace/permissions.json)`);
      return true;
    }
    return a === "y";
  };

  console.log("agent-harness — type 'exit' to quit, /help for commands.");
  let history = sessionId ? await loadSession(sessionId) : [];
  if (sessionId && history.length) {
    console.log(`(resumed session "${sessionId}": ${history.length} message(s))`);
  }

  // Slash commands are handled by the harness, never sent to the model.
  // Returns true when the line was a command (handled or not).
  const runCommand = async (cmd) => {
    switch (cmd.name) {
      case "help":
        console.log(commandHelp());
        return true;
      case "exit":
        return "exit";
      case "clear":
        history = [];
        if (sessionId) await saveSession(sessionId, history);
        console.log("(history cleared)");
        return true;
      case "compact": {
        const before = history.length;
        const compacted = await compactMessages(
          [{ role: "system", content: buildSystemPrompt() }, ...history],
          { threshold: 0 },
        );
        history = compacted.slice(1); // drop the system message again
        if (sessionId) await saveSession(sessionId, history);
        console.log(
          history.length < before
            ? `(compacted: ${before} -> ${history.length} message(s))`
            : "(nothing to compact yet)",
        );
        return true;
      }
      case "model":
        console.log(
          `Provider: ${config.provider} / model: ${config.model || "(unset)"} / endpoint: ${config.baseUrl}`,
        );
        return true;
      case "outbox":
        await showPending();
        return true;
      case "goals":
        printGoals();
        return true;
      default:
        console.log(`Unknown command: /${cmd.command} — try /help.`);
        return true;
    }
  };

  for (;;) {
    const line = await askLine("\nyou> ");
    if (line === null) break; // stdin closed (piped input ended) — treat as exit
    if (line.trim() === "exit") break;
    if (!line.trim()) continue;
    const cmd = parseCommand(line);
    if (cmd) {
      if ((await runCommand(cmd)) === "exit") break;
      continue;
    }
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
    const totals = getUsageTotals();
    if (totals.inputTokens > 0 || totals.outputTokens > 0) {
      console.log(`  [tokens in/out cumulative: ${totals.inputTokens} / ${totals.outputTokens}]`);
    }
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
