// Jobs: due-ness rules for interval / daily / runonce, legacy
// schedules.json compatibility, and persisted run state. Uses the mock
// provider and a temporary workspace — no timers, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-jobs-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { isDue, loadJobs, runDueJobs } = await import("../src/jobs.js");

// 2026-11-01 09:00 local time.
const NOW = new Date(2026, 10, 1, 9, 0, 0);

test("interval jobs are due when never run or past their interval", () => {
  const job = { name: "a", kind: "interval", everyMinutes: 60, prompt: "x" };
  assert.equal(isDue(job, {}, NOW), true);
  assert.equal(
    isDue(job, { lastRun: new Date(2026, 10, 1, 8, 30).toISOString() }, NOW),
    false,
  );
  assert.equal(
    isDue(job, { lastRun: new Date(2026, 10, 1, 7, 59).toISOString() }, NOW),
    true,
  );
});

test("daily jobs run once per day at/after their time", () => {
  const job = { name: "d", kind: "daily", time: "08:00", prompt: "x" };
  assert.equal(isDue(job, {}, NOW), true); // 09:00 >= 08:00, never ran
  assert.equal(
    isDue(job, { lastRun: new Date(2026, 10, 1, 8, 5).toISOString() }, NOW),
    false, // already ran today
  );
  assert.equal(
    isDue(job, { lastRun: new Date(2026, 9, 31, 8, 5).toISOString() }, NOW),
    true, // last run was yesterday
  );
  const early = new Date(2026, 10, 1, 7, 0, 0);
  assert.equal(isDue(job, {}, early), false); // before 08:00
});

test("runonce jobs run once at/after `at`, then never again", () => {
  const job = { name: "r", kind: "runonce", at: "2026-11-01T08:00:00", prompt: "x" };
  assert.equal(isDue(job, {}, NOW), true);
  assert.equal(isDue(job, { runCount: 1 }, NOW), false);
  assert.equal(isDue(job, { disabled: true }, NOW), false);
  const future = { ...job, at: "2027-01-01T00:00:00" };
  assert.equal(isDue(future, {}, NOW), false);
});

test("disabled jobs are never due", () => {
  const job = { name: "x", kind: "interval", everyMinutes: 1, prompt: "x", enabled: false };
  assert.equal(isDue(job, {}, NOW), false);
});

test("legacy schedules.json is read as interval jobs", () => {
  writeFileSync(
    join(ws, "schedules.json"),
    JSON.stringify([{ name: "old", everyMinutes: 30, prompt: "hi" }]),
  );
  const jobs = loadJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "interval");
  assert.equal(jobs[0].everyMinutes, 30);
});

test("runDueJobs runs due jobs, persists state, and disables runonce", async () => {
  writeFileSync(
    join(ws, "jobs.json"),
    JSON.stringify([
      { name: "once", kind: "runonce", at: "2026-11-01T08:00:00", prompt: "What time is it?" },
      { name: "hourly", kind: "interval", everyMinutes: 1440, prompt: "What time is it?" },
      { name: "later", kind: "daily", time: "23:59", prompt: "What time is it?" },
    ]),
  );
  const first = await runDueJobs(NOW);
  assert.deepEqual(
    first.map((r) => r.name),
    ["once", "hourly"], // "later" is not due at 09:00
  );
  const state = JSON.parse(readFileSync(join(ws, "jobs-state.json"), "utf8"));
  assert.equal(state.once.runCount, 1);
  assert.equal(state.once.disabled, true);
  assert.equal(state.hourly.runCount, 1);

  const second = await runDueJobs(NOW);
  assert.equal(second.length, 0); // nothing runs twice
});
