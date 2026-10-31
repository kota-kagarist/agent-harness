// Environment-based configuration. Reads .env from the repo root if present
// (tiny hand-rolled parser — this project is dependency-free by design).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

loadDotEnv();

export const config = {
  baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "",
  workspace: resolve(process.env.AGENT_WORKSPACE || "./workspace"),
  allowUnattended: process.env.AGENT_ALLOW_UNATTENDED === "1",
};

export function assertConfigured() {
  if (config.model === "mock") return; // built-in mock provider, no key needed
  if (!config.apiKey) throw new Error("LLM_API_KEY is not set (see .env.example).");
  if (!config.model) throw new Error("LLM_MODEL is not set (see .env.example).");
}
