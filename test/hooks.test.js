// Hooks: file-mtime change detection. The first observation only records
// a baseline (never fires), a later mtime change fires exactly once, and
// state persists in hooks-state.json. Uses a temporary workspace and an
// injected runner — no LLM, no network, no timers.
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-hooks-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

writeFileSync(
  join(ws, "hooks.json"),
  JSON.stringify([
    { name: "watch", type: "file", path: "watched.txt", prompt: "What changed?" },
    { name: "off", type: "file", path: "other.txt", prompt: "never", enabled: false },
    { name: "ghost", type: "file", path: "missing.txt", prompt: "boo" },
  ]),
);
writeFileSync(join(ws, "watched.txt"), "v1");
writeFileSync(join(ws, "other.txt"), "x");

const { evaluateHooks, loadHookState } = await import("../src/hooks.js");
const { listNotifications } = await import("../src/outbox.js");

const calls = [];
const runner = async (prompt) => {
  calls.push(prompt);
  return { reply: `ran: ${prompt}` };
};
const NOW = new Date(2026, 10, 1, 12, 0, 0);

test("first observation records a baseline and never fires", async () => {
  const fired = await evaluateHooks(NOW, { runner });
  assert.deepEqual(fired, []);
  assert.deepEqual(calls, []);
  const state = loadHookState();
  assert.equal(typeof state.watch.mtimeMs, "number");
  assert.equal(state.watch.path, "watched.txt");
  assert.equal(state.watch.lastRun, null);
  assert.ok(existsSync(join(ws, "hooks-state.json")));
  // Disabled hooks and missing files are not even baselined.
  assert.equal(state.off, undefined);
  assert.equal(state.ghost, undefined);
});

test("no change means no fire on the next evaluation", async () => {
  const fired = await evaluateHooks(NOW, { runner });
  assert.deepEqual(fired, []);
  assert.deepEqual(calls, []);
});

test("an mtime change fires once and queues the reply in the outbox", async () => {
  const before = loadHookState().watch.mtimeMs;
  writeFileSync(join(ws, "watched.txt"), "v2");
  const bumped = new Date(Math.floor(before) + 10_000);
  utimesSync(join(ws, "watched.txt"), bumped, bumped);

  const fired = await evaluateHooks(NOW, { runner });
  assert.deepEqual(fired, [{ name: "watch", reply: "ran: What changed?" }]);
  assert.deepEqual(calls, ["What changed?"]);

  const notes = await listNotifications();
  const rec = notes.find((n) => n.source === "hook:watch");
  assert.ok(rec);
  assert.equal(rec.text, "ran: What changed?");
  assert.equal(rec.delivered, false);

  const state = JSON.parse(readFileSync(join(ws, "hooks-state.json"), "utf8"));
  assert.equal(state.watch.mtimeMs, Math.floor(before) + 10_000);
  assert.equal(state.watch.lastRun, NOW.toISOString());
});

test("the same mtime does not fire twice", async () => {
  const fired = await evaluateHooks(new Date(2026, 10, 1, 12, 5, 0), { runner });
  assert.deepEqual(fired, []);
  assert.equal(calls.length, 1);
});

test("a file that appears later is baselined first, then fires on change", async () => {
  writeFileSync(join(ws, "missing.txt"), "now I exist");
  assert.deepEqual(await evaluateHooks(NOW, { runner }), []); // baseline only
  const base = loadHookState().ghost.mtimeMs;
  assert.equal(typeof base, "number");

  writeFileSync(join(ws, "missing.txt"), "changed");
  const bumped = new Date(Math.floor(base) + 10_000);
  utimesSync(join(ws, "missing.txt"), bumped, bumped);
  const fired = await evaluateHooks(NOW, { runner });
  assert.deepEqual(
    fired.map((f) => f.name),
    ["ghost"],
  );
});
