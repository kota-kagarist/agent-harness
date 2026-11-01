// Doctor: environment self-checks against a temporary workspace and
// stubbed environments. The golden rule under test: secret *values* must
// never appear in the output — only whether they are set. The MCP probe
// uses the local fake server fixture; no external network.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-doctor-"));
process.env.AGENT_WORKSPACE = ws;

const {
  checkConfigFiles,
  checkLlmConfig,
  checkNodeVersion,
  checkWorkspace,
  runDoctor,
} = await import("../src/doctor.js");

test("checkNodeVersion requires Node >= 20", () => {
  assert.equal(checkNodeVersion("20.11.0").ok, true);
  assert.equal(checkNodeVersion("22.0.0").ok, true);
  const old = checkNodeVersion("18.19.0");
  assert.equal(old.ok, false);
  assert.match(old.detail, /v18\.19\.0/);
});

test("checkWorkspace creates missing directories and stays ok", () => {
  const fresh = join(ws, "fresh");
  const check = checkWorkspace(fresh);
  assert.equal(check.ok, true);
  assert.match(check.detail, /created/);
  for (const sub of ["skills", "memory", "goals", "sessions"]) {
    assert.ok(existsSync(join(fresh, sub)), sub);
  }
  const again = checkWorkspace(fresh);
  assert.equal(again.ok, true);
  assert.match(again.detail, /present/);
});

test("checkLlmConfig passes for the mock provider", () => {
  const check = checkLlmConfig({ LLM_MODEL: "mock" });
  assert.equal(check.ok, true);
  assert.match(check.detail, /mock/);
});

test("checkLlmConfig names missing variables but never prints values", () => {
  const check = checkLlmConfig({
    LLM_BASE_URL: "https://example.invalid/v1",
    LLM_API_KEY: "sk-sentinel-secret",
    // LLM_MODEL missing
  });
  assert.equal(check.ok, false);
  assert.match(check.detail, /LLM_MODEL/);
  assert.ok(!check.detail.includes("sk-sentinel-secret"));
  assert.ok(!check.detail.includes("example.invalid"));
});

test("checkConfigFiles validates JSON configs that exist", () => {
  writeFileSync(join(ws, "jobs.json"), "{ not json");
  writeFileSync(join(ws, "hooks.json"), "[]");
  const checks = checkConfigFiles(ws);
  const byName = new Map(checks.map((c) => [c.name, c]));
  assert.equal(byName.get("Config jobs.json").ok, false);
  assert.match(byName.get("Config jobs.json").detail, /invalid JSON/);
  assert.equal(byName.get("Config hooks.json").ok, true);
  const absent = byName.get("Config connectors.json");
  assert.equal(absent.ok, true);
  assert.match(absent.detail, /not present/);
});

test("runDoctor prints one [ok]/[NG] line per check and aggregates", async () => {
  writeFileSync(join(ws, "jobs.json"), "[]"); // repair the broken file above
  const lines = [];
  const { ok, checks } = await runDoctor({
    env: { LLM_MODEL: "mock" },
    out: (line) => lines.push(line),
  });
  assert.equal(ok, true);
  assert.equal(lines.length, checks.length + 1); // + the summary line
  for (const line of lines.slice(0, -1)) assert.match(line, /^\[ok\] /);
  assert.match(lines.at(-1), /all checks passed/);
});

test("runDoctor reports NG (and fails overall) without leaking secrets", async () => {
  const lines = [];
  const { ok } = await runDoctor({
    env: {
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "sk-sentinel-secret",
      // LLM_MODEL missing -> NG
    },
    out: (line) => lines.push(line),
  });
  assert.equal(ok, false);
  assert.ok(lines.some((l) => l.startsWith("[NG] LLM configuration")));
  const all = lines.join("\n");
  assert.ok(!all.includes("sk-sentinel-secret"));
  assert.ok(!all.includes("example.invalid"));
  assert.match(lines.at(-1), /FAILED/);
});

test("runDoctor probes a configured MCP server with the fake fixture", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/fake-mcp-server.js", import.meta.url));
  writeFileSync(
    join(ws, "connectors.json"),
    JSON.stringify({
      servers: [{ name: "fake", command: process.execPath, args: [fixture] }],
    }),
  );
  const lines = [];
  const { ok } = await runDoctor({
    env: { LLM_MODEL: "mock" },
    out: (line) => lines.push(line),
  });
  assert.equal(ok, true);
  const mcpLine = lines.find((l) => l.includes('MCP server "fake"'));
  assert.ok(mcpLine);
  assert.match(mcpLine, /^\[ok\] /);
  assert.match(mcpLine, /initialize ok/);
});
