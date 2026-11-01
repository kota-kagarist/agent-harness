// Saved permissions: rules persist in workspace/permissions.json, the
// approval gate honors them before prompting, and deny beats allow.
// Uses a temporary workspace; no network.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-perms-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

const { loadPermissions, permissionFor, permissionsPath, savePermission } =
  await import("../src/permissions.js");
const { checkApproval } = await import("../src/approval.js");

const gated = (name) => ({ name, requiresApproval: true });

test("no rules file means no saved ruling", () => {
  assert.deepEqual(loadPermissions(), { allow: [], deny: [] });
  assert.equal(permissionFor("anything"), null);
});

test("a saved allow persists to disk and survives a reload", async () => {
  savePermission("tool_alpha", "allow");
  assert.ok(existsSync(permissionsPath()));
  const onDisk = JSON.parse(readFileSync(permissionsPath(), "utf8"));
  assert.deepEqual(onDisk.allow, ["tool_alpha"]);
  // Fresh read from disk (what a new process would see).
  assert.equal(permissionFor("tool_alpha", loadPermissions()), "allow");
  // The gate lets it through without ever asking.
  const ask = async () => {
    throw new Error("ask must not be called for a saved allow");
  };
  assert.equal(await checkApproval(gated("tool_alpha"), {}, ask), true);
});

test("deny wins over allow when a tool is in both lists", async () => {
  writeFileSync(
    permissionsPath(),
    JSON.stringify({ allow: ["tool_beta"], deny: ["tool_beta"] }),
    "utf8",
  );
  assert.equal(permissionFor("tool_beta"), "deny");
  assert.equal(await checkApproval(gated("tool_beta"), {}, async () => true), false);
});

test("saving a decision moves the tool out of the opposite list", () => {
  savePermission("tool_gamma", "allow");
  assert.equal(permissionFor("tool_gamma"), "allow");
  const rules = savePermission("tool_gamma", "deny");
  assert.equal(permissionFor("tool_gamma"), "deny");
  assert.ok(!rules.allow.includes("tool_gamma"));
  assert.deepEqual(loadPermissions().deny, ["tool_beta", "tool_gamma"]);
});

test("without a saved rule the gate still prompts, then falls back", async () => {
  assert.equal(await checkApproval(gated("tool_delta"), {}, async () => true), true);
  assert.equal(await checkApproval(gated("tool_delta"), {}, async () => false), false);
  // Unattended with no rule: denied by default, as before.
  assert.equal(await checkApproval(gated("tool_delta"), {}, null), false);
});

test("ungated tools always pass, rules or not", async () => {
  const open = { name: "tool_beta", requiresApproval: false }; // denied above
  assert.equal(await checkApproval(open, {}, null), true);
});
