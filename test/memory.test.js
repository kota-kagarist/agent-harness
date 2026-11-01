// AGENTS.md: when the workspace has one, its operating notes join the
// system prompt; when it does not, the prompt is exactly as before.
// Uses a temporary workspace; no network.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-memory-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { buildSystemPrompt } = await import("../src/memory.js");

test("without AGENTS.md the prompt has no operating notes", () => {
  const prompt = buildSystemPrompt();
  assert.doesNotMatch(prompt, /operating notes/);
});

test("AGENTS.md content is included as operating notes", () => {
  writeFileSync(
    join(ws, "MEMORY.md"),
    "# MEMORY.md\n\nThe user likes concise answers.\n",
    "utf8",
  );
  writeFileSync(
    join(ws, "AGENTS.md"),
    "# AGENTS.md\n\n- Always answer in Japanese.\n- Drafts go in drafts/.\n",
    "utf8",
  );
  const prompt = buildSystemPrompt();
  assert.match(prompt, /AGENTS\.md \(operating notes\)/);
  assert.match(prompt, /Always answer in Japanese\./);
  assert.match(prompt, /Drafts go in drafts\/\./);
  // The memory files still load alongside it.
  assert.match(prompt, /The user likes concise answers\./);
});

test("removing AGENTS.md removes the section again", () => {
  rmSync(join(ws, "AGENTS.md"));
  const prompt = buildSystemPrompt();
  assert.doesNotMatch(prompt, /operating notes/);
  assert.match(prompt, /The user likes concise answers\./);
});
