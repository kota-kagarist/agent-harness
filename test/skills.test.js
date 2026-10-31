// Skills: SKILL.md discovery, frontmatter parsing, on-demand loading, and
// the (name + description only) system-prompt listing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-skills-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

mkdirSync(join(ws, "skills", "demo"), { recursive: true });
writeFileSync(
  join(ws, "skills", "demo", "SKILL.md"),
  "---\nname: demo\ndescription: Does demo things for tests.\n---\n\n# Demo\n\nSECRET BODY STEP: do the demo.\n",
);
mkdirSync(join(ws, "skills", "plain"), { recursive: true });
writeFileSync(join(ws, "skills", "plain", "SKILL.md"), "# Plain Title\n\nBody text.\n");

const { listSkills, loadSkill } = await import("../src/skills.js");
const { findTool } = await import("../src/tools.js");
const { buildSystemPrompt } = await import("../src/memory.js");

test("listSkills reads frontmatter name and description", () => {
  const skills = listSkills();
  assert.deepEqual(
    skills.map((s) => s.name),
    ["demo", "plain"],
  );
  assert.equal(skills[0].description, "Does demo things for tests.");
  // No frontmatter: directory name + first heading line as fallback.
  assert.equal(skills[1].description, "Plain Title");
});

test("loadSkill returns the body without frontmatter", () => {
  const body = loadSkill("demo");
  assert.match(body, /SECRET BODY STEP/);
  assert.ok(!body.includes("description:"));
});

test("loadSkill rejects bad names and unknown skills", () => {
  assert.throws(() => loadSkill("../demo"), /Invalid skill name/);
  assert.throws(() => loadSkill("missing"), /Skill not found/);
});

test("the load_skill tool loads a skill body", async () => {
  const out = await findTool("load_skill").run({ name: "demo" });
  assert.match(out, /SECRET BODY STEP/);
});

test("the system prompt lists skills but not their bodies", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /- demo: Does demo things for tests\./);
  assert.ok(!prompt.includes("SECRET BODY STEP"));
});
