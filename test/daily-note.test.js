// Daily memory notes: endSessionNote appends a "## HH:MM セッション要約"
// section to workspace/memory/<YYYY-MM-DD>.md (local date). With the mock
// provider the note is an excerpt of the last request and reply. The note
// lives under memory/, so memory_search finds it — verified here too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-note-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { endSessionNote } = await import("../src/session.js");
const { findTool } = await import("../src/tools.js");

const HISTORY = [
  { role: "user", content: "今日の天気は？" },
  { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
  { role: "tool", tool_call_id: "1", content: "sunny" },
  { role: "assistant", content: "晴れです。" },
];

test("endSessionNote writes a dated section into today's memory file", async () => {
  const now = new Date(2026, 10, 1, 15, 30); // 2026-11-01 15:30 local
  const path = await endSessionNote(HISTORY, { now });
  assert.equal(path, join(ws, "memory", "2026-11-01.md"));
  const text = readFileSync(path, "utf8");
  assert.match(text, /^## 15:30 セッション要約\n/);
  assert.match(text, /- 依頼: 今日の天気は？/);
  assert.match(text, /- 返答: 晴れです。/);
});

test("a second session on the same day appends another section", async () => {
  const now = new Date(2026, 10, 1, 16, 5);
  await endSessionNote(
    [
      { role: "user", content: "明日の予定は？" },
      { role: "assistant", content: "10時から会議です。" },
    ],
    { now },
  );
  const text = readFileSync(join(ws, "memory", "2026-11-01.md"), "utf8");
  const headings = text.match(/^## \d{2}:\d{2} セッション要約$/gm) ?? [];
  assert.deepEqual(headings, ["## 15:30 セッション要約", "## 16:05 セッション要約"]);
});

test("empty or contentless histories record nothing", async () => {
  const other = join(ws, "memory", "2026-11-02.md");
  assert.equal(await endSessionNote([], { now: new Date(2026, 10, 2) }), null);
  assert.equal(
    await endSessionNote([{ role: "tool", content: "x" }], { now: new Date(2026, 10, 2) }),
    null,
  );
  assert.ok(!existsSync(other));
});

test("the note is found by memory_search (it lives under memory/)", async () => {
  const out = await findTool("memory_search").run({ query: "天気" });
  assert.match(out, /memory\/2026-11-01\.md:\d+: - 依頼: 今日の天気は？/);
});
