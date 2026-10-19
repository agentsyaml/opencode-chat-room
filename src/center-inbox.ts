import { formatNotificationLines, NOTIFY_INSTRUCTION } from "./store";
import {
  admissionMatches,
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  rejectPendingAdmission,
  type QueueItem,
} from "./queue";
import { request, markQueued, type CenterOpts } from "./center-client";
import { explicitlyMentions } from "./mentions";
import { serializeSessionPush } from "./session-delivery";
export { serializeSessionPush } from "./session-delivery";
import {
  sendAsyncNotification,
  sendQueue,
  type PushResult,
  type QueueTransport,
} from "./queue-transport";

export type InboxItem = QueueItem & { roomId: string; roomName: string };
const inboxChecks = new Set<string>();
const restoreScans = new Map<string, { beforeSeq?: number; untilTs?: number }>();
const restoreKey = (sessionID: string, roomID: string) => JSON.stringify([sessionID, roomID]);

export async function checkCenterInbox(
  opts: CenterOpts,
  sessionID: string,
  transport: QueueTransport,
): Promise<void> {
  if (inboxChecks.has(sessionID)) return;
  inboxChecks.add(sessionID);
  try {
    await serializeSessionPush(sessionID, async () => {
      const result = await request(opts, `/inbox?sessionID=${encodeURIComponent(sessionID)}&excludeSelf=1`, "GET") as {
        items?: InboxItem[];
        queuedTs?: Record<string, number>;
        hasMore?: boolean;
      };
      const queued = result.queuedTs ?? {};
      let items = (Array.isArray(result.items) ? result.items : []).filter(
        (item) => item.createdAt > (queued[item.roomId] ?? 0),
      );
      const qualified = transport.mentionOnlySessions?.has(sessionID)
        ? await scanRestoredRooms(opts, sessionID, transport.receiverOwnerID ?? "", items, queued, result.hasMore ?? false)
        : new Set<string>();
      if (qualified.size) {
        const merged = new Map(items.map((item) => [item.id, item]));
        for (const roomId of qualified) {
          const page = await request(opts, `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(roomId)}&excludeSelf=1&timeout=0`, "GET") as {
            items?: InboxItem[]; queuedTs?: Record<string, number>;
          };
          Object.assign(queued, page.queuedTs ?? {});
          for (const item of page.items ?? []) if (item.createdAt > (queued[roomId] ?? 0)) merged.set(item.id, item);
        }
        items = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
      }
      if (items.length) await pushItemsToSession(opts, sessionID, items, transport, queued, qualified);
    });
  } catch {
    // The next inbox poll retries failed delivery.
  } finally {
    inboxChecks.delete(sessionID);
  }
}

async function scanRestoredRooms(
  opts: CenterOpts, sessionID: string, ownerID: string, items: InboxItem[],
  queued: Readonly<Record<string, number>>, hasMore: boolean,
): Promise<Set<string>> {
  const rooms = new Set(items.map((item) => item.roomId));
  if (hasMore) {
    try {
      const summary = await request(opts, "/rooms/summary", "GET") as unknown as Array<{ id?: string }>;
      for (const room of summary) if (room.id) rooms.add(room.id);
    } catch { /* Keep scanning rooms already present in the bounded inbox page. */ }
  }
  const qualified = new Set<string>();
  for (const roomId of rooms) {
    try {
      const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, { name?: string; protocol?: string; receiverOwnerID?: string; lastReadTs?: number; lastQueuedTs?: number }>;
      const member = registry[sessionID];
      if (!member || member.protocol !== "v2" || member.receiverOwnerID !== ownerID) continue;
      const key = JSON.stringify([sessionID, roomId]);
      const cursor = Math.max(member.lastReadTs ?? 0, member.lastQueuedTs ?? queued[roomId] ?? 0);
      const state = restoreScans.get(key) ?? {};
      if (state.untilTs !== undefined && cursor < state.untilTs) { qualified.add(roomId); continue; }
      state.untilTs = undefined;
      const visible = items.filter((item) => item.roomId === roomId && item.createdAt > cursor).slice(-20);
      if (member.name && visible.some((item) => explicitlyMentions(item, member.name!, sessionID))) {
        state.untilTs = visible.at(-1)!.createdAt;
        restoreScans.set(key, state);
        qualified.add(roomId);
        continue;
      }
      const latest = await request(opts, `/rooms/${encodeURIComponent(roomId)}/history?limit=20&excludeSessionID=${encodeURIComponent(sessionID)}`, "GET") as { messages?: InboxItem[]; nextBeforeSeq?: number | null; hasMore?: boolean };
      const latestUnread = (latest.messages ?? []).filter((item) => item.createdAt > cursor);
      if (member.name && latestUnread.some((item) => explicitlyMentions(item, member.name!, sessionID))) {
        state.untilTs = latestUnread.at(-1)!.createdAt;
        restoreScans.set(key, state);
        qualified.add(roomId);
        continue;
      }
      if (state.beforeSeq === undefined) state.beforeSeq = latest.nextBeforeSeq ?? undefined;
      else {
        const older = await request(opts, `/rooms/${encodeURIComponent(roomId)}/history?beforeSeq=${state.beforeSeq}&limit=20&excludeSessionID=${encodeURIComponent(sessionID)}`, "GET") as { messages?: InboxItem[]; nextBeforeSeq?: number | null; hasMore?: boolean };
        const candidates = (older.messages ?? []).filter((item) => item.createdAt > cursor);
        if (member.name && candidates.some((item) => explicitlyMentions(item, member.name!, sessionID))) {
          state.untilTs = candidates.at(-1)!.createdAt;
          qualified.add(roomId);
        }
        state.beforeSeq = older.hasMore ? older.nextBeforeSeq ?? undefined : undefined;
      }
      restoreScans.set(key, state);
    } catch { /* A room's missing page is retried on the next receiver sweep. */ }
  }
  return qualified;
}

