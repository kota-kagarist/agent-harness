# agent-harness

A minimal, hackable harness for a personal AI agent — the layer *around* the
model that turns a chat model into an agent that remembers, acts, and runs on
a schedule.

This is **not** a model. It is the orchestration layer: an agent loop with
tool calls, persistent memory kept as plain Markdown files, an approval gate
for consequential actions, a job runner for recurring work, file-change
hooks for event-driven work, goals tracked as files, sub-agent
delegation, conversation compaction, on-demand skills, resumable sessions,
streaming responses, external tools via MCP connectors, and a notification
outbox so background work can reach you. Bring your own LLM API (any
OpenAI-compatible endpoint, e.g. Meta Model API).

## Why

Personal agents (the kind that brief you every morning, remember your
preferences across weeks, and prepare work before you ask) are mostly
*plumbing*:

- a loop that lets the model call tools and observe results,
- memory that survives the conversation, in files a human can read and edit,
- schedules that wake the agent up without a human prompt,
- approval gates so irreversible actions (sending, deleting, executing)
  never happen silently.

This repo implements those pieces in dependency-free Node.js ESM
(~1,900 lines) so you can read the whole thing in one sitting and bend it to
your own use.

## Quickstart

```sh
git clone https://github.com/kota-kagarist/agent-harness.git
cd agent-harness
cp .env.example .env   # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm start              # interactive chat
```

No API key yet? Run the built-in mock provider to see the loop work
end to end (it exercises a real tool call):

```sh
LLM_MODEL=mock npm start -- --once "What time is it? Use the tool."
```

## How it works

```
 src/
   config.js    env-based configuration
   llm.js       OpenAI-compatible chat client, SSE streaming (+ mock provider)
   memory.js    loads IDENTITY.md / USER.md / MEMORY.md into the prompt
   tools.js     tool registry (files, commands, delegate, memory_search,
                load_skill, goals, todo_write, notify, fetch_url, + MCP tools)
   approval.js  approval gate for consequential tools
   agent.js     the agent loop
   subagent.js  runs a subtask in a fresh conversation (depth capped at 1)
   compact.js   summarizes old turns when history outgrows the token budget
   skills.js    discovers workspace/skills/*/SKILL.md packs
   session.js   saves/loads history as workspace/sessions/<id>.json,
                appends daily session notes to workspace/memory/
   jobs.js      job runner: interval / daily / runonce, persisted run state;
                each tick also evaluates hooks
   hooks.js     event-driven file-change hooks (state in hooks-state.json)
   goals.js     goals as workspace/goals/<slug>/GOAL.md files
   doctor.js    environment self-check behind --doctor
   scheduler.js v0.1 entry point, now a shim over jobs.js
   mcp.js       MCP client: spawns stdio servers from connectors.json
   outbox.js    notification queue at workspace/outbox.jsonl
   index.js     CLI (interactive chat, --once, --session <id>, --outbox,
                --goals, --doctor)
 examples/
   workspace/   starter memory files — copy to ./workspace and edit
   skills/      an example SKILL.md pack
   jobs.example.json / schedules.example.json / connectors.example.json /
   hooks.example.json
```

### Memory as files

The agent's long-term memory is just Markdown in a workspace directory:

- `IDENTITY.md` — who the agent is (name, vibe)
- `USER.md` — who you are
- `MEMORY.md` — durable facts, preferences, commitments

They are read into the system prompt on every run. The agent can update
`MEMORY.md` with the `write_file` tool (gated by approval), and you can edit
the files yourself at any time. No database, no embeddings required to start.
For anything beyond the always-loaded `MEMORY.md`, the `memory_search` tool
searches `MEMORY.md` plus `workspace/memory/*.md` by keyword and returns
matching lines with file names and line numbers.

### Approval gate

Tools are marked `requiresApproval` when they change the world
(`write_file`, `run_command`). In interactive mode the CLI asks before each
such call. Non-interactive runs (jobs, `--once`) deny gated tools
unless `AGENT_ALLOW_UNATTENDED=1` is set — safe by default.

### Sub-agent delegation

The `delegate` tool hands a self-contained task to a sub-agent running with
a fresh conversation; only its final answer comes back, so the parent's
context stays focused. Nesting is capped at depth 1 (the child runs without
`delegate`), and the approval gate is inherited from the parent. The mock
provider understands `DELEGATE: <task>` in a prompt, so delegation can be
smoke-tested without an API key.

### Compaction

History size is estimated as characters / 4. When it passes
`AGENT_COMPACT_THRESHOLD` (default 24000), the oldest turns are replaced by
a single LLM-written summary message; the split is made at a user message
so tool calls and their results are never separated. With the mock provider
a fixed stand-in summary is used.

### Skills

A skill is a directory `workspace/skills/<name>/SKILL.md` with optional
frontmatter (`name`, `description`). Only the name + description list is
injected into the system prompt; the agent loads the full text on demand
with the `load_skill` tool. See `examples/skills/example-skill/`.

### Sessions and streaming

