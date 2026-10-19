import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message } from "./room-service";
import {
  formatNotificationLines,
  loadRegistry,
  NOTIFY_INSTRUCTION,
  statePath,
  timeOf,
} from "./store";
import { sendAsyncNotification, sendQueue, type QueueTransport } from "./queue-transport";
import { explicitlyMentions } from "./mentions";
import { serializeSessionPush } from "./center-inbox";
import {
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  rejectPendingAdmission,
} from "./queue";

type NotifyBatch = { roomId: string; roomName: string; messages: Message[] };
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
    const entry = (await loadRegistry())[batch.roomId]?.[sessionID];
    if (!entry || (entry.protocol !== "v2" && !entry.serverUrl)) return undefined;
    const mentionOnly = transport.mentionOnlySessions?.has(sessionID) ?? false;
    if (transport.protocol === "v2" && entry.receiverOwnerID &&
      (entry.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) return undefined;
    if (mentionOnly && (entry.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) return undefined;
    const unread = batch.messages.filter((m) =>
      m.createdAt > Math.max(entry.lastReadTs ?? 0, entry.lastQueuedTs ?? 0) &&
      (m.senderSessionID !== undefined ? m.senderSessionID !== sessionID : m.senderId !== entry.name),
    ).slice(0, 20);
    if (!unread.length) return undefined;
    const maxTs = unread.reduce((max, m) => Math.max(max, m.createdAt), 0);
    const existing = pendingAdmission(sessionID, batch.roomId);
    const delta = existing?.state === "admitted" && maxTs > existing.maxTs
      ? unread.filter((m) => m.createdAt > existing.maxTs)
      : unread;
    const eligibleItems = existing?.state === "pending" ? existing.items : delta.slice(-20);
    if (mentionOnly && !eligibleItems.some((message) => explicitlyMentions(message, entry.name, sessionID)) &&
      !delta.slice(-20).some((message) => explicitlyMentions(message, entry.name, sessionID))) return undefined;
    const base = entry.serverUrl ? new URL(entry.serverUrl) : undefined;
    const prefix = entry.protocol === "v2" ? (entry.apiPrefix || "/api").replace(/^\/+|\/+$/g, "") : "";
    const endpoint = entry.protocol === "v2" ? "prompt" : "prompt_async";
    const path = `${prefix ? `/${prefix}` : ""}/session/${encodeURIComponent(sessionID)}/${endpoint}`;
    const url = base ? `${base.origin}${path}` : `opencode://session/${sessionID}/${endpoint}`;
    if (existing?.state === "admitted" && (maxTs <= existing.maxTs || !delta.length)) {
      if (existing.maxTs > 0) await deps.bumpQueued(batch.roomId, sessionID, existing.maxTs);
      return { url, status: entry.protocol === "v2" ? 200 : 204 };
    }
    const { lines, capped } = formatNotificationLines(delta);
    const prompt = `<notification>\nNew messages in room ${batch.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`;
    const deltaTs = delta.reduce((max, m) => Math.max(max, m.createdAt), 0);
    const admission = getOrCreatePendingAdmission(
      sessionID, batch.roomId, delta, prompt, deltaTs, capped,
    );
    if (admission.state === "admitted" && deltaTs <= admission.maxTs) {
      await deps.bumpQueued(batch.roomId, sessionID, admission.maxTs);
      return { url, status: entry.protocol === "v2" ? 200 : 204 };
    }
    const targetTransport = {
      ...transport,
      serverUrl: entry.serverUrl,
      directory: entry.directory ?? transport.directory,
    };
    const mentioned = entry.protocol === "v2" && admission.items.some((message) => explicitlyMentions(message, entry.name, sessionID));
    const delivery = mentioned && targetTransport.backgroundSession &&
      await targetTransport.backgroundSession(sessionID) ? "steer" : "queue";
    const result = entry.protocol === "v2"
      ? await sendQueue(targetTransport, sessionID, admission.prompt, admission.id, delivery)
      : await sendAsyncNotification(targetTransport, sessionID, admission.prompt);
    if (result !== "delivered") {
      if (result === "rejected") rejectPendingAdmission(sessionID, batch.roomId, admission.id);
      return { url, status: result === "unreachable" ? 0 : 400 };
    }
    markPendingAdmissionAdmitted(sessionID, batch.roomId, admission.id);
    if (admission.maxTs > 0) await deps.bumpQueued(batch.roomId, sessionID, admission.maxTs);
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
    _body: string,
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
