// Slash commands for the interactive CLI: lines starting with "/" are
// handled by the harness itself instead of being sent to the model.
// parseCommand is a pure function (line in, command out) so the parsing
// rules are testable without a terminal; index.js does the acting.

export const COMMANDS = [
  { name: "help", description: "Show this command list" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "compact", description: "Compact the history now (summarize old turns)" },
  { name: "model", description: "Show the current provider and model" },
  { name: "outbox", description: "Show undelivered notifications" },
  { name: "goals", description: "List goals" },
  { name: "exit", description: "End the session (same as typing exit)" },
];

const KNOWN = new Set(COMMANDS.map((c) => c.name));

// Returns null for ordinary input, otherwise
// { name, args } where name is one of COMMANDS, or "unknown" for a
// slash-line that matches no command (args keeps the rest of the line).
export function parseCommand(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const args = rest.join(" ");
  if (!KNOWN.has(name)) return { name: "unknown", command: name, args };
  return { name, args };
}

export function commandHelp() {
  const lines = COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`);
  return `Commands:\n${lines.join("\n")}`;
}
