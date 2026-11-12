import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message } from "./room-service";
import {
  formatNotificationLines,
  loadRegistry,
  loadRooms,
  readQuestionExcerpt,
  statePath,
  timeOf,
} from "./store";
import { backgroundResult, backgroundServiceKey, sendAsyncNotification, sendQueue, type BackgroundResult, type QueueTransport } from "./queue-transport";
import { explicitlyAddresses } from "./mentions";
import { claimBackgroundAttempt } from "./receiver-state";
import { serializeSessionPush } from "./center-inbox";
import { prepareReceiptCandidate, receiptDestination } from "./agent-receipts";
import {
  getOrCreatePendingAdmission,
  clearPendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  rejectPendingAdmission,
  prunePendingAdmission,
  type QueueItem,
} from "./queue";

type NotifyBatch = { roomId: string; roomName: string; roomKind?: "group" | "direct"; messages: Message[] };
type NotifyAttempt = { url: string; status: number };
type TargetQueue = { latest?: NotifyBatch; latestTs: number; running: Promise<NotifyAttempt[]> };

export function createNotifier(deps: {
  transport(): QueueTransport;
  bumpQueued(roomId: string, sessionID: string, ts: number): Promise<boolean>;
}) {
  const queues = new Map<string, TargetQueue>();
  const notifyPath = () => path.join(path.dirname(statePath()), "notify.log");

  async function log(roomId: string, results: PromiseSettledResult<NotifyAttempt>[]) {
    const lines = results.map((r) => {
      const head = `[${timeOf(Date.now())}] room=${roomId}`;
      if (r.status === "rejected") return `${head} FAIL ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      return r.value.status >= 200 && r.value.status < 300
        ? `${head} OK ${r.value.status} ${r.value.url}`
        : `${head} FAIL ${r.value.status} ${r.value.url}`;
    });
    await fs.appendFile(notifyPath(), lines.join("\n") + "\n", "utf8").catch(() => {});
  }

  function render(batch: NotifyBatch, name: string, roomKind: "group" | "direct", items: QueueItem[]) {
    const { lines, capped } = formatNotificationLines(items);
    const context = roomKind === "direct" ? `Direct conversation with ${name} in room ${batch.roomName} (${batch.roomId})` : `New messages in room ${batch.roomName} (${batch.roomId})`;
    return { prompt: `<notification>\n${context}:\n${lines.join("\n")}\n</notification>`, capped };
  }

  async function tryBackground(transport: QueueTransport, sessionID: string) {
    try { return backgroundResult(await transport.backgroundSession!(sessionID)); }
    catch { return { status: "failed" as const, reason: "request-threw" }; }
  }

  function logBackgroundResult(roomId: string, status: string, reason?: string) {
    if (status !== "done") console.warn(`[chat-room] background ${status} room=${roomId} reason=${reason ?? "unknown"}`);
  }

  async function notifyTarget(
    sessionID: string,
    batch: NotifyBatch,
    transport: QueueTransport = deps.transport(),
  ): Promise<NotifyAttempt | undefined> {
    if (transport.protocol !== "v2") return notifyTargetUnlocked(sessionID, batch, transport);
    return serializeSessionPush(sessionID, () => notifyTargetUnlocked(sessionID, batch, transport));
  }

  async function notifyTargetUnlocked(
    sessionID: string,
    batch: NotifyBatch,
    transport: QueueTransport,
  ): Promise<NotifyAttempt | undefined> {
    batch = { ...batch, messages: await Promise.all(batch.messages.map(async (message) => message.answerToMessageID
      ? { ...message, answerQuestionExcerpt: await readQuestionExcerpt(batch.roomId, message.answerToMessageID) }
      : message)) };
    const [registry, rooms] = await Promise.all([loadRegistry(), loadRooms()]);
    const entry = registry[batch.roomId]?.[sessionID];
    const roomKind = batch.roomKind ?? rooms.find((room) => room.id === batch.roomId)?.kind ?? "group";
    if (!entry || (entry.protocol !== "v2" && !entry.serverUrl)) return undefined;
    const protocol = entry.protocol ?? "v1";
    if (protocol !== (transport.protocol ?? "v1") && !(transport.protocol === "v2" && protocol === "v1")) return undefined;
    const mentionOnly = transport.mentionOnlySessions?.has(sessionID) ?? false;
    if (protocol === "v2" && (transport.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) return undefined;
    if (mentionOnly && (entry.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) return undefined;
    const targetTransport = {
      ...transport,
      protocol,
      serverUrl: entry.serverUrl,
      directory: entry.directory ?? transport.directory,
    };
    const service = backgroundServiceKey(targetTransport);
    const cutoff = Math.max(entry.lastReadTs ?? 0, entry.lastQueuedTs ?? 0);
    prunePendingAdmission(sessionID, batch.roomId, cutoff, (items) => render(batch, entry.name, roomKind, items));
    const unreadAll = batch.messages.filter((m) =>
      m.createdAt > cutoff &&
      (m.senderSessionID !== undefined ? m.senderSessionID !== sessionID : m.senderId !== (roomKind === "direct" ? sessionID : entry.name)),
    );
    const unread = unreadAll.slice(-20).map((item) => ({ ...item, roomKind }));
    const existing = pendingAdmission(sessionID, batch.roomId);
    if (!unread.length && existing?.state !== "pending") return undefined;
    const maxTs = unread.reduce((max, m) => Math.max(max, m.createdAt), 0);
    const delta = existing?.state === "admitted" && maxTs > existing.maxTs
      ? unread.filter((m) => m.createdAt > existing.maxTs)
      : unread;
    const eligibleItems = existing?.state === "pending" ? existing.items : delta.slice(-20);
    if (mentionOnly && !eligibleItems.some((message) => explicitlyAddresses(message, entry.name, sessionID, roomKind)) &&
      !unreadAll.some((message) => explicitlyAddresses(message, entry.name, sessionID, roomKind))) return undefined;
    const base = entry.serverUrl ? new URL(entry.serverUrl) : undefined;
    const prefix = entry.protocol === "v2" ? (entry.apiPrefix || "/api").replace(/^\/+|\/+$/g, "") : "";
    const endpoint = entry.protocol === "v2" ? "prompt" : "prompt_async";
    const path = `${prefix ? `/${prefix}` : ""}/session/${encodeURIComponent(sessionID)}/${endpoint}`;
    const url = base ? `${base.origin}${path}` : `opencode://session/${sessionID}/${endpoint}`;
    if (existing?.state === "admitted" && (maxTs <= existing.maxTs || !delta.length)) {
      if (existing.maxTs > 0) await deps.bumpQueued(batch.roomId, sessionID, existing.maxTs);
      return { url, status: entry.protocol === "v2" ? 200 : 204 };
    }
    const { prompt, capped } = render(batch, entry.name, roomKind, delta);
    const deltaTs = delta.reduce((max, m) => Math.max(max, m.createdAt), 0);
    const admission = getOrCreatePendingAdmission(
      sessionID, batch.roomId, delta, prompt, deltaTs, capped,
    );
    if (admission.state === "admitted" && deltaTs <= admission.maxTs) {
      await deps.bumpQueued(batch.roomId, sessionID, admission.maxTs);
      return { url, status: entry.protocol === "v2" ? 200 : 204 };
    }
    const addressedTs = admission.items.filter((message) => explicitlyAddresses(message, entry.name, sessionID, roomKind))
      .reduce((max, message) => Math.max(max, message.createdAt), 0);
    const [currentRegistry, currentRooms] = await Promise.all([loadRegistry(), loadRooms()]);
    const currentEntry = currentRegistry[batch.roomId]?.[sessionID];
    const currentKind = currentRooms.find((room) => room.id === batch.roomId)?.kind ?? "group";
    if (!currentEntry || (currentEntry.protocol ?? "v1") !== protocol || currentEntry.serverUrl !== entry.serverUrl ||
      currentEntry.directory !== entry.directory ||
      (protocol === "v2" && currentEntry.receiverOwnerID !== transport.receiverOwnerID) || currentKind !== roomKind) {
      rejectPendingAdmission(sessionID, batch.roomId, admission.id);
      clearPendingAdmission(sessionID, batch.roomId, Number.MAX_SAFE_INTEGER);
      return undefined;
    }
    const currentCutoff = Math.max(currentEntry.lastReadTs ?? 0, currentEntry.lastQueuedTs ?? 0);
    const currentAdmission = prunePendingAdmission(sessionID, batch.roomId, currentCutoff,
      (items) => render(batch, entry.name, roomKind, items));
    if (!currentAdmission || currentAdmission.id !== admission.id) {
      return notifyTargetUnlocked(sessionID, batch, transport);
    }
    if (protocol === "v2") prepareReceiptCandidate({
      admissionID: admission.id, sessionID, roomID: batch.roomId, membershipID: currentEntry.membershipID,
      receiverOwnerID: currentEntry.receiverOwnerID, destination: receiptDestination(""),
      items: admission.items, prompt: admission.prompt, capped: admission.capped,
    });
    const result = entry.protocol === "v2"
      ? await sendQueue(targetTransport, sessionID, admission.prompt, admission.id, "steer")
      : await sendAsyncNotification(targetTransport, sessionID, admission.prompt);
    if (result !== "delivered") {
      // Keep one line per failure: an idle host that never receives is otherwise invisible.
      console.warn(`[chat-room] delivery ${result} room=${batch.roomId} session=${sessionID} protocol=${entry.protocol}`);
      if (result === "rejected") rejectPendingAdmission(sessionID, batch.roomId, admission.id);
      return { url, status: result === "unreachable" ? 0 : 400 };
    }
    markPendingAdmissionAdmitted(sessionID, batch.roomId, admission.id);
    if (admission.maxTs > 0) await deps.bumpQueued(batch.roomId, sessionID, admission.maxTs);
    if (entry.protocol === "v2" && addressedTs > 0 && targetTransport.backgroundSession && claimBackgroundAttempt(
      sessionID, batch.roomId, service, addressedTs,
    )) {
      const attempt = await tryBackground(targetTransport, sessionID);
      logBackgroundResult(batch.roomId, attempt.status, attempt.reason);
    }
    return { url, status: entry.protocol === "v2" ? 200 : 204 };
  }

  function batchMax(batch: NotifyBatch) {
    return batch.messages.reduce((max, message) => Math.max(max, message.createdAt), 0);
  }

  function queueTarget(sessionID: string, batch: NotifyBatch): Promise<NotifyAttempt[]> {
    const key = JSON.stringify([batch.roomId, sessionID]);
    const existing = queues.get(key);
    if (existing) {
      const max = batchMax(batch);
      if (max > existing.latestTs) {
        existing.latest = batch;
        existing.latestTs = max;
      }
      return existing.running;
    }
    const state: TargetQueue = { latest: batch, latestTs: batchMax(batch), running: Promise.resolve([]) };
    const running = (async () => {
      const attempts: NotifyAttempt[] = [];
      let firstError: unknown;
      while (state.latest) {
        const current = state.latest;
        state.latest = undefined;
        try {
          const attempt = await notifyTarget(sessionID, current);
          if (attempt) attempts.push(attempt);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
      return attempts;
    })();
    state.running = running;
    queues.set(key, state);
    const clean = () => { if (queues.get(key) === state) queues.delete(key); };
    void running.then(clean, clean);
    return running;
  }

  async function notifyRoom(
    roomId: string,
    roomName: string,
    selfSessionID: string,
    messages: Message[],
  ) {
    const registry = await loadRegistry();
    const targets = Object.entries(registry[roomId] ?? {}).filter(
      ([id, entry]) => id !== selfSessionID && entry.protocol !== "v2" && entry.serverUrl,
    );
    const results = await Promise.allSettled(targets.map(([id]) =>
      queueTarget(id, { roomId, roomName, messages }),
    ));
    const attempts: PromiseSettledResult<NotifyAttempt>[] = [];
    let failure: unknown;
    for (const result of results) {
      if (result.status === "fulfilled") {
        attempts.push(...result.value.map((value) => ({ status: "fulfilled", value } as const)));
      } else {
        attempts.push(result);
        failure ??= result.reason;
      }
    }
    await log(roomId, attempts);
    if (failure !== undefined) throw failure;
  }

  return { notifyRoom, notifyTarget };
}
