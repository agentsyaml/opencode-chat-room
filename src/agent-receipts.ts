import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { databasePath, formatNotificationLines, recordMessageReceipts, timeOf } from "./store";
import { acquireDeliveryLease, deleteReceiptCandidate, markReceiptCandidateReady, ownsDeliveryLease, receiptCandidates, readyReceiptCandidates, releaseDeliveryLease, saveReceiptCandidate } from "./receiver-state";

// shortcut: expire unobserved proofs after seven days; increase if hosts may stay disconnected longer.
const UNOBSERVED_TTL = 7 * 24 * 60 * 60_000;
type Item = { id?: string; text: string; senderId?: string; createdAt?: number };
type CappedItem = Item & { senderId: string; createdAt: number };
export type ReceiptCandidate = {
  admissionID: string; sessionID: string; roomID: string; membershipID: string;
  receiverOwnerID: string; destination: string; messageIDs: string[]; textHash: string; createdAt: number;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function hasCappedMetadata(item: Item): item is CappedItem {
  return typeof item.senderId === "string" && typeof item.createdAt === "number" && Number.isSafeInteger(item.createdAt) &&
    !/[\r\n]/.test(item.senderId) && !/[\r\n]/.test(item.text);
}

export function receiptDestination(center: string): string {
  if (!center) return path.resolve(databasePath());
  const url = new URL(center);
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function prepareReceiptCandidate(input: {
  admissionID: string; sessionID: string; roomID: string; membershipID?: string;
  receiverOwnerID?: string; destination: string; items: Item[]; prompt: string; capped: boolean;
}): ReceiptCandidate | undefined {
  if (!input.membershipID || input.membershipID.length > 128 || !input.receiverOwnerID ||
    !input.sessionID || input.sessionID.length > 128 || !input.roomID || input.roomID.length > 128 ||
    !input.items.length || input.items.length > 500 || input.items.some((item) => typeof item.id !== "string" || !item.id || item.id.length > 128 || typeof item.text !== "string")) return undefined;
  // shortcut: capped multiline notifications fail closed; use structured rendered-line metadata if partial proofs become necessary.
  let evidenceItems = input.items;
  if (input.capped) {
    const cappedItems = input.items.filter(hasCappedMetadata);
    if (cappedItems.length !== input.items.length) return undefined;
    const closing = input.prompt.lastIndexOf("\n</notification>");
    if (closing < 0) return undefined;
    const renderedCounts = new Map<string, number>();
    for (const item of cappedItems) {
      const prefix = `\n- [${timeOf(item.createdAt)}] ${item.senderId}: `;
      const key = `${prefix}${item.text}`;
      renderedCounts.set(key, (renderedCounts.get(key) ?? 0) + 1);
    }
    let tail = input.prompt.slice(0, closing);
    evidenceItems = [];
    for (let index = cappedItems.length - 1; index >= 0; index--) {
      const item = cappedItems[index]!;
      const prefix = `\n- [${timeOf(item.createdAt)}] ${item.senderId}: `;
      const line = tail.lastIndexOf(prefix);
      if (line < 0) break;
      const displayedText = tail.slice(line + prefix.length);
      if (displayedText.includes("\n")) break;
      if (displayedText === item.text && renderedCounts.get(`${prefix}${item.text}`) === 1 && !formatNotificationLines([item]).capped) evidenceItems.push(item);
      tail = tail.slice(0, line);
    }
    evidenceItems.reverse();
  }
  if (!evidenceItems.length) return undefined;
  const candidate: ReceiptCandidate = {
    admissionID: input.admissionID, sessionID: input.sessionID, roomID: input.roomID,
    membershipID: input.membershipID, receiverOwnerID: input.receiverOwnerID,
    destination: input.destination, messageIDs: evidenceItems.map((item) => item.id!),
    textHash: hash(input.prompt), createdAt: Date.now(),
  };
  const key = hash(JSON.stringify([candidate.sessionID, candidate.admissionID, candidate.roomID, candidate.destination, candidate.receiverOwnerID, candidate.membershipID]));
  try { saveReceiptCandidate(key, candidate, candidate.createdAt + UNOBSERVED_TTL); }
  catch { return undefined; }
  return candidate;
}

function contextText(message: unknown): { id: string; text: string } | undefined {
  if (!message || typeof message !== "object") return;
  const value = message as { id?: unknown; role?: unknown; content?: unknown };
  if (value.role !== "user" || typeof value.id !== "string" || !Array.isArray(value.content)) return;
  if (!value.content.every((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")) return;
  return { id: value.id, text: value.content.map((part) => (part as { text: string }).text).join("") };
}

export function observeReceiptContext(sessionID: string, messages: readonly unknown[], destination: string, ownerID: string): number {
  let observed = 0;
  for (const message of messages) {
    const context = contextText(message);
    if (!context) continue;
    for (const candidate of receiptCandidates<ReceiptCandidate>(sessionID, context.id, destination, ownerID, Date.now())) {
      if (hash(context.text) !== candidate.textHash) continue;
      const key = hash(JSON.stringify([candidate.sessionID, candidate.admissionID, candidate.roomID, candidate.destination, candidate.receiverOwnerID, candidate.membershipID]));
      if (markReceiptCandidateReady(key)) observed++;
    }
  }
  return observed;
}

const receiptFlushes = new Map<string, Promise<void>>();
// shortcut: cursor resets on process restart; persist it if restart storms delay backlog progress.
const receiptFlushCursors = new Map<string, string>();
const RECEIPT_FLUSH_LIMIT = 8;
const RECEIPT_FLUSH_LEASE_MS = 30_000;
export function flushReceiptCandidates(input: {
  destination: string; receiverOwnerID?: string; center?: string; token?: string;
}): Promise<void> {
  const key = JSON.stringify([input.destination, input.receiverOwnerID ?? ""]);
  const running = receiptFlushes.get(key);
  if (running) return running;
  const task = flushOneReceiptCandidate(input, key).finally(() => receiptFlushes.delete(key));
  receiptFlushes.set(key, task);
  return task;
}

async function flushOneReceiptCandidate(input: { destination: string; receiverOwnerID?: string; center?: string; token?: string }, cursorKey: string): Promise<void> {
  const leaseKey = `receipt-flush:${hash(cursorKey)}`;
  const holder = randomUUID(), now = Date.now();
  if (!acquireDeliveryLease(leaseKey, holder, now, now + RECEIPT_FLUSH_LEASE_MS)) return;
  try {
  let candidates: Array<{ id: string; value: ReceiptCandidate }>;
  let cursor = receiptFlushCursors.get(cursorKey) ?? "";
  try {
    candidates = readyReceiptCandidates<ReceiptCandidate>(input.destination, input.receiverOwnerID, Date.now(), RECEIPT_FLUSH_LIMIT, cursor);
    if (!candidates.length && cursor) {
      cursor = "";
      candidates = readyReceiptCandidates<ReceiptCandidate>(input.destination, input.receiverOwnerID, Date.now(), RECEIPT_FLUSH_LIMIT);
    }
  }
  catch { return; }
  if (candidates.length) receiptFlushCursors.set(cursorKey, candidates.at(-1)!.id);
  for (const { id, value } of candidates) {
    try {
      if (input.center) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (input.token) headers.Authorization = `Bearer ${input.token}`;
        const response = await fetch(`${input.center.replace(/\/+$/, "")}/rooms/${encodeURIComponent(value.roomID)}/receipts`, {
          method: "POST", headers, body: JSON.stringify({ sessionID: value.sessionID, membershipID: value.membershipID,
            receiverOwnerID: value.receiverOwnerID, messageIDs: value.messageIDs, evidence: "context" }),
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const body = await response.json() as { acceptedIDs?: unknown };
          const accepted = new Set(Array.isArray(body.acceptedIDs) ? body.acceptedIDs.filter((item): item is string => typeof item === "string") : []);
          if (value.messageIDs.every((messageID) => accepted.has(messageID)) && ownsDeliveryLease(leaseKey, holder, Date.now())) deleteReceiptCandidate(id);
        } else if (response.status === 400 || response.status === 404 || response.status === 409) deleteReceiptCandidate(id);
      } else {
        await recordMessageReceipts(value.roomID, value.sessionID, value.messageIDs, "context", {
          membershipID: value.membershipID, receiverOwnerID: value.receiverOwnerID,
        });
        deleteReceiptCandidate(id);
      }
    } catch { /* Transient upload failures keep ready proof for the next receiver sweep. */ }
  }
  } finally { releaseDeliveryLease(leaseKey, holder); }
}
