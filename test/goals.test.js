// Goals: create -> list -> log -> complete roundtrip over GOAL.md files,
// slug generation and collision handling, plus the four goal tools. Uses a
// temporary workspace; no network.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-goals-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { completeGoal, createGoal, listGoals, logGoal, slugifyTitle } =
  await import("../src/goals.js");
const { findTool } = await import("../src/tools.js");

test("slugifyTitle makes safe slugs and falls back to 'goal'", () => {
  assert.equal(slugifyTitle("Learn Japanese!"), "learn-japanese");
  assert.equal(slugifyTitle("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugifyTitle("HYROX 2027: sub-90"), "hyrox-2027-sub-90");
  assert.equal(slugifyTitle("日本語の目標"), "goal");
  assert.equal(slugifyTitle("!!!"), "goal");
});

test("createGoal writes GOAL.md with frontmatter and description", () => {
  const goal = createGoal("Learn Japanese", "Reach N3 by next spring.", new Date(2026, 10, 1));
  assert.equal(goal.slug, "learn-japanese");
  assert.equal(goal.status, "active");
  assert.equal(goal.created, "2026-11-01");
  const path = join(ws, "goals", "learn-japanese", "GOAL.md");
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  assert.match(text, /^---\ntitle: Learn Japanese\nstatus: active\ncreated: 2026-11-01\n---/);
  assert.match(text, /Reach N3 by next spring\./);
});

test("a colliding title gets a numbered slug", () => {
  const again = createGoal("Learn Japanese", "Second attempt.");
  assert.equal(again.slug, "learn-japanese-2");
});

test("listGoals returns every goal with its frontmatter", () => {
  const goals = listGoals();
  assert.deepEqual(
    goals.map((g) => g.slug),
    ["learn-japanese", "learn-japanese-2"],
  );
  assert.equal(goals[0].title, "Learn Japanese");
  assert.equal(goals[0].status, "active");
  assert.equal(goals[0].created, "2026-11-01");
});

test("logGoal appends a dated entry to the progress log", () => {
  const { entry } = logGoal("learn-japanese", "Did the first lesson.", new Date(2026, 10, 2));
  assert.equal(entry, "- 2026-11-02: Did the first lesson.");
  const text = readFileSync(join(ws, "goals", "learn-japanese", "GOAL.md"), "utf8");
  assert.match(text, /## Progress\n\n- 2026-11-02: Did the first lesson\./);
  // Frontmatter survives the rewrite.
  assert.match(text, /status: active/);
});

test("completeGoal flips the frontmatter status", () => {
  const goal = completeGoal("learn-japanese");
  assert.equal(goal.status, "completed");
  const text = readFileSync(join(ws, "goals", "learn-japanese", "GOAL.md"), "utf8");
  assert.match(text, /status: completed/);
  // Progress log survives completion.
  assert.match(text, /Did the first lesson\./);
  assert.equal(listGoals().find((g) => g.slug === "learn-japanese").status, "completed");
});

test("unknown and unsafe slugs are rejected", () => {
  assert.throws(() => logGoal("no-such-goal", "x"), /Goal not found/);
  assert.throws(() => completeGoal("../escape"), /Invalid goal slug/);
});

test("the goal tools wrap the same roundtrip", async () => {
  const created = await findTool("goal_create").run({
    title: "Ship v0.4",
    description: "Hooks, goals, doctor.",
  });
  assert.match(created, /slug: ship-v0-4/);

  const list = await findTool("goal_list").run({});
  assert.match(list, /ship-v0-4 \[active\] Ship v0\.4/);

  const logged = await findTool("goal_log").run({ slug: "ship-v0-4", text: "Started." });
  assert.match(logged, /Logged to goal ship-v0-4/);

  const done = await findTool("goal_complete").run({ slug: "ship-v0-4" });
  assert.match(done, /now completed/);
  const after = await findTool("goal_list").run({});
  assert.match(after, /ship-v0-4 \[completed\]/);
});
