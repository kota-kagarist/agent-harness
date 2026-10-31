// Sub-agent delegation: the mock provider calls the delegate tool when a
// user message contains "DELEGATE: <task>". The child runs the task with a
// fresh history and only its final text comes back.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "mock";

const { runAgent } = await import("../src/agent.js");
const { toolSchemas } = await import("../src/tools.js");
const { runSubagent } = await import("../src/subagent.js");

test("delegate runs the task in a sub-agent and returns its answer", async () => {
  const { reply } = await runAgent("Please DELEGATE: What time is it?");
  assert.match(reply, /Delegated result: The current time is/);
});

test("runSubagent returns only the child's final text", async () => {
  const reply = await runSubagent("What time is it?");
  assert.match(reply, /The current time is/);
});

test("sub-agents cannot delegate further (nesting capped at depth 1)", async () => {
  // The child's mock still asks for delegate, but the tool is excluded from
  // the child's loop, so the run terminates with an error tool result
  // instead of recursing forever.
  const { reply } = await runAgent("DELEGATE: DELEGATE: What time is it?");
  assert.match(reply, /unknown tool delegate/);
});

test("toolSchemas can exclude delegate", () => {
  const all = toolSchemas().map((s) => s.function.name);
  assert.ok(all.includes("delegate"));
  const child = toolSchemas(["delegate"]).map((s) => s.function.name);
  assert.ok(!child.includes("delegate"));
});
