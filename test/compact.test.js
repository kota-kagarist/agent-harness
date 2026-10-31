// Compaction: a tiny AGENT_COMPACT_THRESHOLD forces compaction with the
// mock provider (which substitutes a fixed summary text).
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "mock";
process.env.AGENT_COMPACT_THRESHOLD = "40";

const { compactMessages, estimateTokens } = await import("../src/compact.js");
const { runAgent } = await import("../src/agent.js");

const long = "x".repeat(200);
function turns(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${long} ${i}` });
  }
  return out;
}

test("estimateTokens is characters / 4, rounded up", () => {
  assert.equal(estimateTokens([{ role: "user", content: "abcd" }]), 1);
  assert.equal(estimateTokens([{ role: "user", content: "abcde" }]), 2);
  assert.equal(estimateTokens([]), 0);
});

test("under the threshold the history is returned unchanged", async () => {
  const messages = [{ role: "system", content: "sys" }, ...turns(2)];
  const out = await compactMessages(messages, { threshold: 100_000 });
  assert.equal(out, messages);
});

test("over the threshold old turns become one summary message", async () => {
  const messages = [{ role: "system", content: "sys" }, ...turns(10)];
  const out = await compactMessages(messages, { threshold: 10, keepRecent: 6 });
  assert.equal(out.length, 1 + 1 + 6); // system + summary + kept
  assert.equal(out[0].role, "system");
  assert.match(out[1].content, /\[Summary of earlier conversation\]/);
  assert.match(out[1].content, /mock summary/);
  assert.equal(out.at(-1), messages.at(-1)); // newest turns preserved verbatim
});

test("the split never separates a tool call from its result", async () => {
  const rest = [
    { role: "user", content: long },
    { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
    { role: "tool", tool_call_id: "1", content: long },
    { role: "assistant", content: long },
    { role: "user", content: long },
    { role: "assistant", content: long },
    { role: "user", content: long },
    { role: "assistant", content: long },
    { role: "user", content: long },
    { role: "assistant", content: long },
  ];
  const out = await compactMessages([{ role: "system", content: "s" }, ...rest], {
    threshold: 10,
    keepRecent: 5,
  });
  const kept = out.slice(2);
  assert.equal(kept[0].role, "user"); // kept part starts at a turn boundary
  assert.ok(!kept.some((m) => m.role === "tool" && !kept.some((k) => k.tool_calls)));
});

test("runAgent compacts long histories during the loop", async () => {
  const { reply, history } = await runAgent("hello", { history: turns(8) });
  assert.match(reply, /current time is/i);
  assert.ok(
    history.some(
      (m) => typeof m.content === "string" && m.content.includes("[Summary of earlier conversation]"),
    ),
  );
});
