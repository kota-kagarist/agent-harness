# agent-harness

A minimal, hackable harness for a personal AI agent — the layer *around* the
model that turns a chat model into an agent that remembers, acts, and runs on
a schedule.

This is **not** a model. It is the orchestration layer: an agent loop with
tool calls, persistent memory kept as plain Markdown files, an approval gate
for consequential actions, and a tiny scheduler for recurring jobs. Bring
your own LLM API (any OpenAI-compatible endpoint, e.g. Meta Model API).

## Why

Personal agents (the kind that brief you every morning, remember your
preferences across weeks, and prepare work before you ask) are mostly
*plumbing*:

- a loop that lets the model call tools and observe results,
- memory that survives the conversation, in files a human can read and edit,
- schedules that wake the agent up without a human prompt,
- approval gates so irreversible actions (sending, deleting, executing)
  never happen silently.

This repo implements those four pieces in dependency-free Node.js ESM
(~600 lines) so you can read the whole thing in one sitting and bend it to
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
   llm.js       OpenAI-compatible chat client (+ mock provider)
   memory.js    loads IDENTITY.md / USER.md / MEMORY.md into the prompt
   tools.js     tool registry (read/write files, run commands, time, ...)
   approval.js  approval gate for consequential tools
   agent.js     the agent loop
   index.js     CLI (interactive chat, --once for one-shot)
   scheduler.js runs prompts from schedules.json on an interval
 examples/
   workspace/   starter memory files — copy to ./workspace and edit
```

### Memory as files

The agent's long-term memory is just Markdown in a workspace directory:

- `IDENTITY.md` — who the agent is (name, vibe)
- `USER.md` — who you are
- `MEMORY.md` — durable facts, preferences, commitments

They are read into the system prompt on every run. The agent can update
`MEMORY.md` with the `write_file` tool (gated by approval), and you can edit
the files yourself at any time. No database, no embeddings required to start.

### Approval gate

Tools are marked `requiresApproval` when they change the world
(`write_file`, `run_command`). In interactive mode the CLI asks before each
such call. Non-interactive runs (scheduler, `--once`) deny gated tools
unless `AGENT_ALLOW_UNATTENDED=1` is set — safe by default.

### Scheduler

Copy `examples/schedules.example.json` to `workspace/schedules.json`, edit,
then:

```sh
npm run schedule
```

Each entry runs its prompt through the agent on its interval and prints the
result — enough for a morning briefing or a periodic check. For production,
run it under systemd/pm2 or call `--once` from real cron.

## Roadmap

- [ ] Sub-agent delegation (spawn a child agent for a subtask)
- [ ] Connectors (Gmail / Calendar / GitHub via CLI or MCP)
- [ ] Conversation compaction for long sessions
- [ ] Pluggable memory search (keyword / embedding)
- [ ] Streaming responses

## License

MIT — see [LICENSE](LICENSE).
