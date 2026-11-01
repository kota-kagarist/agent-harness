// Approval gate: consequential tools ask a human before they run.
// - Saved rules first (permissions.js): a tool saved as "allow" runs
//   without asking; a tool saved as "deny" never runs.
// - Interactive mode: the `ask` callback decides (CLI prompt).
// - Unattended mode (scheduler / --once): denied unless AGENT_ALLOW_UNATTENDED=1.
import { config } from "./config.js";
import { permissionFor } from "./permissions.js";

export async function checkApproval(tool, args, ask) {
  if (!tool.requiresApproval) return true;
  const ruling = permissionFor(tool.name);
  if (ruling === "deny") return false;
  if (ruling === "allow") return true;
  if (ask) return ask(tool, args);
  return config.allowUnattended;
}
