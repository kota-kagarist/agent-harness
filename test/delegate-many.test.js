// Parallel delegation: delegate_many fans tasks out to sub-agents and
// joins their answers as a numbered list. The mock provider answers each
// child task through the get_current_time tool, so parallelism, ordering
// and the cap are observable without an API key.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "mock";

const { findTool, toolSchemas } = await import("../src/tools.js");
const { runSubagents } = await import("../src/subagent.js");

const delegateMany = findTool("delegate_many");
const timeAnswers = (text) => (text.match(/The current time is/g) ?? []).length;

test("delegate_many runs tasks and joins numbered results in order", async () => {
  const result = await delegateMany.run(
    { tasks: ["first task", "second task", "third task"] },
    { depth: 0, ask: null },
  );
  assert.equal(timeAnswers(result), 3);
  assert.match(result, /^1\. first task\n/);
  assert.match(result, /\n\n2\. second task\n/);
  assert.match(result, /\n\n3\. third task\n/);
});

test("delegate_many caps the batch at 5 tasks", async () => {
  const tasks = Array.from({ length: 7 }, (_, i) => `task ${i + 1}`);
  const result = await delegateMany.run({ tasks }, { depth: 0, ask: null });
  assert.equal(timeAnswers(result), 5);
  assert.match(result, /5\. task 5/);
  assert.doesNotMatch(result, /6\. task 6/);
});

test("delegate_many rejects an empty task list", async () => {
  const result = await delegateMany.run({ tasks: [] }, { depth: 0, ask: null });
  assert.match(result, /at least one task/);
});

test("delegate_many is not available inside a sub-agent", async () => {
  const result = await delegateMany.run({ tasks: ["x"] }, { depth: 1, ask: null });
  assert.match(result, /not available inside a sub-agent/);
});

test("runSubagents returns one numbered section per task", async () => {
  const result = await runSubagents(["alpha", "beta"], { ask: null });
  assert.match(result, /^1\. alpha\n/);
  assert.match(result, /\n\n2\. beta\n/);
});

test("schemas hide both delegate tools from sub-agents", () => {
  const all = toolSchemas().map((s) => s.function.name);
  assert.ok(all.includes("delegate"));
  assert.ok(all.includes("delegate_many"));
  const child = toolSchemas(["delegate", "delegate_many"]).map((s) => s.function.name);
  assert.ok(!child.includes("delegate"));
  assert.ok(!child.includes("delegate_many"));
});
