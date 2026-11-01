// Slash commands: parseCommand is pure — known commands parse to their
// name, unknown slash-lines are flagged, and ordinary input returns
// null so it flows to the model untouched.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LLM_MODEL = "mock";

const { COMMANDS, commandHelp, parseCommand } = await import("../src/commands.js");

test("ordinary input is not a command", () => {
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("what does /tmp mean?"), null);
  assert.equal(parseCommand("   "), null);
});

test("every known command parses by name", () => {
  for (const { name } of COMMANDS) {
    assert.equal(parseCommand(`/${name}`)?.name, name);
  }
});

test("command names are case-insensitive and tolerate spaces", () => {
  assert.deepEqual(parseCommand("  /HELP  "), { name: "help", args: "" });
  assert.equal(parseCommand("/Model").name, "model");
});

test("arguments after the command are kept", () => {
  assert.deepEqual(parseCommand("/compact now please"), {
    name: "compact",
    args: "now please",
  });
});

test("an unknown slash-line is reported, not treated as input", () => {
  const cmd = parseCommand("/bogus thing");
  assert.equal(cmd.name, "unknown");
  assert.equal(cmd.command, "bogus");
  assert.equal(cmd.args, "thing");
  assert.equal(parseCommand("/").name, "unknown");
});

test("the help text lists every command", () => {
  const help = commandHelp();
  for (const { name } of COMMANDS) assert.match(help, new RegExp(`/${name}\\b`));
});
