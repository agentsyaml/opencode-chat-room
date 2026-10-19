import os from "node:os";
import type { Message } from "../src/room-service";
import { authHeader, formatNotificationLines, formatServeWakePrompt, readState, writeState, type RegistryEntry } from "../src/store";
import { admissionMatches, clearPendingAdmission, getOrCreatePendingAdmission, markPendingAdmissionAdmitted, pendingAdmission, rejectPendingAdmission, type QueueBody, type QueueItem } from "../src/queue";
import { readInbox, type InboxItem } from "./inbox";

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
  const mentions = new Set<string>();
  for (const match of text.matchAll(/<at>@([^<]+)<\/at>/g)) mentions.add(match[1]!);
  for (const match of text.matchAll(/@([\p{L}\p{N}_]+)/gu)) {
    const at = match.index ?? 0;
    if (at === 0 || !/[A-Za-z0-9_]/.test(text[at - 1] ?? "")) mentions.add(match[1]!);
  }
  if (!mentions.size) return;
  const reg = await readState((_svc, registry) => registry[roomId] ?? {});
  for (const [sid, entry] of Object.entries(reg)) {
    if (sid === senderSessionID || entry.protocol === "v2" || !mentions.has(entry.name) || entry.host !== os.hostname() ||
      (activeSessions.get(sid) ?? 0) > Date.now() - WAKE_INACTIVE_MS ||
      triggeringMessage.createdAt <= (entry.lastReadTs ?? 0) ||
      triggeringMessage.createdAt <= (entry.lastQueuedTs ?? 0) || !claimWake(sid)) continue;
    void deliverWake(serveWakeUrl, sid, roomId, roomName, entry, triggeringMessage).catch(() => {});
  }
}

async function deliverWake(
  serveWakeUrl: string, sid: string, roomId: string, roomName: string,
  entry: RegistryEntry, triggering: Message,
): Promise<void> {
  const inbox = await readInbox(sid, roomId, true);
  const current = await readState((_svc, registry) => registry[roomId]?.[sid]);
  if (!current || !inbox.member) return;
  const queued = Math.max(current.lastQueuedTs ?? 0, inbox.queuedTs[roomId] ?? 0);
  if (triggering.createdAt <= (current.lastReadTs ?? 0) || triggering.createdAt <= queued) return;
  const queuedItems = inbox.items.filter((item) => item.createdAt > queued);
  const trigger: InboxItem = { id: triggering.id, roomId, roomName, senderId: triggering.senderId, text: triggering.text, createdAt: triggering.createdAt };
  const items = queuedItems.some((item) => item.id === trigger.id) ? queuedItems : [...queuedItems, trigger].sort((a, b) => a.createdAt - b.createdAt);
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
  const prompt = formatServeWakePrompt(roomName, lines);
  const admission = getOrCreatePendingAdmission(sid, roomId, delta as QueueItem[], prompt,
    delta.reduce((max, item) => Math.max(max, item.createdAt), 0), capped);
  const body: QueueBody = { id: admission.id, prompt: { text: admission.prompt }, delivery: "queue", resume: true };
  const directory = entry.directory ?? process.env.OPENCODE_DIRECTORY;
  const auth = authHeader();
  try {
    const response = await fetch(`${serveWakeUrl.replace(/\/+$/, "")}/api/session/${encodeURIComponent(sid)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}),
        ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => undefined);
    if (response.ok && admissionMatches(data, body, sid)) {
      markPendingAdmissionAdmitted(sid, roomId, admission.id);
      touchActive(sid);
      await confirmQueued(admission.maxTs);
    } else if (response.status !== 404) rejectPendingAdmission(sid, roomId, admission.id);
  } catch { /* The periodic inbox poll retries delivery. */ }
}
