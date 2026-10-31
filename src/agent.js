// The agent loop: send messages + tool schemas to the model, execute the
// tool calls it asks for (through the approval gate), feed results back,
// and repeat until the model answers with plain text.
// Options:
//   history      prior non-system messages (the session so far)
//   ask          approval callback (null = unattended rules)
//   onEvent      called with { type: "tool", name, approved } per tool call
//   depth        0 at the top level, 1 inside a sub-agent
//   excludeTools tool names hidden from the model (sub-agents lose delegate)
//   stream       stream the model's text via onToken, falling back to a
//                plain completion if streaming fails
import { checkApproval } from "./approval.js";
import { compactMessages } from "./compact.js";
import { chatCompletion, chatCompletionStream } from "./llm.js";
import { ensureMcpConnected } from "./mcp.js";
import { buildSystemPrompt } from "./memory.js";
import { findTool, toolSchemas } from "./tools.js";

const MAX_STEPS = 20;

export async function runAgent(
  userText,
  {
    history = [],
    ask = null,
    onEvent = () => {},
    depth = 0,
    excludeTools = [],
    stream = false,
    onToken = () => {},
  } = {},
) {
  let messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];
  // Connect MCP servers (if any are configured) so their tools are part of
  // the schema list. A no-op when workspace/connectors.json is absent.
  await ensureMcpConnected();
  const schemas = toolSchemas(excludeTools);

  for (let step = 0; step < MAX_STEPS; step++) {
    messages = await compactMessages(messages);

    let message;
    if (stream) {
      try {
        message = await chatCompletionStream(messages, schemas, onToken);
      } catch {
        message = await chatCompletion(messages, schemas);
      }
    } else {
      message = await chatCompletion(messages, schemas);
    }
    messages.push(message);

    if (!message.tool_calls?.length) {
      const reply = message.content ?? "";
      return { reply, history: messages.slice(1) }; // keep non-system history for the session
    }

    for (const call of message.tool_calls) {
      const tool = excludeTools.includes(call.function.name)
        ? undefined
        : findTool(call.function.name);
      let result;
      if (!tool) {
        result = `Error: unknown tool ${call.function.name}`;
      } else {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          result = "Error: tool arguments were not valid JSON";
        }
        if (result === undefined) {
          const approved = await checkApproval(tool, args, ask);
          onEvent({ type: "tool", name: tool.name, approved });
          if (!approved) {
            result = "Denied: the user did not approve this action.";
          } else {
            try {
              result = String(await tool.run(args, { ask, depth }));
            } catch (err) {
              result = `Error: ${err.message}`;
            }
          }
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { reply: "(stopped: too many tool steps)", history: messages.slice(1) };
}
