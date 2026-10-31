// The agent loop: send messages + tool schemas to the model, execute the
// tool calls it asks for (through the approval gate), feed results back,
// and repeat until the model answers with plain text.
import { checkApproval } from "./approval.js";
import { chatCompletion } from "./llm.js";
import { buildSystemPrompt } from "./memory.js";
import { findTool, toolSchemas } from "./tools.js";

const MAX_STEPS = 20;

export async function runAgent(userText, { history = [], ask = null, onEvent = () => {} } = {}) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const message = await chatCompletion(messages, toolSchemas());
    messages.push(message);

    if (!message.tool_calls?.length) {
      const reply = message.content ?? "";
      return { reply, history: messages.slice(1) }; // keep non-system history for the session
    }

    for (const call of message.tool_calls) {
      const tool = findTool(call.function.name);
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
              result = String(await tool.run(args));
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
