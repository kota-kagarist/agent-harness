// Session persistence: conversation history as JSON files under
// workspace/sessions/<id>.json, so a chat can be resumed later with
// --session <id>. The file stores { id, updatedAt, messages }; loadSession
// also accepts a bare array of messages for forward/backward simplicity.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

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
