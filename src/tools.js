// Tool registry. Each tool declares its JSON schema, whether it needs
// approval (changes the world / is hard to undo), and its implementation.
// Paths are confined to the workspace directory. Tool implementations
// receive (args, ctx) where ctx carries { ask, depth } from the agent loop.
// Tools from MCP servers (see mcp.js) are merged into toolSchemas/findTool
// dynamically once connected.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { getMcpTools } from "./mcp.js";
import { appendNotification } from "./outbox.js";
import { loadSkill } from "./skills.js";

const run = promisify(execFile);

// The in-session todo list, managed through the todo_write tool.
let sessionTodos = [];

export function getTodos() {
  return [...sessionTodos];
}

async function listMarkdownFiles(dir, prefix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFiles(join(dir, entry.name), rel)));
    } else if (entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

function safePath(rel) {
  const abs = resolve(config.workspace, rel);
  if (abs !== config.workspace && !abs.startsWith(config.workspace + sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

// fetch_url: read a page as plain text. HTML is reduced by dropping
// script/style blocks and stripping tags; anything else is returned raw.
// Read-only and capped, so it is not approval-gated.
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_CHARS = 4000;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUrlText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs can be fetched: ${url}`);
  }
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const body = await res.text();
  const type = res.headers.get("content-type") ?? "";
  const text =
    type.includes("html") || /^\s*</.test(body) ? htmlToText(body) : body.trim();
  return text.slice(0, FETCH_MAX_CHARS) || "(empty response)";
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
  {
    name: "delegate",
    description:
      "Delegate a self-contained subtask to a sub-agent with a fresh " +
      "conversation. The sub-agent has the same tools (except delegate) " +
      "and returns only its final answer. Use it to keep your own context " +
      "focused, e.g. research or a big file scan.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task for the sub-agent" },
      },
      required: ["task"],
    },
    requiresApproval: false,
    run: async ({ task }, ctx = {}) => {
      if ((ctx.depth ?? 0) >= 1) {
        return "Error: delegate is not available inside a sub-agent.";
      }
      const { runSubagent } = await import("./subagent.js");
      return runSubagent(task, {
        ask: ctx.ask ?? null,
        depth: (ctx.depth ?? 0) + 1,
      });
    },
  },
  {
    name: "memory_search",
    description:
      "Search long-term memory (MEMORY.md and workspace/memory/*.md) for a " +
      "keyword. Returns matching lines with file names and line numbers.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    requiresApproval: false,
    run: async ({ query }) => {
      const q = String(query).toLowerCase();
      const files = [];
      if (existsSync(join(config.workspace, "MEMORY.md"))) files.push("MEMORY.md");
      const memDir = join(config.workspace, "memory");
      if (existsSync(memDir)) {
        files.push(...(await listMarkdownFiles(memDir, "memory")));
      }
      const hits = [];
      for (const rel of files) {
        const text = await readFile(join(config.workspace, rel), "utf8");
        text.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(q)) {
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
        if (hits.length >= 50) break;
      }
      return hits.length ? hits.slice(0, 50).join("\n") : `No matches for "${query}".`;
    },
  },
  {
    name: "load_skill",
    description:
      "Load the full instructions of a skill listed in the system prompt " +
      "by name, then follow them.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    requiresApproval: false,
    run: async ({ name }) => loadSkill(name),
  },
  {
    name: "notify",
    description:
      "Queue a notification for the user in the outbox " +
      "(workspace/outbox.jsonl). Use it for results the user should see " +
      "later, e.g. finished background work. Undelivered notifications " +
      "are shown in the interactive CLI; this does not interrupt the user.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    requiresApproval: false,
    run: async ({ text }) => {
      const record = await appendNotification(text, { source: "agent" });
      return `Queued notification (${record.id}).`;
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch an http(s) URL and return its text content (HTML is stripped " +
      "to plain text), truncated to 4000 characters. Read-only.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    requiresApproval: false,
    run: async ({ url }) => fetchUrlText(url),
  },
  {
    name: "todo_write",
    description:
      "Replace the session's todo list with the given items and return the " +
      "current list. Use it to plan and track multi-step work.",
    parameters: {
      type: "object",
      properties: {
        todos: { type: "array", items: { type: "string" } },
      },
      required: ["todos"],
    },
    requiresApproval: false,
    run: async ({ todos }) => {
      sessionTodos = [...todos];
      return sessionTodos.length
        ? sessionTodos.map((t, i) => `${i + 1}. ${t}`).join("\n")
        : "(todo list is empty)";
    },
  },
];

export function toolSchemas(exclude = []) {
  return [...tools, ...getMcpTools()]
    .filter((t) => !exclude.includes(t.name))
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

export function findTool(name) {
  return tools.find((t) => t.name === name) ?? getMcpTools().find((t) => t.name === name);
}
