// Smoke test: the mock provider drives a full loop (tool call -> result ->
// final answer) without any API key or network access.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "mock";

const { runAgent } = await import("../src/agent.js");

test("mock provider completes a tool loop", async () => {
  const { reply } = await runAgent("What time is it?");
  assert.match(reply, /current time is/i);
});

test("gated tools are denied when unattended and not allowed", async () => {
  const { checkApproval } = await import("../src/approval.js");
  const fakeTool = { name: "write_file", requiresApproval: true };
  assert.equal(await checkApproval(fakeTool, {}, null), false);
});
