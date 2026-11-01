// Hooks: event-driven triggers, the complement to time-driven jobs.
// Hooks live in workspace/hooks.json:
//   [{ "name": "inbox-watch", "type": "file", "path": "inbox.md",
//      "prompt": "Summarize what changed in inbox.md.", "enabled": true }]
// A "file" hook fires when the watched file's mtime changes between
// checks: its prompt is run through the agent once and the reply is queued
// in the outbox (source "hook:<name>"). The job runner evaluates hooks on
// every tick (see jobs.js). Check state — last seen mtime and last run per
// hook — persists in workspace/hooks-state.json. The first observation of
// a file only records a baseline and never fires, so starting the runner
// does not trigger a burst of stale hooks.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { runAgent } from "./agent.js";
import { config } from "./config.js";
import { appendNotification } from "./outbox.js";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadHooks() {
  const hooks = readJson(join(config.workspace, "hooks.json"), []);
  if (!Array.isArray(hooks)) return [];
  return hooks.map((h) => ({ type: "file", enabled: true, ...h }));
}

export function loadHookState() {
  return readJson(join(config.workspace, "hooks-state.json"), {});
}

export function saveHookState(state) {
  writeFileSync(
    join(config.workspace, "hooks-state.json"),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

// Watched paths are workspace-relative and may not escape the workspace.
function watchedPath(rel) {
  const abs = resolve(config.workspace, rel);
  if (abs !== config.workspace && !abs.startsWith(config.workspace + sep)) {
    throw new Error(`Hook path escapes the workspace: ${rel}`);
  }
  return abs;
}

function mtimeOf(rel) {
  try {
    return statSync(watchedPath(rel)).mtimeMs;
  } catch {
    return null; // missing or unreadable: nothing to observe this tick
  }
}

// Evaluate every hook once. Returns the list of { name, reply } for hooks
// that fired. `runner` is injectable for tests; it defaults to the real
// agent loop (same signature as runAgent's return value is expected).
export async function evaluateHooks(now = new Date(), { runner = runAgent } = {}) {
  const hooks = loadHooks();
  const state = loadHookState();
  const fired = [];
  let stateChanged = false;

  for (const hook of hooks) {
    if (hook.enabled === false || hook.type !== "file" || !hook.path) continue;
    const mtime = mtimeOf(hook.path);
    if (mtime === null) continue;
    const entry = state[hook.name];

    if (!entry) {
      // First observation: baseline only, never fire.
      state[hook.name] = { path: hook.path, mtimeMs: mtime, lastRun: null };
      stateChanged = true;
      continue;
    }
    if (entry.mtimeMs === mtime) continue;

    // The file changed since the previous check: fire once.
    entry.mtimeMs = mtime;
    entry.lastRun = now.toISOString();
    state[hook.name] = entry;
    stateChanged = true;
    try {
      const { reply } = await runner(hook.prompt);
      fired.push({ name: hook.name, reply });
      // Queue the result for the user (see outbox.js); failing to queue
      // must not fail the hook itself.
      try {
        await appendNotification(reply, { source: `hook:${hook.name}` });
      } catch (err) {
        console.error(`hook ${hook.name}: could not queue notification: ${err.message}`);
      }
    } catch (err) {
      console.error(`hook ${hook.name} failed: ${err.message}`);
      fired.push({ name: hook.name, reply: `Error: ${err.message}` });
    }
  }

  if (stateChanged) saveHookState(state);
  return fired;
}
