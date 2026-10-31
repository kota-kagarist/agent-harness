// Minimal OpenAI-compatible chat completions client, plus a mock provider
// (LLM_MODEL=mock) that exercises the tool loop without any API key.
// chatCompletionStream speaks SSE and assembles streamed deltas (including
// tool_calls) back into the same message shape chatCompletion returns.
import { config } from "./config.js";

function completionBody(messages, tools, stream) {
  return JSON.stringify({
    model: config.model,
    messages,
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? "auto" : undefined,
    stream: stream || undefined,
  });
}

export async function chatCompletion(messages, tools) {
  if (config.model === "mock") return mockCompletion(messages);
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
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
  return data.choices[0].message;
}

// Streaming variant: onToken is called with each text chunk as it arrives.
// The mock provider stays non-streaming (it returns its message at once).
export async function chatCompletionStream(messages, tools, onToken = () => {}) {
  if (config.model === "mock") return mockCompletion(messages);
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
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
      const delta = JSON.parse(payload).choices?.[0]?.delta ?? {};
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
