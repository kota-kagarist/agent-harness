// Anthropic provider: the pure converters translate between the internal
// OpenAI-shaped messages and the Messages API in both directions, and a
// stubbed fetch verifies the wire format (URL, headers, body, usage).
// The mock model must win over the provider setting. No network access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_MODEL = "claude-test";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_BASE_URL = "https://api.anthropic.com";

const {
  chatCompletion,
  chatCompletionStream,
  fromAnthropicResponse,
  getUsageTotals,
  resetUsageTotals,
  toAnthropicMessages,
  toAnthropicTools,
} = await import("../src/llm.js");

const INTERNAL = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "What time is it?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_current_time", arguments: "{}" },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.md"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "noon" },
  { role: "tool", tool_call_id: "call_2", content: "file body" },
];

test("system messages are lifted out of the message list", () => {
  const { system, messages } = toAnthropicMessages(INTERNAL);
  assert.equal(system, "You are helpful.");
  assert.ok(messages.every((m) => m.role !== "system"));
  assert.deepEqual(messages[0], {
    role: "user",
    content: [{ type: "text", text: "What time is it?" }],
  });
});

test("assistant tool_calls become tool_use blocks with parsed input", () => {
  const { messages } = toAnthropicMessages(INTERNAL);
  const assistant = messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.content, [
    { type: "tool_use", id: "call_1", name: "get_current_time", input: {} },
    { type: "tool_use", id: "call_2", name: "read_file", input: { path: "a.md" } },
  ]);
});

test("parallel tool results merge into a single user message", () => {
  const { messages } = toAnthropicMessages(INTERNAL);
  const toolResults = messages.filter(
    (m) => m.role === "user" && m.content[0]?.type === "tool_result",
  );
  assert.equal(toolResults.length, 1);
  assert.deepEqual(toolResults[0].content, [
    { type: "tool_result", tool_use_id: "call_1", content: "noon" },
    { type: "tool_result", tool_use_id: "call_2", content: "file body" },
  ]);
});

test("roundtrip: a converted reply feeds its tool result back by id", () => {
  const reply = fromAnthropicResponse({
    content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "b.md" } },
    ],
  });
  assert.equal(reply.content, "Checking.");
  assert.deepEqual(reply.tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"b.md"}' },
    },
  ]);
  const { messages } = toAnthropicMessages([
    { role: "user", content: "read b" },
    reply,
    { role: "tool", tool_call_id: "toolu_1", content: "bee" },
  ]);
  const last = messages[messages.length - 1];
  assert.deepEqual(last, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "bee" }],
  });
});

test("a text-only response converts to a plain assistant message", () => {
  const msg = fromAnthropicResponse({ content: [{ type: "text", text: "Done." }] });
  assert.equal(msg.content, "Done.");
  assert.equal(msg.tool_calls, undefined);
});

test("tool schemas become name/description/input_schema", () => {
  const tools = toAnthropicTools([
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.deepEqual(tools, [
    {
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
});

test("chatCompletion speaks the Messages API and records usage", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url, opts };
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Native hello." }],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    resetUsageTotals();
    const message = await chatCompletion(INTERNAL, [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    assert.equal(message.content, "Native hello.");
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.opts.headers["x-api-key"], "test-key");
    assert.equal(seen.opts.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.model, "claude-test");
    assert.equal(body.system, "You are helpful.");
    assert.ok(body.max_tokens > 0);
    assert.equal(body.tools[0].name, "read_file");
    assert.ok(body.tools[0].input_schema);
    assert.deepEqual(getUsageTotals(), { inputTokens: 12, outputTokens: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming falls back to a plain completion for anthropic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: "whole reply" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const tokens = [];
    const message = await chatCompletionStream(
      [{ role: "user", content: "hi" }],
      [],
      (t) => tokens.push(t),
    );
    assert.equal(message.content, "whole reply");
    assert.deepEqual(tokens, ["whole reply"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM_MODEL=mock takes priority over the anthropic provider", () => {
  const llmUrl = new URL("../src/llm.js", import.meta.url).href;
  const script = `
    const { chatCompletion } = await import(${JSON.stringify(llmUrl)});
    const m = await chatCompletion([{ role: "user", content: "What time is it?" }], []);
    console.log(JSON.stringify(m));
  `;
  // The base URL points at a dead port: if the mock did not win, the
  // call would attempt a real request and fail instead of answering.
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        LLM_MODEL: "mock",
        LLM_PROVIDER: "anthropic",
        LLM_BASE_URL: "http://127.0.0.1:1",
      },
      encoding: "utf8",
    },
  );
  const message = JSON.parse(out.trim());
  assert.equal(message.tool_calls[0].function.name, "get_current_time");
});
