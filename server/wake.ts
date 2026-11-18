import os from "node:os";
import type { Message } from "../src/rooms/room-service.ts";
import { formatNotificationLines, formatServeWakePrompt, readQuestionExcerpt, recalledMessageIDs, readState, writeState, type RegistryEntry } from "../src/state/store.ts";
import { clearPendingAdmission, getOrCreatePendingAdmission, markPendingAdmissionAdmitted, pendingAdmission, prunePendingAdmission, rejectPendingAdmission, type QueueItem } from "../src/center/queue.ts";
import { sendAsyncNotification } from "../src/center/queue-transport.ts";
import { notificationPrefix } from "../src/center/notification-budget.ts";
import { readInbox, type InboxItem } from "./inbox";
import { explicitlyAddresses } from "../src/center/mentions.ts";

const wakeClaims = new Map<string, number>();
const activeSessions = new Map<string, number>();
const WAKE_CLAIM_MS = 30_000;
const WAKE_INACTIVE_MS = 2 * 60_000;

const MAX_TRACKED = 10_000;
function track(map: Map<string, number>, id: string, ttl: number): void {
  map.set(id, Date.now());
  if (map.size <= MAX_TRACKED) return;
  const floor = Date.now() - ttl;
  for (const [key, at] of map) if (at < floor) map.delete(key);
  for (const key of map.keys()) { if (map.size <= MAX_TRACKED) break; map.delete(key); }
}

export function claimWake(id: string): boolean {
  if (Date.now() - (wakeClaims.get(id) ?? 0) < WAKE_CLAIM_MS) return false;
  track(wakeClaims, id, WAKE_CLAIM_MS);
  return true;
}
export function touchActive(id: string): void { if (id) track(activeSessions, id, WAKE_INACTIVE_MS); }

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
  const before = pendingAdmission(sid, roomId);
  // Authoritative DB recall check (not the 500-message room window): covers the
  // trigger and items already sitting in an undelivered admission.
  const recalledIDs = await recalledMessageIDs(roomId, [triggering.id, ...queuedItems.map((item) => item.id),
    ...(before?.items.flatMap((item) => item.id ? [item.id] : []) ?? [])]);
  const renderPrompt = (pendingItems: QueueItem[]) => {
    const { lines, capped } = formatNotificationLines(pendingItems);
    const prompt = roomKind === "direct"
      ? `<notification>\nNew messages in direct conversation ${roomName} (${roomId}):\n${lines.join("\n")}\n</notification>`
      : formatServeWakePrompt(roomName, roomId, lines);
    return { prompt, capped };
  };
  // best-effort boundary: a recall committed before this prune is dropped from
  // the pending prompt; one racing an in-flight dispatch can still land
  prunePendingAdmission(sid, roomId, Math.max(current.lastReadTs ?? 0, queued), renderPrompt, (item) => !item.id || !recalledIDs.has(item.id));
  const existing = pendingAdmission(sid, roomId);
  const trigger: InboxItem | undefined = recalledIDs.has(triggering.id) ? undefined : { id: triggering.id, roomId, roomName, roomKind, senderId: triggering.senderId, text: triggering.text, createdAt: triggering.createdAt,
    ...(triggering.answerToMessageID ? { answerQuestionExcerpt: await readQuestionExcerpt(roomId, triggering.answerToMessageID) } : {}) };
  const items = trigger && !queuedItems.some((item) => item.id === trigger.id)
    ? [...queuedItems, trigger].sort((a, b) => a.createdAt - b.createdAt)
    : trigger ? queuedItems.map((item) => item.id === trigger.id ? { ...trigger, ...item, answerQuestionExcerpt: item.answerQuestionExcerpt ?? trigger.answerQuestionExcerpt } : item) : queuedItems;
  if (!items.length && !existing) return;
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
  const deliveredIDs = new Set(existing?.state === "admitted" ? existing.items.flatMap((item) => item.id ? [item.id] : []) : []);
  // An admitted prompt only covers the items it carried; older unread items that
  // surface later still need delivery, even below its watermark.
  const delta = existing?.state === "admitted"
    ? items.filter((item) => item.createdAt > existing.maxTs || !deliveredIDs.has(item.id))
    : items;
  if (existing?.state === "admitted" && !delta.length) {
    await confirmQueued(existing.maxTs);
    return;
  }
  // Keep an undelivered admission's items; a later trigger may carry only newer
  // messages, and dropping the earlier prompt would lose them.
  const carried = existing?.state === "pending" ? existing.items : [];
  const carriedIDs = new Set(carried.flatMap((item) => item.id ? [item.id] : []));
  const merged = (carried.length ? [...carried, ...delta.filter((item) => !carriedIDs.has(item.id))] : delta)
    .sort((a, b) => a.createdAt - b.createdAt).slice(-20);
  if (!merged.length) return;
  // Only the oldest prefix that fits the line budget may advance the watermark;
  // folded tail messages stay unread for the next sweep.
  const deliverable = notificationPrefix(merged);
  if (!deliverable.length) return;
  const { prompt, capped } = renderPrompt(deliverable);
  const admission = getOrCreatePendingAdmission(sid, roomId, deliverable, prompt,
    deliverable.reduce((max, item) => Math.max(max, item.createdAt), 0), capped);
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
