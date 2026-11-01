// Doctor: `node src/index.js --doctor` runs a read-only self-check of the
// environment and prints one line per check — [ok] or [NG] — exiting 1
// when anything is NG. It verifies that secrets are *set*, never their
// values: LLM_API_KEY and friends are only ever reported as present or
// missing, so the output is safe to paste into an issue or a chat.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { loadConnectorConfig, probeMcpServer } from "./mcp.js";

const WORKSPACE_SUBDIRS = ["skills", "memory", "goals", "sessions"];
const JSON_CONFIGS = ["connectors.json", "jobs.json", "hooks.json"];
const MCP_PROBE_TIMEOUT_MS = 3000;

export function checkNodeVersion(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  return {
    name: "Node.js version",
    ok: major >= 20,
    detail: `v${version}${major >= 20 ? "" : " (agent-harness needs >= 20)"}`,
  };
}

// Missing directories are not a failure: they are created on demand all
// over the harness, so the check makes them and notes that it did.
export function checkWorkspace(workspace = config.workspace) {
  const created = [];
  try {
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
      created.push(".");
    }
    for (const sub of WORKSPACE_SUBDIRS) {
      const dir = join(workspace, sub);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        created.push(sub);
      }
    }
  } catch (err) {
    return { name: "Workspace", ok: false, detail: `cannot create directories: ${err.message}` };
  }
  return {
    name: "Workspace",
    ok: true,
    detail: created.length
      ? `${workspace} (created: ${created.join(", ")})`
      : `${workspace} (skills/memory/goals/sessions present)`,
  };
}

// Presence only — values are never read into the report.
export function checkLlmConfig(env = process.env) {
  if (env.LLM_MODEL === "mock") {
    return {
      name: "LLM configuration",
      ok: true,
      detail: "LLM_MODEL=mock (built-in mock provider, no key needed)",
    };
  }
  const required = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"];
  const missing = required.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length) {
    return {
      name: "LLM configuration",
      ok: false,
      detail: `not set: ${missing.join(", ")} (see .env.example)`,
    };
  }
  return {
    name: "LLM configuration",
    ok: true,
    detail: "LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are set (values not shown)",
  };
}

export function checkConfigFiles(workspace = config.workspace) {
  return JSON_CONFIGS.map((file) => {
    const path = join(workspace, file);
    if (!existsSync(path)) {
      return { name: `Config ${file}`, ok: true, detail: "not present (optional)" };
    }
    try {
      JSON.parse(readFileSync(path, "utf8"));
      return { name: `Config ${file}`, ok: true, detail: "valid JSON" };
    } catch (err) {
      return { name: `Config ${file}`, ok: false, detail: `invalid JSON: ${err.message}` };
    }
  });
}

export async function checkMcpServers({
  timeoutMs = MCP_PROBE_TIMEOUT_MS,
  probe = probeMcpServer,
} = {}) {
  const servers = loadConnectorConfig();
  if (!servers.length) {
    return [{ name: "MCP servers", ok: true, detail: "none configured" }];
  }
  const checks = [];
  for (const server of servers) {
    const res = await probe(server, timeoutMs);
    checks.push({
      name: `MCP server "${server.name}"`,
      ok: res.ok,
      detail: res.detail,
    });
  }
  return checks;
}

// Run every check, print one [ok]/[NG] line each via `out`, and return
// { ok, checks }. Works without any LLM configuration.
export async function runDoctor({
  env = process.env,
  workspace = config.workspace,
  mcpTimeoutMs = MCP_PROBE_TIMEOUT_MS,
  out = (line) => console.log(line),
} = {}) {
  const checks = [
    checkNodeVersion(),
    checkWorkspace(workspace),
    checkLlmConfig(env),
    ...checkConfigFiles(workspace),
    ...(await checkMcpServers({ timeoutMs: mcpTimeoutMs })),
  ];
  for (const check of checks) {
    out(`[${check.ok ? "ok" : "NG"}] ${check.name}: ${check.detail}`);
  }
  const ok = checks.every((c) => c.ok);
  out(ok ? "doctor: all checks passed" : "doctor: some checks FAILED");
  return { ok, checks };
}
