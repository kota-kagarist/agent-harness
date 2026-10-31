// Minimal OpenAI-compatible chat completions client, plus a mock provider
// (LLM_MODEL=mock) that exercises the tool loop without any API key.
import { config } from "./config.js";

export async function chatCompletion(messages, tools) {
  if (config.model === "mock") return mockCompletion(messages);
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? "auto" : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// The mock plays a fixed script: first ask for the current time via a tool
// call, then answer using the tool result. Good for smoke tests and demos.
function mockCompletion(messages) {
  const hasToolResult = messages.some((m) => m.role === "tool");
  if (!hasToolResult) {
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
  const toolMsg = messages.find((m) => m.role === "tool");
  return {
    role: "assistant",
    content: `The current time is ${toolMsg.content} (via the get_current_time tool).`,
  };
}
