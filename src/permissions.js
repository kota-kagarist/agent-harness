// Saved permission rules: per-tool allow/deny decisions that persist
// across sessions in workspace/permissions.json:
//
//   { "allow": ["write_file"], "deny": ["run_command"] }
//
// The approval gate (approval.js) consults these before prompting: a
// saved "allow" runs without asking, a saved "deny" never runs (deny
// wins when a tool somehow sits in both lists). Interactive users save
// an "allow" by answering "a" at the approval prompt; inspect the file
// with `node src/index.js --permissions`. The file is plain JSON — edit
// or delete it by hand to change your mind.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export function permissionsPath(workspace = config.workspace) {
  return join(workspace, "permissions.json");
}

function nameList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

// Missing or corrupt file => no saved rules (the gate falls back to
// prompting / unattended rules, exactly as before permissions existed).
export function loadPermissions(workspace = config.workspace) {
  const path = permissionsPath(workspace);
  if (!existsSync(path)) return { allow: [], deny: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { allow: nameList(data.allow), deny: nameList(data.deny) };
  } catch {
    return { allow: [], deny: [] };
  }
}

// "allow" | "deny" | null for one tool. Deny is checked first so it
// always wins, even over a stale allow entry for the same tool.
export function permissionFor(toolName, rules = loadPermissions()) {
  if (rules.deny.includes(toolName)) return "deny";
  if (rules.allow.includes(toolName)) return "allow";
  return null;
}

// Record a decision for a tool, moving it out of the opposite list, and
// persist. Returns the updated rules.
export function savePermission(toolName, decision, workspace = config.workspace) {
  if (decision !== "allow" && decision !== "deny") {
    throw new Error(`Invalid permission decision: ${decision}`);
  }
  const rules = loadPermissions(workspace);
  const other = decision === "allow" ? "deny" : "allow";
  rules[other] = rules[other].filter((n) => n !== toolName);
  if (!rules[decision].includes(toolName)) rules[decision].push(toolName);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    permissionsPath(workspace),
    `${JSON.stringify(rules, null, 2)}\n`,
    "utf8",
  );
  return rules;
}
