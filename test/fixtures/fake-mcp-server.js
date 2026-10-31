#!/usr/bin/env node
// A tiny fake MCP server used by test/mcp.test.js. Speaks newline-delimited
// JSON-RPC 2.0 on stdio and exposes a single `echo` tool: tools/list
// returns it, tools/call returns its `text` argument back.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the `text` argument.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification: nothing to answer
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "0.0.1" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
    }
  } else {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
});
rl.on("close", () => process.exit(0));
