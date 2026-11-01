// Sub-agent delegation: run a self-contained task in a fresh conversation
// and return only the final answer text, so the parent agent's context
// stays focused on its own task. Nesting is capped at depth 1 — the child
// runs without the delegate tools, so it cannot spawn further sub-agents.
// The approval gate is inherited from the parent (same `ask` callback, or
// the same unattended rules when there is none).
import { runAgent } from "./agent.js";

// Tools a sub-agent never sees: delegating further would nest depth.
const CHILD_EXCLUDED = ["delegate", "delegate_many"];

export async function runSubagent(task, { ask = null, depth = 1 } = {}) {
  const { reply } = await runAgent(task, {
    history: [],
    ask,
    depth,
    excludeTools: CHILD_EXCLUDED,
  });
  return reply;
}

// Run several tasks concurrently and join the answers as a numbered
// list — one section per task, in the order the tasks were given.
export async function runSubagents(tasks, { ask = null, depth = 1 } = {}) {
  const replies = await Promise.all(
    tasks.map((task) => runSubagent(task, { ask, depth })),
  );
  return replies
    .map((reply, i) => `${i + 1}. ${tasks[i]}\n${reply}`)
    .join("\n\n");
}
