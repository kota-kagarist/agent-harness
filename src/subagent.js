// Sub-agent delegation: run a self-contained task in a fresh conversation
// and return only the final answer text, so the parent agent's context
// stays focused on its own task. Nesting is capped at depth 1 — the child
// runs without the delegate tool, so it cannot spawn further sub-agents.
// The approval gate is inherited from the parent (same `ask` callback, or
// the same unattended rules when there is none).
import { runAgent } from "./agent.js";

export async function runSubagent(task, { ask = null, depth = 1 } = {}) {
  const { reply } = await runAgent(task, {
    history: [],
    ask,
    depth,
    excludeTools: ["delegate"],
  });
  return reply;
}
