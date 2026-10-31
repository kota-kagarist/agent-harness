// Outbox: a JSON Lines queue of notifications for the user, stored at
// workspace/outbox.jsonl — one record per line:
//   { "id": "...", "createdAt": "ISO datetime", "text": "...",
//     "source": "agent" | "job:<name>", "delivered": false }
// Jobs and the agent append with appendNotification (the `notify` tool);
// the interactive CLI shows undelivered entries and marks them delivered.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

function outboxPath() {
  return join(config.workspace, "outbox.jsonl");
}

export async function appendNotification(text, { source = "agent" } = {}) {
  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text: String(text),
    source,
    delivered: false,
  };
  await mkdir(config.workspace, { recursive: true });
  await appendFile(outboxPath(), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function listNotifications() {
  const path = outboxPath();
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip corrupt lines rather than losing the whole queue.
    }
  }
  return out;
}

export async function listUndelivered() {
  return (await listNotifications()).filter((n) => !n.delivered);
}

export async function markDelivered(ids) {
  const wanted = new Set(ids);
  const all = await listNotifications();
  let changed = false;
  for (const n of all) {
    if (wanted.has(n.id) && !n.delivered) {
      n.delivered = true;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(
      outboxPath(),
      `${all.map((n) => JSON.stringify(n)).join("\n")}\n`,
      "utf8",
    );
  }
  return all.filter((n) => wanted.has(n.id));
}
