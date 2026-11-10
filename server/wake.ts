import os from "node:os";
import type { Message } from "../src/room-service";
import { formatNotificationLines, formatServeWakePrompt, readQuestionExcerpt, readState, writeState, type RegistryEntry } from "../src/store";
import { clearPendingAdmission, getOrCreatePendingAdmission, markPendingAdmissionAdmitted, pendingAdmission, rejectPendingAdmission, type QueueItem } from "../src/queue";
import { sendAsyncNotification } from "../src/queue-transport";
import { readInbox, type InboxItem } from "./inbox";
import { explicitlyAddresses } from "../src/mentions";

const wakeClaims = new Map<string, number>();
const activeSessions = new Map<string, number>();
const WAKE_CLAIM_MS = 30_000;
const WAKE_INACTIVE_MS = 2 * 60_000;

export function claimWake(id: string): boolean {
  if (Date.now() - (wakeClaims.get(id) ?? 0) < WAKE_CLAIM_MS) return false;
  wakeClaims.set(id, Date.now());
  return true;
}
export function touchActive(id: string): void { if (id) activeSessions.set(id, Date.now()); }

export async function wakeMentionedSessions(
  serveWakeUrl: string, roomId: string, roomName: string, text: string,
  senderSessionID: string, triggeringMessage: Message,
): Promise<void> {
  if (!serveWakeUrl) return;
  const { roomKind, reg } = await readState((svc, registry) => ({
    roomKind: svc.getRoom(roomId).kind ?? "group",
    reg: registry[roomId] ?? {},
  }));
  for (const [sid, entry] of Object.entries(reg)) {
    if (entry.protocol === "v2" || !explicitlyAddresses(triggeringMessage, entry.name, sid, roomKind) || entry.host !== os.hostname() ||
      (activeSessions.get(sid) ?? 0) > Date.now() - WAKE_INACTIVE_MS ||
      triggeringMessage.createdAt <= (entry.lastReadTs ?? 0) ||
      triggeringMessage.createdAt <= (entry.lastQueuedTs ?? 0) || !claimWake(sid)) continue;
    void deliverWake(serveWakeUrl, sid, roomId, roomName, roomKind, entry, triggeringMessage).catch(() => {});
  }
}

async function deliverWake(
  serveWakeUrl: string, sid: string, roomId: string, roomName: string, roomKind: "group" | "direct",
  entry: RegistryEntry, triggering: Message,
): Promise<void> {
  const inbox = await readInbox(sid, roomId, true);
  const current = await readState((_svc, registry) => registry[roomId]?.[sid]);
  if (!current || !inbox.member) return;
  const queued = Math.max(current.lastQueuedTs ?? 0, inbox.queuedTs[roomId] ?? 0);
  if (triggering.createdAt <= (current.lastReadTs ?? 0) || triggering.createdAt <= queued) return;
  const queuedItems = inbox.items.filter((item) => item.createdAt > queued);
  const trigger: InboxItem = { id: triggering.id, roomId, roomName, roomKind, senderId: triggering.senderId, text: triggering.text, createdAt: triggering.createdAt,
    ...(triggering.answerToMessageID ? { answerQuestionExcerpt: await readQuestionExcerpt(roomId, triggering.answerToMessageID) } : {}) };
  const items = queuedItems.some((item) => item.id === trigger.id)
    ? queuedItems.map((item) => item.id === trigger.id ? { ...trigger, ...item, answerQuestionExcerpt: item.answerQuestionExcerpt ?? trigger.answerQuestionExcerpt } : item)
    : [...queuedItems, trigger].sort((a, b) => a.createdAt - b.createdAt);
  const maxTs = items.reduce((max, item) => Math.max(max, item.createdAt), 0);
  const existing = pendingAdmission(sid, roomId);
  const delta = existing?.state === "admitted" && maxTs > existing.maxTs ? items.filter((item) => item.createdAt > existing.maxTs) : items;
  const confirmQueued = async (ts: number) => {
    const result = await writeState((_svc, registry) => {
    const target = registry[roomId]?.[sid];
    if (!target) return false;
    target.lastQueuedTs = Math.max(target.lastQueuedTs ?? 0, ts);
    return true;
    });
    if (result) clearPendingAdmission(sid, roomId, ts);
    return result;
  };
  if (existing?.state === "admitted" && (maxTs <= existing.maxTs || !delta.length)) {
    await confirmQueued(existing.maxTs);
    return;
  }
  const { lines, capped } = formatNotificationLines(delta);
  const prompt = roomKind === "direct"
    ? `<notification>\nNew messages in direct conversation ${roomName} (${roomId}):\n${lines.join("\n")}\n</notification>`
    : formatServeWakePrompt(roomName, roomId, lines);
  const admission = getOrCreatePendingAdmission(sid, roomId, delta as QueueItem[], prompt,
    delta.reduce((max, item) => Math.max(max, item.createdAt), 0), capped);
  const directory = entry.directory ?? process.env.OPENCODE_DIRECTORY;
  try {
    const result = await sendAsyncNotification({ serverUrl: serveWakeUrl, directory, protocol: "v1" }, sid, admission.prompt);
    if (result === "delivered") {
      markPendingAdmissionAdmitted(sid, roomId, admission.id);
      touchActive(sid);
      await confirmQueued(admission.maxTs);
    } else if (result === "rejected") rejectPendingAdmission(sid, roomId, admission.id);
  } catch { /* The periodic inbox poll retries delivery. */ }
}
