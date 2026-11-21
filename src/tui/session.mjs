// Stable per-install session identity for the TUI. The file is written
// atomically so a crash cannot leave a half-written session behind.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_NAME = "chatroom-tui";

function readSession(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (typeof data.sessionID !== "string" || !data.sessionID) return null;
    return {
      sessionID: data.sessionID,
      name: typeof data.name === "string" && data.name ? data.name : undefined,
    };
  } catch {
    return null; // A corrupt file starts a fresh session instead of crashing.
  }
}

export function saveSession(file, session) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const data = { sessionID: session.sessionID, name: session.name };
  writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function loadSession(file, fallbackName = DEFAULT_NAME) {
  const stored = readSession(file);
  const wanted = typeof fallbackName === "string" ? fallbackName.trim().slice(0, 64) : "";
  const session = {
    sessionID: stored?.sessionID ?? randomUUID(),
    name: wanted || stored?.name || DEFAULT_NAME,
  };
  if (!stored || stored.name !== session.name) saveSession(file, session);
  return session;
}