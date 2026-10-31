// Approval gate: consequential tools ask a human before they run.
// - Interactive mode: the `ask` callback decides (CLI prompt).
// - Unattended mode (scheduler / --once): denied unless AGENT_ALLOW_UNATTENDED=1.
import { config } from "./config.js";

export async function checkApproval(tool, args, ask) {
  if (!tool.requiresApproval) return true;
  if (ask) return ask(tool, args);
  return config.allowUnattended;
}
