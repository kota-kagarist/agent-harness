// Skills: reusable instruction packs kept as Markdown in the workspace.
// Each skill is a directory workspace/skills/<name>/SKILL.md with optional
// frontmatter (name / description). Only the name + description list goes
// into the system prompt; the full text is loaded on demand via the
// load_skill tool, so many skills can exist without bloating every prompt.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function skillsDir() {
  return join(config.workspace, "skills");
}

function parseSkill(text, dirName) {
  let name = dirName;
  let description = "";
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*(name|description)\s*:\s*(.+?)\s*$/);
      if (m?.[1] === "name") name = m[2];
      if (m?.[1] === "description") description = m[2];
    }
  }
  if (!description) {
    description =
      body
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0) ?? "";
  }
  return { name, description, body: body.trim() };
}

export function listSkills() {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const skills = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const { name, description } = parseSkill(readFileSync(path, "utf8"), entry.name);
    skills.push({ name, description });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name) {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  const path = join(skillsDir(), name, "SKILL.md");
  if (!existsSync(path)) throw new Error(`Skill not found: ${name}`);
  return parseSkill(readFileSync(path, "utf8"), name).body;
}
