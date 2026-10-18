import os from "node:os";
import {
  formatNotificationLines,
  formatServeWakePrompt,
} from "./store";
import {
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
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
  const target: QueueTransport = { serverUrl: serveUrl, directory: transport.directory, protocol: transport.protocol };
  const result = transport.protocol === "v1"
    ? await sendAsyncNotification(target, sessionID, admission.prompt)
    : await sendQueue(target, sessionID, admission.prompt, admission.id);
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
          name: string; lastReadTs?: number; lastQueuedTs?: number; host?: string; directory?: string;
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
            const mentioned = items.some((item) => {
              if (item.text.includes(`<at>@${entry.name}</at>`)) return true;
              const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "u").test(item.text);
            });
            if (!mentioned) return;
            const currentMax = items.reduce((max, item) => Math.max(max, item.createdAt), 0);
            const existing = pendingAdmission(sessionID, roomId);
            const delta = existing?.state === "admitted" && currentMax > existing.maxTs
              ? items.filter((item) => item.createdAt > existing.maxTs) : items;
            if (existing?.state === "admitted" && (currentMax <= existing.maxTs || !delta.length)) return;
            const { lines, capped } = formatNotificationLines(delta);
            const prompt = formatServeWakePrompt(delta[0]!.roomName, lines);
            const maxTs = delta.reduce((max, item) => Math.max(max, item.createdAt), 0);
            const admission = getOrCreatePendingAdmission(sessionID, roomId, delta, prompt, maxTs, capped);
            await wakeViaServe(serveUrl, sessionID, roomId, opts, target, admission);
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
