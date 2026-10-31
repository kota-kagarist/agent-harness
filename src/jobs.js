// Jobs: scheduled prompts run through the agent without a human prompt.
// Jobs live in workspace/jobs.json:
//   { "name": "morning-briefing", "kind": "daily", "time": "08:00", "prompt": "..." }
//   { "name": "watch",            "kind": "interval", "everyMinutes": 60, "prompt": "..." }
//   { "name": "one-off",          "kind": "runonce", "at": "2026-11-01T09:00:00+09:00", "prompt": "..." }
// Kinds:
//   interval — every `everyMinutes` minutes (first run happens immediately)
//   daily    — once per day, at/after `time` ("HH:MM", local time)
//   runonce  — once, at/after the ISO datetime `at`, then disabled
// Run state (lastRun / runCount / disabled) is kept in
// workspace/jobs-state.json so restarts don't re-run finished jobs.
// The legacy workspace/schedules.json format ([{name, everyMinutes, prompt}])
// is still read and treated as interval jobs when jobs.json is absent.
// Gated tools are denied unless AGENT_ALLOW_UNATTENDED=1 (see approval.js).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.js";
import { assertConfigured, config } from "./config.js";

const TICK_MS = 30_000;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadJobs() {
  const jobsPath = join(config.workspace, "jobs.json");
  if (existsSync(jobsPath)) {
    return JSON.parse(readFileSync(jobsPath, "utf8")).map((j) => ({
      enabled: true,
      ...j,
    }));
  }
  // Legacy format from v0.1: plain interval schedules.
  const legacy = readJson(join(config.workspace, "schedules.json"), []);
  return legacy.map((j) => ({
    name: j.name,
    kind: "interval",
    everyMinutes: j.everyMinutes,
    prompt: j.prompt,
    enabled: true,
  }));
}

export function loadState() {
  return readJson(join(config.workspace, "jobs-state.json"), {});
}

export function saveState(state) {
  writeFileSync(
    join(config.workspace, "jobs-state.json"),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isDue(job, entry = {}, now = new Date()) {
  if (job.enabled === false || entry.disabled) return false;
  if (job.kind === "interval") {
    if (!entry.lastRun) return true;
    return now - new Date(entry.lastRun) >= (job.everyMinutes ?? 0) * 60_000;
  }
  if (job.kind === "daily") {
    const [h, m] = (job.time ?? "00:00").split(":").map(Number);
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    if (now < at) return false;
    return !entry.lastRun || !sameLocalDay(new Date(entry.lastRun), now);
  }
  if (job.kind === "runonce") {
    if ((entry.runCount ?? 0) > 0) return false;
    return now >= new Date(job.at);
  }
  return false;
}

// Run every due job once, updating and persisting state. Returns the list
// of { name, reply } for the jobs that ran.
export async function runDueJobs(now = new Date()) {
  const jobs = loadJobs();
  const state = loadState();
  const results = [];
  for (const job of jobs) {
    const entry = state[job.name] ?? {};
    if (!isDue(job, entry, now)) continue;
    console.log(`\n[${now.toISOString()}] job: ${job.name}`);
    try {
      const { reply } = await runAgent(job.prompt);
      console.log(reply);
      results.push({ name: job.name, reply });
    } catch (err) {
      console.error(`job ${job.name} failed: ${err.message}`);
      results.push({ name: job.name, reply: `Error: ${err.message}` });
    }
    entry.lastRun = now.toISOString();
    entry.runCount = (entry.runCount ?? 0) + 1;
    if (job.kind === "runonce") entry.disabled = true;
    state[job.name] = entry;
    saveState(state);
  }
  return results;
}

export async function main() {
  assertConfigured();
  const jobs = loadJobs();
  if (!jobs.length) {
    console.error(
      `No jobs found in ${config.workspace} (jobs.json or schedules.json). See examples/.`,
    );
    process.exit(1);
  }
  console.log(`jobs: ${jobs.length} job(s) loaded, ticking every ${TICK_MS / 1000}s`);
  await runDueJobs();
  setInterval(() => void runDueJobs(), TICK_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
