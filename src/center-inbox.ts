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
import {
  sendAsyncNotification,
  sendQueue,
  type PushResult,
  type QueueTransport,
} from "./queue-transport";

export type InboxItem = QueueItem & { roomId: string; roomName: string };
const inboxChecks = new Set<string>();
const sessionPushes = new Map<string, Promise<void>>();

export function serializeSessionPush(sessionID: string, task: () => Promise<void>): Promise<void> {
  const previous = sessionPushes.get(sessionID) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  let current: Promise<void>;
  current = run.finally(() => {
    if (sessionPushes.get(sessionID) === current) sessionPushes.delete(sessionID);
  });
  sessionPushes.set(sessionID, current);
  return current;
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
      };
      const queued = result.queuedTs ?? {};
      const items = (Array.isArray(result.items) ? result.items : []).filter(
        (item) => item.createdAt > (queued[item.roomId] ?? 0),
      );
      if (items.length) await pushItemsToSession(opts, sessionID, items, transport, queued);
    });
  } catch {
    // The next inbox poll retries failed delivery.
  } finally {
    inboxChecks.delete(sessionID);
  }
}

export async function pushItemsToSession(
  opts: CenterOpts,
  sessionID: string,
  items: InboxItem[],
  transport: QueueTransport,
  queuedTs: Readonly<Record<string, number>> = {},
): Promise<PushResult> {
  const rooms = new Map<string, InboxItem[]>();
  for (const item of items) {
    if (item.createdAt <= (queuedTs[item.roomId] ?? 0)) continue;
    const group = rooms.get(item.roomId) ?? [];
    group.push(item);
    rooms.set(item.roomId, group);
  }
  let worst: PushResult = "delivered";
  for (const [roomId, batch] of rooms) {
    const maxTs = batch.reduce((max, item) => Math.max(max, item.createdAt), 0);
    const existing = pendingAdmission(sessionID, roomId);
    const delta = existing?.state === "admitted" && maxTs > existing.maxTs
      ? batch.filter((item) => item.createdAt > existing.maxTs)
      : batch;
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
    const result = transport.protocol === "v1"
      ? await sendAsyncNotification(transport, sessionID, admission.prompt)
      : await sendQueue(transport, sessionID, admission.prompt, admission.id);
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
