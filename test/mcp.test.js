// MCP connectors: a real stdio connection to the fake server in
// test/fixtures, against a temporary workspace. A second, nonexistent
// server in the same config proves a broken server never blocks the rest.
// No external network — the "servers" are local child processes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-mcp-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const fixture = fileURLToPath(new URL("./fixtures/fake-mcp-server.js", import.meta.url));
writeFileSync(
  join(ws, "connectors.json"),
  JSON.stringify({
    servers: [
      { name: "fake", command: process.execPath, args: [fixture] },
      { name: "broken", command: "agent-harness-command-that-does-not-exist" },
    ],
  }),
);

const { closeMcp, ensureMcpConnected, getMcpTools, loadConnectorConfig } =
  await import("../src/mcp.js");
const { findTool, toolSchemas } = await import("../src/tools.js");

after(() => closeMcp());

test("loadConnectorConfig reads the servers list", () => {
  const servers = loadConnectorConfig();
  assert.equal(servers.length, 2);
  assert.equal(servers[0].name, "fake");
});

test("no MCP tools are registered before connecting", () => {
  assert.deepEqual(getMcpTools(), []);
});

test("ensureMcpConnected registers the good server's tools despite a broken one", async () => {
  await ensureMcpConnected();
  assert.deepEqual(
    getMcpTools().map((t) => t.name),
    ["mcp__fake__echo"],
  );
  // Connecting again is a no-op (same tools, no duplicates).
  await ensureMcpConnected();
  assert.equal(getMcpTools().length, 1);
});

test("MCP tools appear in schemas and are approval-gated", () => {
  const schema = toolSchemas().find((s) => s.function.name === "mcp__fake__echo");
  assert.ok(schema);
  assert.equal(schema.function.parameters.required[0], "text");
  const tool = findTool("mcp__fake__echo");
  assert.ok(tool);
  assert.equal(tool.requiresApproval, true);
});

test("tools/call round-trips through the real server process", async () => {
  const tool = findTool("mcp__fake__echo");
  const out = await tool.run({ text: "hello mcp" });
  assert.equal(out, "echo: hello mcp");
});
