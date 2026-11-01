// Goals: durable outcomes the user is working towards, kept as plain
// Markdown files a human can read and edit — one directory per goal at
// workspace/goals/<slug>/GOAL.md:
//
//   ---
//   title: Learn Japanese
//   status: active
//   created: 2026-11-01
//   ---
//
//   <description>
//
//   ## Progress
//
//   - 2026-11-01: kicked off
//
// The agent manages them through the goal_create / goal_list / goal_log /
// goal_complete tools; `node src/index.js --goals` lists them read-only.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function goalsDir() {
  return join(config.workspace, "goals");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local calendar date, YYYY-MM-DD (never UTC — notes and goals are dated
// the way the user experiences the day).
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Turn a title into a safe directory name: lowercase ASCII letters, digits
// and hyphens. A title with no usable characters falls back to "goal".
export function slugifyTitle(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "goal";
}

function uniqueSlug(base) {
  let slug = base;
  for (let n = 2; existsSync(join(goalsDir(), slug)); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

function goalPath(slug) {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid goal slug: ${slug}`);
  return join(goalsDir(), slug, "GOAL.md");
}

const FM_KEYS = ["title", "status", "created"];

function parseGoal(text, slug) {
  const meta = { title: slug, status: "active", created: "" };
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*(title|status|created)\s*:\s*(.+?)\s*$/);
      if (m && FM_KEYS.includes(m[1])) meta[m[1]] = m[2];
    }
  }
  return { slug, ...meta, body: body.trim() };
}

function renderGoal({ title, status, created }, body) {
  return `---\ntitle: ${title}\nstatus: ${status}\ncreated: ${created}\n---\n\n${body.trim()}\n`;
}

function readGoal(slug) {
  const path = goalPath(slug);
  if (!existsSync(path)) throw new Error(`Goal not found: ${slug}`);
  return parseGoal(readFileSync(path, "utf8"), slug);
}

export function createGoal(title, description = "", now = new Date()) {
  const cleanTitle = String(title).replace(/\s+/g, " ").trim();
  if (!cleanTitle) throw new Error("Goal title must not be empty");
  const slug = uniqueSlug(slugifyTitle(cleanTitle));
  const meta = { title: cleanTitle, status: "active", created: localDate(now) };
  mkdirSync(join(goalsDir(), slug), { recursive: true });
  writeFileSync(goalPath(slug), renderGoal(meta, String(description).trim()), "utf8");
  return { slug, ...meta };
}

export function listGoals() {
  const dir = goalsDir();
  if (!existsSync(dir)) return [];
  const goals = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "GOAL.md");
    if (!existsSync(path)) continue;
    const { slug, title, status, created } = parseGoal(
      readFileSync(path, "utf8"),
      entry.name,
    );
    goals.push({ slug, title, status, created });
  }
  return goals.sort((a, b) => a.slug.localeCompare(b.slug));
}

// Append a dated entry to the goal's progress log (the end of the body).
export function logGoal(slug, text, now = new Date()) {
  const goal = readGoal(slug);
  const entry = `- ${localDate(now)}: ${String(text).trim()}`;
  const body = goal.body.includes("## Progress")
    ? `${goal.body}\n${entry}`
    : `${goal.body}\n\n## Progress\n\n${entry}`;
  writeFileSync(goalPath(slug), renderGoal(goal, body), "utf8");
  return { slug, entry };
}

export function completeGoal(slug) {
  const goal = readGoal(slug);
  goal.status = "completed";
  writeFileSync(goalPath(slug), renderGoal(goal, goal.body), "utf8");
  return { slug, title: goal.title, status: goal.status, created: goal.created };
}
