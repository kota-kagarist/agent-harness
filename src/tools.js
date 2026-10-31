// Tool registry. Each tool declares its JSON schema, whether it needs
// approval (changes the world / is hard to undo), and its implementation.
// Paths are confined to the workspace directory.
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

function safePath(rel) {
  const abs = resolve(config.workspace, rel);
  if (abs !== config.workspace && !abs.startsWith(config.workspace + sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

export const tools = [
  {
    name: "get_current_time",
    description: "Get the current date and time (ISO 8601, local timezone).",
    parameters: { type: "object", properties: {} },
    requiresApproval: false,
    run: async () => new Date().toString(),
  },
  {
    name: "list_dir",
    description: "List files in a workspace-relative directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, '.' for root" } },
      required: ["path"],
    },
    requiresApproval: false,
    run: async ({ path }) => (await readdir(safePath(path))).join("\n"),
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    requiresApproval: false,
    run: async ({ path }) => readFile(safePath(path), "utf8"),
  },
  {
    name: "write_file",
    description:
      "Write a UTF-8 text file inside the workspace (creates or overwrites). " +
      "Use this to update MEMORY.md when you learn something durable.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    requiresApproval: true,
    run: async ({ path, content }) => {
      await writeFile(safePath(path), content, "utf8");
      return `Wrote ${content.length} bytes to ${path}`;
    },
  },
  {
    name: "run_command",
    description:
      "Run a command (no shell) with arguments, working directory = workspace. " +
      "Timeout 30s. Output is truncated to 4000 characters.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
    requiresApproval: true,
    run: async ({ command, args = [] }) => {
      const { stdout, stderr } = await run(command, args, {
        cwd: config.workspace,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return (stdout + stderr).slice(0, 4000) || "(no output)";
    },
  },
];

export function toolSchemas() {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name) {
  return tools.find((t) => t.name === name);
}

// Keep join imported for future tools; referenced to avoid tree-shaking confusion in plain node.
void join;
