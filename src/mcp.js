// MCP connectors: external tool servers spoken to over stdio using the
// Model Context Protocol (JSON-RPC 2.0, one JSON message per line).
// Servers are declared in workspace/connectors.json:
//   { "servers": [{ "name": "fs", "command": "npx",
//                   "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
//                   "env": {} }] }
// On first use each server is spawned, the initialize handshake runs, and
// its tools are registered as `mcp__<server>__<tool>`. Because a remote
// tool's effects are unknown, every MCP tool goes through the approval
// gate. A missing config file or a server that fails to start never breaks
// the agent — it just runs without those tools.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { config } from "./config.js";

const REQUEST_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2024-11-05";

const clients = []; // connected McpClient instances
let connectPromise = null;

export function loadConnectorConfig() {
  const path = join(config.workspace, "connectors.json");
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

class McpClient {
  constructor(server) {
    this.server = server;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.child = null;
    this.toolEntries = [];
  }

  async connect() {
    const { command, args = [], env = {} } = this.server;
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    // A dead server must fail its in-flight requests at once, not after
    // the per-request timeout.
    const fail = (err) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code) =>
      fail(new Error(`MCP server "${this.server.name}" exited (code ${code})`)),
    );
    child.stdin.on("error", fail);
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));

    const init = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-harness", version: "0.3.0" },
      },
      INIT_TIMEOUT_MS,
    );
    this.notify("notifications/initialized");
    const { tools = [] } = await this.request("tools/list", {});
    this.toolEntries = tools.map((def) => this.toToolEntry(def));
    return init;
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // tolerate non-JSON noise on the server's stdout
    }
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code}`));
      } else {
        entry.resolve(msg.result);
      }
    } else if (msg.method && msg.id !== undefined) {
      // Server-initiated request: only ping is supported.
      if (msg.method === "ping") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
    }
    // Notifications from the server are ignored.
  }

  send(obj) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP request "${method}" to "${this.server.name}" timed out`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // A notification that cannot be sent is not fatal.
    }
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", {
      name,
      arguments: args ?? {},
    });
    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
    if (result?.isError) throw new Error(text || `MCP tool ${name} failed`);
    return text || "(no output)";
  }

  toToolEntry(def) {
    return {
      name: `mcp__${this.server.name}__${def.name}`,
      description:
        def.description ?? `MCP tool ${def.name} from server "${this.server.name}".`,
      parameters: def.inputSchema ?? { type: "object", properties: {} },
      requiresApproval: true, // effects are unknown — always gated
      run: (args) => this.callTool(def.name, args),
    };
  }

  close() {
    try {
      this.child?.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
  }
}

// Connect every configured server once per process. Servers that fail to
// start are logged and skipped; with no connectors.json this is a no-op.
export function ensureMcpConnected() {
  connectPromise ??= (async () => {
    for (const server of loadConnectorConfig()) {
      const client = new McpClient(server);
      try {
        await client.connect();
        clients.push(client);
      } catch (err) {
        console.error(`mcp: server "${server.name}" unavailable: ${err.message}`);
        client.close();
      }
    }
  })();
  return connectPromise;
}

// Tool entries for every connected server, in the same shape tools.js uses.
export function getMcpTools() {
  return clients.flatMap((c) => c.toolEntries);
}

export function closeMcp() {
  for (const client of clients.splice(0)) client.close();
  connectPromise = null;
}
