// LLM robustness: fetchWithRetry retries transient failures (429, 5xx,
// network TypeErrors) with backoff — the sleep is injected so tests run
// instantly — leaves other errors alone, and reported token usage
// accumulates across calls. A stubbed fetch serves every response.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "fake-model";
process.env.LLM_API_KEY = "test-key";

const { chatCompletion, getUsageTotals, resetUsageTotals, setSleep } =
  await import("../src/llm.js");

const originalFetch = globalThis.fetch;
setSleep(() => Promise.resolve());

function jsonMessage(usage) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(handler) {
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls++;
    return handler(calls, ...args);
  };
  return () => calls;
}

test("a 429 is retried and the eventual success is returned", async () => {
  resetUsageTotals();
  const calls = stubFetch((n) =>
    n === 1 ? new Response("slow down", { status: 429 }) : jsonMessage(),
  );
  try {
    const message = await chatCompletion([{ role: "user", content: "hi" }], []);
    assert.equal(message.content, "ok");
    assert.equal(calls(), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("5xx and network errors are retried too", async () => {
  const calls = stubFetch((n) => {
    if (n === 1) return new Response("boom", { status: 503 });
    if (n === 2) throw new TypeError("fetch failed");
    return jsonMessage();
  });
  try {
    const message = await chatCompletion([{ role: "user", content: "hi" }], []);
    assert.equal(message.content, "ok");
    assert.equal(calls(), 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 400 is not retried and keeps the old error format", async () => {
  const calls = stubFetch(() => new Response("bad request", { status: 400 }));
  try {
    await assert.rejects(
      chatCompletion([{ role: "user", content: "hi" }], []),
      /LLM request failed: 400 bad request/,
    );
    assert.equal(calls(), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistent 429s give up after the retry budget", async () => {
  const calls = stubFetch(() => new Response("slow down", { status: 429 }));
  try {
    await assert.rejects(
      chatCompletion([{ role: "user", content: "hi" }], []),
      /LLM request failed: 429/,
    );
    assert.equal(calls(), 4); // 1 initial attempt + 3 retries
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reported usage accumulates across completions", async () => {
  resetUsageTotals();
  stubFetch(() => jsonMessage({ prompt_tokens: 10, completion_tokens: 4 }));
  try {
    await chatCompletion([{ role: "user", content: "a" }], []);
    await chatCompletion([{ role: "user", content: "b" }], []);
    assert.deepEqual(getUsageTotals(), { inputTokens: 20, outputTokens: 8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