`--session <id>` (with both interactive chat and `--once`) loads and saves
the conversation history at `workspace/sessions/<id>.json`, so chats can be
resumed. Interactive mode streams the model's text as it arrives (SSE,
including streamed tool calls); if streaming fails it falls back to a plain
completion. The mock provider does not stream.

When a session ends (interactive exit, or after `--once --session`), a
short summary is appended to that day's memory note at
`workspace/memory/<YYYY-MM-DD>.md` (local date) under a
`## HH:MM セッション要約` heading. The summary reuses the compaction
summarizer; with the mock provider an excerpt of the last request and reply
is recorded instead. Because the notes live under `memory/`, `memory_search`
finds them later — this is how the agent remembers what happened on a given
day without loading full transcripts into the prompt.

### Web fetch

The read-only `fetch_url` tool fetches an http(s) URL and returns its text:
HTML is reduced to plain text (script/style blocks dropped, tags stripped),
anything else comes back raw, and the result is truncated to 4000
characters. No approval needed — it cannot change anything.

### Connectors (MCP)

External tools plug in through the [Model Context
Protocol](https://modelcontextprotocol.io). Declare stdio servers in
`workspace/connectors.json` (see `examples/connectors.example.json`):

```json
{
  "servers": [
    { "name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  ]
}
```

On the first agent run, each server is spawned, the MCP `initialize`
handshake runs, and its tools are registered as `mcp__<server>__<tool>`.
Because a remote tool's effects are unknown, every MCP tool passes through
the approval gate. A missing `connectors.json` or a server that fails to
start never breaks the agent — it simply runs without those tools.

This is also where **browser control** plugs in: point a server entry at a
browser MCP server (e.g. Playwright MCP above) and the agent gains browser
tools through the same path — no browser code lives in the harness itself.

### Notifications (outbox)

Background work needs a way to reach you without interrupting you. The
outbox is a JSON Lines queue at `workspace/outbox.jsonl`; each record is
`{ id, createdAt, text, source, delivered }`. The `notify` tool lets the
agent queue a message (`source: "agent"`), and job results are queued
automatically (`source: "job:<name>"`). The interactive CLI shows
undelivered notifications when it starts and after each turn, then marks
them delivered. To peek without marking anything:

```sh
node src/index.js --outbox
```

### Jobs

Copy `examples/jobs.example.json` to `workspace/jobs.json`, edit, then:

```sh
npm run schedule
```

Each job runs its prompt through the agent when due:

- `interval` — every `everyMinutes` minutes
- `daily` — once per day at/after `time` (`"HH:MM"` local)
- `runonce` — once at/after the ISO datetime `at`, then disabled

Run state (`lastRun`, `runCount`) persists in `workspace/jobs-state.json`,
so restarts don't re-run finished jobs. The v0.1 `schedules.json` format is
still read as interval jobs when `jobs.json` is absent. For production,
run it under systemd/pm2 or call `--once` from real cron.

### Hooks

Jobs are time-driven; hooks are event-driven. Declare them in
`workspace/hooks.json` (see `examples/hooks.example.json`):

```json
[
  { "name": "inbox-watch", "type": "file", "path": "inbox.md",
    "prompt": "inbox.md changed — summarize what is new.", "enabled": true }
]
```

On every scheduler tick (30s) each file hook compares the watched file's
mtime with the last check in `workspace/hooks-state.json`. A change runs
the hook's prompt through the agent once and queues the reply in the outbox
(`source: "hook:<name>"`). The first observation of a file only records a
baseline and never fires, so starting the runner does not replay old
changes.

### Goals

Durable outcomes live as files too: one directory per goal at
`workspace/goals/<slug>/GOAL.md` with frontmatter (`title`, `status`:
`active` | `completed`, `created`) and a body holding the description and a
dated progress log. The agent manages them with the `goal_create`,
`goal_list`, `goal_log`, and `goal_complete` tools; the slug is generated
from the title (collisions get a numeric suffix). To just look:

```sh
node src/index.js --goals
```

### Doctor

Something not working? Run the self-check — it needs no LLM configuration
and never prints secret values, only whether they are set:

```sh
node src/index.js --doctor
```

It prints one `[ok]` / `[NG]` line per check (Node version, workspace
directories, LLM variables present, JSON configs parse, each configured
MCP server answering `initialize` within 3s) and exits 1 if anything is NG.

## Roadmap

- [x] Sub-agent delegation (spawn a child agent for a subtask)
- [x] Connectors via MCP (stdio servers from workspace/connectors.json)
- [x] Conversation compaction for long sessions
- [x] Memory search (keyword; embeddings still open)
- [x] Streaming responses
- [x] Proactive notifications (outbox queue fed by jobs and the notify tool)
- [x] Browser control — via an MCP server such as Playwright MCP (see Connectors)
- [x] Hooks — event-driven file-change triggers evaluated on the job tick (v0.4)
- [x] Goals as files, with create / list / log / complete tools (v0.4)
- [x] Daily memory notes appended when a session ends (v0.4)
- [x] `--doctor` environment self-check that never prints secrets (v0.4)

## License

MIT — see [LICENSE](LICENSE).
