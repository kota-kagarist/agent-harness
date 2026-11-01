// Session persistence: conversation history as JSON files under
// workspace/sessions/<id>.json, so a chat can be resumed later with
// --session <id>. The file stores { id, updatedAt, messages }; loadSession
// also accepts a bare array of messages for forward/backward simplicity.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeMessages } from "./compact.js";
import { config } from "./config.js";
import { localDate } from "./goals.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sessionPath(id) {
  if (!ID_RE.test(id) || id.includes("..")) {
    throw new Error(`Invalid session id: ${id}`);
  }
  return join(config.workspace, "sessions", `${id}.json`);
}

export async function loadSession(id) {
  const path = sessionPath(id);
  if (!existsSync(path)) return [];
  const data = JSON.parse(await readFile(path, "utf8"));
  if (Array.isArray(data)) return data;
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function saveSession(id, history) {
  const path = sessionPath(id);
  await mkdir(join(config.workspace, "sessions"), { recursive: true });
  const record = { id, updatedAt: new Date().toISOString(), messages: history };
  await writeFile(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}

function excerpt(text, max = 200) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// End-of-session daily note: summarize the session and append it to
// workspace/memory/<YYYY-MM-DD>.md (local date) under a
// "## HH:MM セッション要約" heading, so memory_search can find it later.
// The summary reuses the compaction summarizer; with the mock provider
// (which cannot summarize) an excerpt of the last request and reply is
// used instead. Returns the note path, or null when there is nothing
// worth recording.
export async function endSessionNote(history, { now = new Date() } = {}) {
  const messages = (history ?? []).filter((m) => typeof m.content === "string");
  if (!messages.length) return null;

  let summary;
  if (config.model === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastUser && !lastReply) return null;
    const lines = [];
    if (lastUser) lines.push(`- 依頼: ${excerpt(lastUser.content)}`);
    if (lastReply) lines.push(`- 返答: ${excerpt(lastReply.content)}`);
    summary = lines.join("\n");
  } else {
    summary = (await summarizeMessages(history)).trim();
    if (!summary) return null;
  }

  const dir = join(config.workspace, "memory");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${localDate(now)}.md`);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const lead = existsSync(path) ? "\n" : "";
  await appendFile(path, `${lead}## ${hh}:${mm} セッション要約\n\n${summary}\n`, "utf8");
  return path;
}
