// Tools that read the workspace (memory_search, todo_write) run against a
// temporary workspace directory — no network, no real user files.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-tools-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

writeFileSync(join(ws, "MEMORY.md"), "# Memory\n\nThe user's cat is named Mochi.\n");
mkdirSync(join(ws, "memory", "sub"), { recursive: true });
writeFileSync(join(ws, "memory", "2026-01-01.md"), "Mochi likes tuna.\nNothing else.\n");
writeFileSync(join(ws, "memory", "sub", "deep.md"), "Deep note about Mochi.\n");

const { findTool, getTodos } = await import("../src/tools.js");

test("memory_search finds lines in MEMORY.md with file and line number", async () => {
  const out = await findTool("memory_search").run({ query: "Mochi" });
  assert.match(out, /MEMORY\.md:3: The user's cat is named Mochi\./);
  assert.match(out, /memory\/2026-01-01\.md:1: Mochi likes tuna\./);
  assert.match(out, /memory\/sub\/deep\.md:1: Deep note about Mochi\./);
});

test("memory_search is case-insensitive and reports no matches", async () => {
  const out = await findTool("memory_search").run({ query: "mochi" });
  assert.match(out, /Mochi/);
  const none = await findTool("memory_search").run({ query: "nonexistentword" });
  assert.match(none, /No matches/);
});

test("todo_write replaces and returns the session todo list", async () => {
  const out = await findTool("todo_write").run({ todos: ["first", "second"] });
  assert.equal(out, "1. first\n2. second");
  assert.deepEqual(getTodos(), ["first", "second"]);
  const cleared = await findTool("todo_write").run({ todos: [] });
  assert.equal(cleared, "(todo list is empty)");
  assert.deepEqual(getTodos(), []);
});
