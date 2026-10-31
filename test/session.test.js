// Session persistence: save/load roundtrip in a temporary workspace.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-session-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { loadSession, saveSession } = await import("../src/session.js");

test("a missing session loads as an empty history", async () => {
  assert.deepEqual(await loadSession("nope"), []);
});

test("save then load round-trips the history", async () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  await saveSession("chat-1", history);
  assert.deepEqual(await loadSession("chat-1"), history);
});

test("a later save overwrites the earlier history", async () => {
  await saveSession("chat-1", [{ role: "user", content: "new" }]);
  assert.deepEqual(await loadSession("chat-1"), [{ role: "user", content: "new" }]);
});

test("path-escaping session ids are rejected", async () => {
  await assert.rejects(() => saveSession("../evil", []), /Invalid session id/);
  await assert.rejects(() => loadSession("a/b"), /Invalid session id/);
});
