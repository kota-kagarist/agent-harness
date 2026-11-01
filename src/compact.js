// Conversation compaction: once the history grows past a rough token
// budget, the oldest turns are replaced by a single summary message so
// long sessions stay inside the model's context window. Token counts are
// estimated as characters / 4 — crude, but dependency-free and close
// enough to decide when to compact.
import { config } from "./config.js";
import { chatCompletion } from "./llm.js";

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

// Also used by session.js to write the end-of-session daily note.
export async function summarizeMessages(old) {
  // The mock provider cannot summarize; a fixed stand-in keeps the loop
  // (and the tests) working without an API key.
  if (config.model === "mock") {
    return `(mock summary) ${old.length} earlier message(s) were compacted.`;
  }
  const transcript = old
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.tool_calls ?? "")}`)
    .join("\n");
  const res = await chatCompletion(
    [
      {
        role: "system",
        content:
          "Summarize the conversation excerpt concisely. Keep facts, decisions, " +
          "names, numbers, and open tasks. Drop small talk.",
      },
      { role: "user", content: transcript },
    ],
    [],
  );
  return res.content ?? "";
}

// If the estimate exceeds `threshold`, replace the oldest turns with one
// summary message. The split point is moved to a user message so a tool
// call and its result are never separated. Returns the original array
// unchanged when there is nothing safe to compact.
export async function compactMessages(
  messages,
  { threshold = config.compactThreshold, keepRecent = 6 } = {},
) {
  if (estimateTokens(messages) <= threshold) return messages;
  const hasSystem = messages[0]?.role === "system";
  const head = hasSystem ? messages.slice(0, 1) : [];
  const rest = hasSystem ? messages.slice(1) : messages;
  if (rest.length <= keepRecent) return messages;

  let split = rest.length - keepRecent;
  while (split < rest.length && rest[split].role !== "user") split++;
  if (split <= 0 || split >= rest.length) return messages;

  const summary = await summarizeMessages(rest.slice(0, split));
  return [
    ...head,
    { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
    ...rest.slice(split),
  ];
}