export async function pushItemsToSession(
  opts: CenterOpts,
  sessionID: string,
  items: InboxItem[],
  transport: QueueTransport,
  queuedTs: Readonly<Record<string, number>> = {},
  qualifiedRooms: ReadonlySet<string> = new Set(),
): Promise<PushResult> {
  const rooms = new Map<string, InboxItem[]>();
  const mentionOnly = transport.mentionOnlySessions?.has(sessionID) ?? false;
  for (const item of items) {
    if (item.createdAt <= (queuedTs[item.roomId] ?? 0)) continue;
    const group = rooms.get(item.roomId) ?? [];
    if (group.length < 20) group.push(item);
    rooms.set(item.roomId, group);
  }
  let worst: PushResult = "delivered";
  for (const [roomId, batch] of rooms) {
    const roomMentionOnly = mentionOnly && !qualifiedRooms.has(roomId);
    let recipient: { name?: string; protocol?: string; receiverOwnerID?: string } | undefined;
    if (transport.receiverOwnerID || mentionOnly) {
      try {
        const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, typeof recipient>;
        recipient = registry[sessionID];
      } catch { continue; }
      if (!recipient) continue;
      if (transport.protocol === "v2" && recipient.receiverOwnerID &&
        (recipient.protocol !== "v2" || recipient.receiverOwnerID !== transport.receiverOwnerID)) continue;
      if (roomMentionOnly && (recipient.protocol !== "v2" || recipient.receiverOwnerID !== transport.receiverOwnerID)) continue;
    }
    const maxTs = batch.reduce((max, item) => Math.max(max, item.createdAt), 0);
    const existing = pendingAdmission(sessionID, roomId);
    const delta = existing?.state === "admitted" && maxTs > existing.maxTs
      ? batch.filter((item) => item.createdAt > existing.maxTs)
      : batch;
    const eligibleItems = existing?.state === "pending" ? existing.items : delta.slice(-20);
    if (roomMentionOnly && (!recipient?.name ||
      !eligibleItems.some((item) => explicitlyMentions(item, recipient.name!, sessionID)) &&
      !delta.slice(-20).some((item) => explicitlyMentions(item, recipient.name!, sessionID)))) continue;
    if (existing?.state === "admitted" && (maxTs <= existing.maxTs || !delta.length)) {
      if (existing.maxTs > 0 && await markQueued(opts, roomId, sessionID, existing.maxTs)) {
        clearPendingAdmission(sessionID, roomId, existing.maxTs);
      }
      continue;
    }
    const deltaTs = delta.reduce((max, item) => Math.max(max, item.createdAt), 0);
    const { lines, capped } = formatNotificationLines(delta);
    const prompt = `<notification>\nNew messages in room ${delta[0]!.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`;
    const admission = getOrCreatePendingAdmission(sessionID, roomId, delta, prompt, deltaTs, capped);
    let delivery: "queue" | "steer" = "queue";
    if (transport.protocol === "v2" && transport.backgroundSession) {
      let name = "";
      try {
        const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, { name?: string }>;
        name = registry[sessionID]?.name ?? "";
      } catch { /* Backgrounding is optional; preserve queued delivery. */ }
      if (name && admission.items.some((item) => explicitlyMentions(item, name, sessionID)) &&
        await transport.backgroundSession(sessionID)) delivery = "steer";
    }
    const result = transport.protocol === "v1"
      ? await sendAsyncNotification(transport, sessionID, admission.prompt)
      : await sendQueue(transport, sessionID, admission.prompt, admission.id, delivery);
    if (result !== "delivered") {
      if (result === "rejected") rejectPendingAdmission(sessionID, roomId, admission.id);
      if (result === "rejected" || worst === "delivered") worst = result;
      continue;
    }
    markPendingAdmissionAdmitted(sessionID, roomId, admission.id);
    void request(opts, "/active", "POST", { sessionID }).catch(() => {});
    if (admission.maxTs > 0 && await markQueued(opts, roomId, sessionID, admission.maxTs)) {
      clearPendingAdmission(sessionID, roomId, admission.maxTs);
    }
  }
  return worst;
}
