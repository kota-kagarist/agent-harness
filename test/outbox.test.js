// Outbox: the JSONL notification queue — append, list, mark delivered —
// plus the `notify` tool and the jobs -> outbox integration. Uses the mock
// provider and a temporary workspace; no network.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-outbox-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { appendNotification, listNotifications, listUndelivered, markDelivered } =
  await import("../src/outbox.js");
const { findTool } = await import("../src/tools.js");
const { runDueJobs } = await import("../src/jobs.js");

test("appendNotification writes one JSONL record per notification", async () => {
  const rec = await appendNotification("first note", { source: "agent" });
  assert.ok(rec.id);
  assert.equal(rec.text, "first note");
  assert.equal(rec.source, "agent");
  assert.equal(rec.delivered, false);
  assert.ok(!Number.isNaN(Date.parse(rec.createdAt)));

  await appendNotification("second note", { source: "job:daily" });
  const lines = readFileSync(join(ws, "outbox.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const all = await listNotifications();
  assert.deepEqual(
    all.map((n) => n.text),
    ["first note", "second note"],
  );
  assert.equal((await listUndelivered()).length, 2);
});

test("markDelivered flips only the given ids", async () => {
  const all = await listNotifications();
  const [first] = all;
  await markDelivered([first.id]);
  const after = await listNotifications();
  assert.equal(after.find((n) => n.id === first.id).delivered, true);
  const pending = await listUndelivered();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, "second note");
});

test("the notify tool queues a notification from the agent", async () => {
  const out = await findTool("notify").run({ text: "from the tool" });
  assert.match(out, /Queued notification/);
  const pending = await listUndelivered();
  const rec = pending.find((n) => n.text === "from the tool");
  assert.ok(rec);
  assert.equal(rec.source, "agent");
});

test("job results are queued in the outbox with source job:<name>", async () => {
  writeFileSync(
    join(ws, "jobs.json"),
    JSON.stringify([
      { name: "brief", kind: "interval", everyMinutes: 60, prompt: "What time is it?" },
    ]),
  );
  const results = await runDueJobs(new Date());
  assert.equal(results.length, 1);
  const all = await listNotifications();
  const rec = all.find((n) => n.source === "job:brief");
  assert.ok(rec);
  assert.match(rec.text, /current time/i);
  assert.equal(rec.delivered, false);
});
