import { formatNotificationLines, NOTIFY_INSTRUCTION } from "./store";
import {
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  prunePendingAdmission,
  rejectPendingAdmission,
  type QueueItem,
} from "./queue";
import { request, markQueued, type CenterOpts } from "./center-client";
import { materializeAny } from "./attachments";
import { explicitlyAddresses } from "./mentions";
import { claimBackgroundAttempt } from "./receiver-state";
import { prepareReceiptCandidate, receiptDestination } from "./agent-receipts";
import { serializeSessionPush } from "./session-delivery";
export { serializeSessionPush } from "./session-delivery";
import {
  sendAsyncNotification,
  sendQueue,
  backgroundResult,
  backgroundServiceKey,
  type BackgroundResult,
  type PushResult,
  type QueueTransport,
} from "./queue-transport";

export type InboxItem = QueueItem & { roomId: string; roomName: string; roomKind?: "group" | "direct" };
const inboxChecks = new Set<string>();
const restoreScans = new Map<string, { beforeSeq?: number; untilTs?: number }>();
const restoreKey = (sessionID: string, roomID: string) => JSON.stringify([sessionID, roomID]);

function render(roomName: string, roomId: string, roomKind: "group" | "direct", name: string, items: QueueItem[]) {
  const { lines, capped } = formatNotificationLines(items);
  const context = roomKind === "direct" ? `Direct conversation with ${name} in room ${roomName} (${roomId})` : `New messages in room ${roomName} (${roomId})`;
  return { prompt: `<notification>\n${context}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`, capped };
}

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
      // Images become files on this host before the notification is built, so
      // the notification can name a path the agent can open.
      await Promise.all(items.filter((item): item is InboxItem & { id: string } => Boolean(item.id))
        .map((item) => materializeAny(item, { base: opts.center, token: opts.token, roomID: item.roomId })
          .catch(() => [])));
      await pushItemsToSession(opts, sessionID, items, transport, queued, qualified);
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
      const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, { name?: string; protocol?: string; receiverOwnerID?: string; lastReadTs?: number; lastQueuedTs?: number; roomKind?: "group" | "direct" }>;
      const member = registry[sessionID];
      if (!member || member.protocol !== "v2" || member.receiverOwnerID !== ownerID) continue;
      const key = JSON.stringify([sessionID, roomId]);
      const cursor = Math.max(member.lastReadTs ?? 0, member.lastQueuedTs ?? queued[roomId] ?? 0);
      const state = restoreScans.get(key) ?? {};
      if (state.untilTs !== undefined && cursor < state.untilTs) { qualified.add(roomId); continue; }
      state.untilTs = undefined;
      const visible = items.filter((item) => item.roomId === roomId && item.createdAt > cursor).slice(-20);
      if (member.name && visible.some((item) => explicitlyAddresses(item, member.name!, sessionID, member.roomKind))) {
        state.untilTs = visible.at(-1)!.createdAt;
        restoreScans.set(key, state);
        qualified.add(roomId);
        continue;
      }
      const latest = await request(opts, `/rooms/${encodeURIComponent(roomId)}/history?limit=20&excludeSessionID=${encodeURIComponent(sessionID)}`, "GET") as { messages?: InboxItem[]; nextBeforeSeq?: number | null; hasMore?: boolean };
      const latestUnread = (latest.messages ?? []).filter((item) => item.createdAt > cursor);
      if (member.name && latestUnread.some((item) => explicitlyAddresses(item, member.name!, sessionID, member.roomKind))) {
        state.untilTs = latestUnread.at(-1)!.createdAt;
        restoreScans.set(key, state);
        qualified.add(roomId);
        continue;
      }
      if (state.beforeSeq === undefined) state.beforeSeq = latest.nextBeforeSeq ?? undefined;
      else {
        const older = await request(opts, `/rooms/${encodeURIComponent(roomId)}/history?beforeSeq=${state.beforeSeq}&limit=20&excludeSessionID=${encodeURIComponent(sessionID)}`, "GET") as { messages?: InboxItem[]; nextBeforeSeq?: number | null; hasMore?: boolean };
        const candidates = (older.messages ?? []).filter((item) => item.createdAt > cursor);
        if (member.name && candidates.some((item) => explicitlyAddresses(item, member.name!, sessionID, member.roomKind))) {
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
    type Recipient = { name?: string; protocol?: "v1" | "v2"; receiverOwnerID?: string; membershipID?: string; lastReadTs?: number; lastQueuedTs?: number; roomKind?: "group" | "direct"; host?: string; directory?: string };
    let recipient: Recipient | undefined;
    try {
      const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, Recipient>;
      recipient = registry[sessionID];
    } catch { continue; }
    if (!recipient || (recipient.protocol ?? "v1") !== (transport.protocol ?? "v1")) continue;
    if (transport.protocol === "v2" && transport.receiverOwnerID && recipient.receiverOwnerID !== transport.receiverOwnerID) continue;
    if (roomMentionOnly && (recipient.protocol !== "v2" || recipient.receiverOwnerID !== transport.receiverOwnerID)) continue;
    const target = { ...transport, directory: recipient.directory ?? transport.directory };
    const roomKind = recipient.roomKind ?? batch.find((item) => item.roomKind)?.roomKind ?? "group";
    const cutoff = Math.max(queuedTs[roomId] ?? 0, recipient.lastReadTs ?? 0, recipient.lastQueuedTs ?? 0);
    const unread = batch.filter((item) => item.createdAt > cutoff);
    prunePendingAdmission(sessionID, roomId, cutoff,
      (pending) => render(batch[0]!.roomName, roomId, roomKind, recipient!.name ?? "you", pending));
    const existing = pendingAdmission(sessionID, roomId);
    if (!unread.length && existing?.state !== "pending") continue;
    const maxTs = unread.reduce((max, item) => Math.max(max, item.createdAt), 0);
    const delta = existing?.state === "admitted" && maxTs > existing.maxTs
      ? unread.filter((item) => item.createdAt > existing.maxTs)
      : unread;
    const eligibleItems = existing?.state === "pending" ? existing.items : delta.slice(-20);
    if (roomMentionOnly && (!recipient?.name ||
      !eligibleItems.some((item) => explicitlyAddresses(item, recipient.name!, sessionID, roomKind)) &&
      !delta.slice(-20).some((item) => explicitlyAddresses(item, recipient.name!, sessionID, roomKind)))) continue;
    if (existing?.state === "admitted" && (maxTs <= existing.maxTs || !delta.length)) {
      if (existing.maxTs > 0 && await markQueued(opts, roomId, sessionID, existing.maxTs)) {
        clearPendingAdmission(sessionID, roomId, existing.maxTs);
      }
      continue;
    }
    const deltaTs = delta.reduce((max, item) => Math.max(max, item.createdAt), 0);
    const { prompt, capped } = render(batch[0]!.roomName, roomId, roomKind, recipient.name ?? "you", delta);
    const admission = getOrCreatePendingAdmission(sessionID, roomId, delta, prompt, deltaTs, capped);
    const addressedTs = recipient.name
      ? admission.items.filter((item) => explicitlyAddresses(item, recipient.name!, sessionID, roomKind))
        .reduce((max, item) => Math.max(max, item.createdAt), 0)
      : 0;
    if (transport.protocol === "v2" && transport.backgroundSession && addressedTs > 0 &&
      claimBackgroundAttempt(sessionID, roomId, backgroundServiceKey(target, opts.center), addressedTs)) {
      let attempt: BackgroundResult;
      try { attempt = backgroundResult(await target.backgroundSession!(sessionID)); }
      catch { attempt = { status: "failed", reason: "request-threw" }; }
      if (attempt.status !== "done") console.warn(`[chat-room] background ${attempt.status} room=${roomId} reason=${attempt.reason ?? "unknown"}`);
    }
    let current: Recipient | undefined;
    try {
      const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, Recipient>;
      current = registry[sessionID];
    } catch { current = undefined; }
    if (!current || (current.protocol ?? "v1") !== (recipient.protocol ?? "v1") ||
      (transport.protocol === "v2" && transport.receiverOwnerID && current.receiverOwnerID !== transport.receiverOwnerID) ||
      current.host !== recipient.host || current.directory !== recipient.directory ||
      (current.roomKind ?? "group") !== roomKind) {
      rejectPendingAdmission(sessionID, roomId, admission.id);
      clearPendingAdmission(sessionID, roomId, Number.MAX_SAFE_INTEGER);
      continue;
    }
    const currentCutoff = Math.max(current.lastReadTs ?? 0, current.lastQueuedTs ?? 0, queuedTs[roomId] ?? 0);
    const currentAdmission = prunePendingAdmission(sessionID, roomId, currentCutoff,
      (pending) => render(batch[0]!.roomName, roomId, roomKind, current!.name ?? "you", pending));
    if (!currentAdmission || currentAdmission.id !== admission.id) {
      continue;
    }
    if (transport.protocol === "v2" && current.protocol === "v2") prepareReceiptCandidate({
      admissionID: admission.id, sessionID, roomID: roomId, membershipID: current.membershipID,
      receiverOwnerID: current.receiverOwnerID, destination: receiptDestination(opts.center),
      items: admission.items, prompt: admission.prompt, capped: admission.capped,
    });
    const result = transport.protocol === "v1"
      ? await sendAsyncNotification(target, sessionID, admission.prompt)
      : await sendQueue(target, sessionID, admission.prompt, admission.id, "steer");
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
