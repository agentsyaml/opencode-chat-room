import os from "node:os";
import {
  formatNotificationLines,
  formatServeWakePrompt,
} from "./store";
import { explicitlyAddresses } from "./mentions";
import {
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  prunePendingAdmission,
  rejectPendingAdmission,
  type PendingAdmission,
} from "./queue";
import { markQueued, request, type CenterOpts } from "./center-client";
import { pushItemsToSession, serializeSessionPush, type InboxItem } from "./center-inbox";
import { sendAsyncNotification, sendQueue, type QueueTransport } from "./queue-transport";

const checking = new WeakSet<QueueTransport>();

async function wakeViaServe(
  serveUrl: string,
  sessionID: string,
  roomId: string,
  opts: CenterOpts,
  transport: QueueTransport,
  admission: PendingAdmission,
  roomName: string,
  expectedHost: string | undefined,
  expectedDirectory: string | undefined,
  expectedRoomKind: "group" | "direct",
): Promise<boolean> {
  try {
    const response = await fetch(`${opts.center}/wake-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: JSON.stringify({ sessionID }),
      signal: AbortSignal.timeout(10_000),
    });
    const claim = await response.json().catch(() => ({})) as { ok?: boolean };
    if (!claim.ok) return false;
  } catch {
    return false;
  }
  const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, {
    protocol?: "v1" | "v2"; receiverOwnerID?: string; lastReadTs?: number; lastQueuedTs?: number;
    name?: string; roomKind?: "group" | "direct"; host?: string; directory?: string;
  }>;
  const current = registry[sessionID];
  const cutoff = Math.max(current?.lastReadTs ?? 0, current?.lastQueuedTs ?? 0);
  const fresh = prunePendingAdmission(sessionID, roomId, cutoff, (items) => {
    const { lines, capped } = formatNotificationLines(items);
    return { prompt: formatServeWakePrompt(roomName, roomId, lines), capped };
  });
  if (!current || (current.protocol ?? "v1") !== (transport.protocol ?? "v1") ||
    (transport.protocol === "v2" && current.receiverOwnerID !== transport.receiverOwnerID) ||
    current.host !== expectedHost || current.directory !== expectedDirectory ||
    (current.roomKind ?? "group") !== expectedRoomKind ||
    !fresh || fresh.id !== admission.id || admission.maxTs <= cutoff) {
    rejectPendingAdmission(sessionID, roomId, admission.id);
    clearPendingAdmission(sessionID, roomId, Number.MAX_SAFE_INTEGER);
    return false;
  }
  const target: QueueTransport = { serverUrl: serveUrl, directory: transport.directory, protocol: transport.protocol };
  const result = transport.protocol === "v1"
    ? await sendAsyncNotification(target, sessionID, admission.prompt)
    : await sendQueue(target, sessionID, admission.prompt, admission.id, "steer");
  if (result === "delivered") {
    void request(opts, "/active", "POST", { sessionID }).catch(() => {});
    markPendingAdmissionAdmitted(sessionID, roomId, admission.id);
    if (admission.maxTs > 0 && await markQueued(opts, roomId, sessionID, admission.maxTs)) {
      clearPendingAdmission(sessionID, roomId, admission.maxTs);
    }
  } else if (result === "rejected") {
    rejectPendingAdmission(sessionID, roomId, admission.id);
  }
  return result === "delivered";
}

export async function wakeSessions(
  opts: CenterOpts,
  transport: QueueTransport,
  serveUrl = "",
  eligibleSessions?: ReadonlySet<string>,
): Promise<void> {
  if (checking.has(transport)) return;
  checking.add(transport);
  try {
    const rooms = await request(opts, "/rooms/summary", "GET") as unknown as Array<{ id: string; latestMsgTs: number }>;
    if (!Array.isArray(rooms)) return;
    for (const room of rooms) {
      try {
        const roomId = String(room.id ?? "");
        const latest = Number(room.latestMsgTs ?? 0);
        if (!roomId || latest === 0) continue;
        const registry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, {
          name: string; protocol?: "v1" | "v2"; receiverOwnerID?: string; lastReadTs?: number; lastQueuedTs?: number;
          host?: string; directory?: string; roomKind?: "group" | "direct";
        }>;
        for (const [sessionID, entry] of Object.entries(registry)) {
          if (eligibleSessions && !eligibleSessions.has(sessionID)) continue;
          if (!entry.host || entry.host !== os.hostname()) continue;
          if (latest <= Math.max(entry.lastReadTs ?? 0, entry.lastQueuedTs ?? 0)) continue;
          await serializeSessionPush(sessionID, async () => {
            const inbox = await request(opts,
              `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(roomId)}&excludeSelf=1&timeout=0`,
              "GET") as { items?: InboxItem[]; queuedTs?: Record<string, number> };
            const queuedTs = Math.max(entry.lastQueuedTs ?? 0, inbox.queuedTs?.[roomId] ?? 0);
            const items = (Array.isArray(inbox.items) ? inbox.items : []).filter(
              (item) => item.roomId === roomId && item.createdAt > queuedTs,
            );
            if (!items.length) return;
            const target = { ...transport, directory: entry.directory ?? transport.directory };
            const pushed = await pushItemsToSession(opts, sessionID, items, target, inbox.queuedTs);
            if (pushed !== "unreachable" || !serveUrl) return;
            const currentRegistry = await request(opts, `/rooms/${encodeURIComponent(roomId)}/registry`, "GET") as Record<string, typeof entry>;
            const current = currentRegistry[sessionID];
            if (!current || (current.protocol ?? "v1") !== (entry.protocol ?? "v1") || current.host !== entry.host ||
              current.directory !== entry.directory || (transport.protocol === "v2" && current.receiverOwnerID !== transport.receiverOwnerID)) return;
            const roomKind = current.roomKind ?? "group";
            const currentCursor = Math.max(current.lastReadTs ?? 0, current.lastQueuedTs ?? 0);
            const unread = items.filter((item) => item.createdAt > currentCursor);
            const mentioned = unread.some((item) => explicitlyAddresses(item, current.name, sessionID, roomKind));
            if (!mentioned) return;
            const currentMax = unread.reduce((max, item) => Math.max(max, item.createdAt), 0);
            prunePendingAdmission(sessionID, roomId, currentCursor, (pending) => {
              const { lines, capped } = formatNotificationLines(pending);
              return { prompt: formatServeWakePrompt(unread[0]!.roomName, roomId, lines), capped };
            });
            const existing = pendingAdmission(sessionID, roomId);
            const delta = existing?.state === "admitted" && currentMax > existing.maxTs
              ? unread.filter((item) => item.createdAt > existing.maxTs) : unread;
            if (existing?.state === "admitted" && (currentMax <= existing.maxTs || !delta.length)) return;
            const { lines, capped } = formatNotificationLines(delta);
            const prompt = formatServeWakePrompt(delta[0]!.roomName, roomId, lines);
            const maxTs = delta.reduce((max, item) => Math.max(max, item.createdAt), 0);
            const admission = getOrCreatePendingAdmission(sessionID, roomId, delta, prompt, maxTs, capped);
            await wakeViaServe(serveUrl, sessionID, roomId, opts, target, admission,
              delta[0]!.roomName, entry.host, entry.directory, roomKind);
          });
        }
      } catch {
        // A failing room is retried on the next wake sweep.
      }
    }
  } catch {
    // The next wake sweep retries center failures.
  } finally {
    checking.delete(transport);
  }
}
