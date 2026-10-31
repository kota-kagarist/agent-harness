// Streaming: a stubbed global fetch serves canned SSE / JSON responses,
// so the SSE assembler and the agent's stream->non-stream fallback are
// tested without any network access.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "fake-model";
process.env.LLM_API_KEY = "test-key";

const { chatCompletionStream } = await import("../src/llm.js");
const { runAgent } = await import("../src/agent.js");

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("streamed content and tool_calls deltas are assembled", async () => {
  const line1 = 'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n';
  const line2 = 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n';
  const line3 =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_current_time","arguments":""}}]}}]}\n\n';
  const line4 =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n';
  // Split one SSE line across two network chunks to exercise buffering.
  const half = Math.floor(line3.length / 2);
  globalThis.fetch = async () =>
    sseResponse([line1, line2, line3.slice(0, half), line3.slice(half), line4, "data: [DONE]\n\n"]);

  const tokens = [];
  const message = await chatCompletionStream([{ role: "user", content: "hi" }], [], (t) =>
    tokens.push(t),
  );
  assert.equal(tokens.join(""), "Hello");
  assert.equal(message.content, "Hello");
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].id, "call_1");
  assert.equal(message.tool_calls[0].function.name, "get_current_time");
  assert.equal(message.tool_calls[0].function.arguments, "{}");
});

test("runAgent falls back to a plain completion when streaming fails", async () => {
  globalThis.fetch = async (_url, opts) => {
    if (String(opts.body).includes('"stream":true')) {
      throw new Error("streaming unsupported");
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "fallback answer" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { reply } = await runAgent("hi", { stream: true });
  assert.equal(reply, "fallback answer");
});
