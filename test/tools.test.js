// Tools that read the workspace (memory_search, todo_write) run against a
// temporary workspace directory — no real user files. fetch_url is tested
// against a local http server on 127.0.0.1; nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "agent-harness-tools-"));
process.env.AGENT_WORKSPACE = ws;
process.env.LLM_MODEL = "mock";

writeFileSync(join(ws, "MEMORY.md"), "# Memory\n\nThe user's cat is named Mochi.\n");
mkdirSync(join(ws, "memory", "sub"), { recursive: true });
writeFileSync(join(ws, "memory", "2026-01-01.md"), "Mochi likes tuna.\nNothing else.\n");
writeFileSync(join(ws, "memory", "sub", "deep.md"), "Deep note about Mochi.\n");

const { findTool, getTodos } = await import("../src/tools.js");

test("memory_search finds lines in MEMORY.md with file and line number", async () => {
  const out = await findTool("memory_search").run({ query: "Mochi" });
  assert.match(out, /MEMORY\.md:3: The user's cat is named Mochi\./);
  assert.match(out, /memory\/2026-01-01\.md:1: Mochi likes tuna\./);
  assert.match(out, /memory\/sub\/deep\.md:1: Deep note about Mochi\./);
});

test("memory_search is case-insensitive and reports no matches", async () => {
  const out = await findTool("memory_search").run({ query: "mochi" });
  assert.match(out, /Mochi/);
  const none = await findTool("memory_search").run({ query: "nonexistentword" });
  assert.match(none, /No matches/);
});

test("todo_write replaces and returns the session todo list", async () => {
  const out = await findTool("todo_write").run({ todos: ["first", "second"] });
  assert.equal(out, "1. first\n2. second");
  assert.deepEqual(getTodos(), ["first", "second"]);
  const cleared = await findTool("todo_write").run({ todos: [] });
  assert.equal(cleared, "(todo list is empty)");
  assert.deepEqual(getTodos(), []);
});

// Serves a small HTML page and an over-long plain-text page, locally only.
async function withServer(fn) {
  const server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><style>.x { color: red; }</style>" +
          "<script>var secret = 1;</script></head>" +
          "<body><h1>Hello</h1><p>World &amp; friends</p></body></html>",
      );
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("a".repeat(6000));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("fetch_url strips scripts, styles and tags from HTML", async () => {
  await withServer(async (base) => {
    const out = await findTool("fetch_url").run({ url: `${base}/page` });
    assert.equal(out, "Hello World & friends");
  });
});

test("fetch_url returns plain text truncated to 4000 characters", async () => {
  await withServer(async (base) => {
    const out = await findTool("fetch_url").run({ url: `${base}/long` });
    assert.equal(out.length, 4000);
  });
});

test("fetch_url rejects non-http(s) URLs", async () => {
  await assert.rejects(
    () => findTool("fetch_url").run({ url: "file:///etc/passwd" }),
    /Only http\(s\) URLs/,
  );
});
