// Tiny scheduler: reads workspace/schedules.json and runs each entry's
// prompt through the agent on its interval, printing the result.
// Format: [{ "name": "morning-briefing", "everyMinutes": 1440, "prompt": "..." }]
// Gated tools are denied unless AGENT_ALLOW_UNATTENDED=1 (see approval.js).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import { assertConfigured, config } from "./config.js";

async function main() {
  assertConfigured();
  const path = join(config.workspace, "schedules.json");
  if (!existsSync(path)) {
    console.error(`No schedules file at ${path}. See examples/schedules.example.json.`);
    process.exit(1);
  }
  const jobs = JSON.parse(readFileSync(path, "utf8"));
  console.log(`scheduler: ${jobs.length} job(s) loaded`);

  const runJob = async (job) => {
    console.log(`\n[${new Date().toISOString()}] ${job.name}`);
    try {
      const { reply } = await runAgent(job.prompt);
      console.log(reply);
    } catch (err) {
      console.error(`job ${job.name} failed: ${err.message}`);
    }
  };

  for (const job of jobs) {
    if (job.runOnStart) await runJob(job);
    setInterval(() => void runJob(job), job.everyMinutes * 60_000);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
