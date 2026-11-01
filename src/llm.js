// LLM clients for two providers, plus a mock (LLM_MODEL=mock) that
// exercises the tool loop without any API key:
//   - "openai"    (default) any OpenAI-compatible chat completions API;
//                 chatCompletionStream speaks SSE and assembles streamed
//                 deltas (including tool_calls) into one message.
//   - "anthropic" the Claude Messages API, via the pure converters below
//                 (toAnthropicMessages / toAnthropicTools /
//                 fromAnthropicResponse). Streaming falls back to a plain
//                 completion for this provider.
// Real requests go through fetchWithRetry (exponential backoff on 429 /
// 5xx / network errors). Reported token usage accumulates in module
// state — see getUsageTotals(). The mock never records usage.
import { config } from "./config.js";

// ---------------------------------------------------------------- retry

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

let sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tests inject a no-op sleep so retry cases run instantly.
export function setSleep(fn) {
  sleepImpl =
    fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function backoffMs(attempt) {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

// fetch with retries. Only transient failures are retried: HTTP 429, any
// 5xx, and network errors (fetch rejects with a TypeError). Other
// statuses are returned to the caller, which reports them as before.
export async function fetchWithRetry(url, opts, { retries = MAX_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      if (attempt < retries && err instanceof TypeError) {
        await sleepImpl(backoffMs(attempt));
        continue;
      }
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await res.text().catch(() => {}); // drain before reusing the socket
      await sleepImpl(backoffMs(attempt));
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------- usage

const usageTotals = { inputTokens: 0, outputTokens: 0 };

// Accepts either naming: OpenAI { prompt_tokens, completion_tokens } or
// Anthropic { input_tokens, output_tokens }.
export function recordUsage(usage) {
  if (!usage) return;
  usageTotals.inputTokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
  usageTotals.outputTokens +=
    usage.completion_tokens ?? usage.output_tokens ?? 0;
}

export function getUsageTotals() {
  return { ...usageTotals };
}

export function resetUsageTotals() {
  usageTotals.inputTokens = 0;
  usageTotals.outputTokens = 0;
}

// ---------------------------------------------------------------- OpenAI

function completionBody(messages, tools, stream) {
  return JSON.stringify({
    model: config.model,
    messages,
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? "auto" : undefined,
    stream: stream || undefined,
  });
}

async function openAiCompletion(messages, tools) {
  const res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: completionBody(messages, tools, false),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  recordUsage(data.usage);
  return data.choices[0].message;
}

// ------------------------------------------------------------- Anthropic

const ANTHROPIC_VERSION = "2023-06-01";
// The Messages API requires an explicit output cap.
const ANTHROPIC_MAX_TOKENS = 4096;

// Convert internal (OpenAI-shaped) messages to the Messages API shape.
// System messages are lifted out into the returned `system` string; tool
// results become tool_result blocks inside a user message. Consecutive
// same-role messages are merged (parallel tool results arrive as several
// tool messages in a row and must land in a single user message).
export function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  const push = (msg) => {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) last.content.push(...msg.content);
    else out.push(msg);
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) systemParts.push(m.content);
    } else if (m.role === "user") {
      push({ role: "user", content: [{ type: "text", text: String(m.content ?? "") }] });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (typeof m.content === "string" && m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      if (!blocks.length) blocks.push({ type: "text", text: "" });
      push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") },
        ],
      });
    }
  }
  return { system: systemParts.join("\n\n") || undefined, messages: out };
}

// Internal tool schemas are OpenAI-shaped; the Messages API wants
// { name, description, input_schema }.
export function toAnthropicTools(tools) {
  return (tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

// Convert a Messages API response back to the internal message shape.
export function fromAnthropicResponse(data) {
  const texts = [];
  const toolCalls = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message = {
    role: "assistant",
    content: toolCalls.length ? texts.join("") || null : texts.join(""),
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

async function anthropicCompletion(messages, tools) {
  const { system, messages: converted } = toAnthropicMessages(messages);
  const body = {
    model: config.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system,
    messages: converted,
  };
  if (tools?.length) body.tools = toAnthropicTools(tools);
  const res = await fetchWithRetry(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  recordUsage(data.usage);
  return fromAnthropicResponse(data);
}

// -------------------------------------------------------------- dispatch

export async function chatCompletion(messages, tools) {
  if (config.model === "mock") return mockCompletion(messages);
  return config.provider === "anthropic"
    ? anthropicCompletion(messages, tools)
    : openAiCompletion(messages, tools);
}

// Streaming variant: onToken is called with each text chunk as it arrives.
// The mock provider stays non-streaming (it returns its message at once),
// and so does the Anthropic provider — its full reply is emitted through
// onToken in one chunk once the completion returns.
export async function chatCompletionStream(messages, tools, onToken = () => {}) {
  if (config.model === "mock") return mockCompletion(messages);
  if (config.provider === "anthropic") {
    const message = await anthropicCompletion(messages, tools);
    if (typeof message.content === "string" && message.content) {
      onToken(message.content);
    }
    return message;
  }
  const res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: completionBody(messages, tools, true),
  });
  if (!res.ok || !res.body) {
    throw new Error(`LLM stream request failed: ${res.status}`);
  }

  let content = "";
  const toolCalls = new Map(); // delta index -> assembled tool call
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the partial trailing line for the next chunk
    for (const line of lines) {
      const data = line.trim();
      if (!data.startsWith("data:")) continue;
      const payload = data.slice("data:".length).trim();
      if (payload === "[DONE]") break;
      const parsed = JSON.parse(payload);
      if (parsed.usage) recordUsage(parsed.usage);
      const delta = parsed.choices?.[0]?.delta ?? {};
      if (delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const tc = toolCalls.get(part.index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id) tc.id = part.id;
        if (part.type) tc.type = part.type;
        if (part.function?.name) tc.function.name += part.function.name;
        if (part.function?.arguments) tc.function.arguments += part.function.arguments;
        toolCalls.set(part.index, tc);
      }
    }
  }

  const message = { role: "assistant", content: content || null };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);
  } else {
    message.content = content;
  }
  return message;
}

// The mock plays a fixed script: first ask for a tool call, then answer
// using the tool result. A user message containing "DELEGATE: <task>" makes
// it call the delegate tool instead of get_current_time, so sub-agent runs
// can be smoke-tested without an API key.
function mockCompletion(messages) {
  const hasToolResult = messages.some((m) => m.role === "tool");
  if (!hasToolResult) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const match = (lastUser?.content ?? "").match(/DELEGATE:\s*([\s\S]+)/);
    if (match) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "mock-call-1",
            type: "function",
            function: {
              name: "delegate",
              arguments: JSON.stringify({ task: match[1].trim() }),
            },
          },
        ],
      };
    }
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "mock-call-1",
          type: "function",
          function: { name: "get_current_time", arguments: "{}" },
        },
      ],
    };
  }
  const toolMsg = [...messages].reverse().find((m) => m.role === "tool");
  const assistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.tool_calls?.length);
  const toolName = assistant?.tool_calls?.[0]?.function?.name;
  if (toolName === "delegate") {
    return { role: "assistant", content: `Delegated result: ${toolMsg.content}` };
  }
  return {
    role: "assistant",
    content: `The current time is ${toolMsg.content} (via the get_current_time tool).`,
  };
}
