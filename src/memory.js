// Long-term memory is plain Markdown files in the workspace directory.
// They are read into the system prompt on every run: human-editable,
// version-controllable, and inspectable — no database required.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { listSkills } from "./skills.js";

const MEMORY_FILES = ["IDENTITY.md", "USER.md", "MEMORY.md"];

const BASE_PROMPT = `You are a personal AI agent running inside agent-harness.
You help your user across conversations. Use the tools available to you.
Ask for approval is handled by the harness for gated tools; never try to
bypass it. Keep answers concise unless detail is asked for.`;

export function buildSystemPrompt() {
  const parts = [BASE_PROMPT];
  for (const name of MEMORY_FILES) {
    const path = join(config.workspace, name);
    if (existsSync(path)) {
      parts.push(`\n----- ${name} -----\n${readFileSync(path, "utf8").trim()}`);
    }
  }
  // Skills: only the name + description list is injected. The full text is
  // loaded on demand with the load_skill tool (see skills.js).
  try {
    const skills = listSkills();
    if (skills.length) {
      const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
      parts.push(`\n----- Skills (load one with the load_skill tool) -----\n${list}`);
    }
  } catch {
    // A broken skills directory must not break the prompt.
  }
  return parts.join("\n");
}
