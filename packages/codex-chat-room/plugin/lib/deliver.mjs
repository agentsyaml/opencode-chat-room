// Delivery: turn unread central inbox items into Codex queued user messages.
// Codex exposes the supported path through `codex queue`, which appends to the
// thread's persisted queue and resumes an unloaded thread when asked to.
import { spawn } from "node:child_process";
import { request, sessionIDFor, timeOf } from "./center.mjs";

const MAX_MESSAGES = 20;
const MAX_TEXT = 300;

function visibleText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function formatPrompt(room, items) {
  const context = room.roomKind === "direct"
    ? `Direct conversation in room ${room.roomName} (${room.roomId})`
    : `New messages in room ${room.roomName} (${room.roomId})`;
  const lines = [];
  for (const item of items.slice(-MAX_MESSAGES)) {
    const text = visibleText(item.text);
    const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\u2026` : text;
    if (item.answerQuestionExcerpt) lines.push(`  \u21b3 Answer to: \u201c${visibleText(item.answerQuestionExcerpt)}\u201d`);
    lines.push(`- [${timeOf(item.createdAt)}] ${item.senderId}: ${body}`);
  }
  return `<notification>\n${context}:\n${lines.join("\n")}\n</notification>`;
}

export function queueArgs(threadID, prompt, bin = process.env.CHAT_ROOM_CODEX_BIN || "codex") {
  return [bin, ["queue", "--thread", threadID, "--message", prompt, "--resume"]];
}

export function runQueue(threadID, prompt, options = {}) {
  const [bin, args] = queueArgs(threadID, prompt, options.bin);
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawnFn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stderr: String(error?.message ?? error) });
      return;
    }
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    child.on("error", (error) => resolve({ code: -1, stderr: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr: stderr.trim() }));
  });
}

export async function deliverOnce(cfg, threadID, options = {}) {
  const sessionID = sessionIDFor(threadID);
  const timeout = options.timeoutMs ?? 10000;
  const result = await request(
    cfg,
    `/inbox?sessionID=${encodeURIComponent(sessionID)}&excludeSelf=1&timeout=${timeout}`,
    "GET",
    undefined,
    timeout + 15000,
  );
  if (!result.member) return { delivered: 0, failed: 0 };
  const queuedTs = result.queuedTs ?? {};
  const rooms = new Map();
  for (const item of result.items || []) {
    if (item.createdAt <= (queuedTs[item.roomId] ?? 0)) continue;
    const group = rooms.get(item.roomId) ?? { roomId: item.roomId, roomName: item.roomName, roomKind: item.roomKind, items: [] };
    if (group.items.length < MAX_MESSAGES) group.items.push(item);
    rooms.set(item.roomId, group);
  }
  let delivered = 0;
  let failed = 0;
  for (const room of rooms.values()) {
    const prompt = formatPrompt(room, room.items);
    const queued = await runQueue(threadID, prompt, options);
    if (queued.code !== 0) {
      failed++;
      (options.log ?? console.error)(`[codex-chat-room] queue failed for ${room.roomId}: ${queued.stderr || `exit ${queued.code}`}`);
      continue;
    }
    const maxTs = room.items.reduce((max, item) => Math.max(max, item.createdAt), 0);
    try {
      await request(cfg, "/queued", "POST", { roomId: room.roomId, sessionID, ts: maxTs });
      delivered++;
    } catch (error) {
      // shortcut: at-least-once delivery — a failed watermark update repeats
      // the queued prompt on the next poll; upgrade if duplicates become a problem
      failed++;
      (options.log ?? console.error)(`[codex-chat-room] watermark update failed for ${room.roomId}: ${error.message}`);
    }
  }
  return { delivered, failed };
}

export function startDelivery({ cfg, threadID, log = console.error, spawnFn, timeoutMs = 15000 }) {
  let stopped = false;
  let failures = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async () => {
    while (!stopped) {
      try {
        const result = await deliverOnce(cfg, threadID, { log, spawnFn, timeoutMs });
        failures = result.failed > 0 ? failures + 1 : 0;
        if (result.failed > 0) await wait(Math.min(5000 * 2 ** failures, 60000));
      } catch (error) {
        failures++;
        log(`[codex-chat-room] delivery poll failed: ${error.message}`);
        await wait(Math.min(5000 * 2 ** failures, 60000));
      }
    }
  };
  void run();
  return { stop() { stopped = true; } };
}