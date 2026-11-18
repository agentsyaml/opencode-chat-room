import { createHash } from "node:crypto";
import { deletePendingAdmission, readPendingAdmission, savePendingAdmission } from "../state/receiver-state.ts";
import { assertDeliveryLease } from "./session-delivery.ts";

export type QueueItem = {
  id?: string;
  senderId: string;
  senderSessionID?: string;
  text: string;
  createdAt: number;
  roomKind?: "group" | "direct";
  answerQuestionExcerpt?: string;
  recalledAt?: number;
};

export type QueueBody = {
  id: string;
  prompt: { text: string };
  delivery: "queue" | "steer";
  resume: true;
};

export type PendingAdmission = {
  id: string;
  createdAt: number;
  prompt: string;
  itemCount: number;
  maxTs: number;
  capped: boolean;
  state: "pending" | "admitted";
  items: QueueItem[];
};

const PENDING_TTL_MS = 5 * 60_000;
function save(sessionID: string, roomID: string, admission: PendingAdmission, now: number): void {
  admission.createdAt ??= now;
  savePendingAdmission(sessionID, roomID, admission, admission.createdAt + PENDING_TTL_MS, now);
}

export function queueAdmissionId(
  sessionID: string,
  roomId: string,
  items: ReadonlyArray<QueueItem>,
  prompt = "",
): string {
  const fingerprint = JSON.stringify({
    sessionID,
    roomId,
    prompt,
    items: items.map((item) => [
      item.id ?? "",
      item.senderId,
      item.senderSessionID ?? "",
      item.text,
      item.createdAt,
      item.roomKind ?? "",
      item.answerQuestionExcerpt ?? "",
    ]),
  });
  return `msg_${createHash("sha256").update(fingerprint).digest("hex")}`;
}

export function pendingAdmission(
  sessionID: string,
  roomId: string,
): PendingAdmission | undefined {
  const now = Date.now();
  const admission = readPendingAdmission<PendingAdmission>(sessionID, roomId, now);
  if (admission && !Number.isFinite(admission.createdAt)) {
    admission.createdAt = now;
    save(sessionID, roomId, admission, now);
  }
  return admission;
}

export function getOrCreatePendingAdmission(
  sessionID: string,
  roomId: string,
  items: ReadonlyArray<QueueItem>,
  prompt: string,
  maxTs: number,
  capped: boolean,
): PendingAdmission {
  const now = Date.now();
  const existing = readPendingAdmission<PendingAdmission>(sessionID, roomId, now);
  const id = queueAdmissionId(sessionID, roomId, items, prompt);
  const retriesOriginal = existing?.state === "pending" && existing.items.length < items.length &&
    queueAdmissionId(sessionID, roomId, existing.items) === queueAdmissionId(sessionID, roomId, items.slice(0, existing.items.length));
  // An admitted prompt only covers the items it carried. Older unread items
  // that surfaced later must get their own admission even below its maxTs.
  const covered = existing?.state === "admitted" &&
    items.every((item) => !item.id || existing.items.some((delivered) => delivered.id === item.id));
  if (
    existing &&
    (existing.state === "admitted" ? maxTs <= existing.maxTs && covered : existing.id === id || retriesOriginal)
  ) {
    return existing;
  }
  // Keep the watermark monotonic when a retried admission fills a delivery gap
  // below an already-admitted one.
  const admissionMaxTs = existing?.state === "admitted" ? Math.max(maxTs, existing.maxTs) : maxTs;
  const admission: PendingAdmission = {
    id,
    createdAt: now,
    prompt,
    itemCount: items.length,
    maxTs: admissionMaxTs,
    capped,
    state: "pending",
    items: items.slice(-20).map((item) => ({ ...item })),
  };
  if (admissionMaxTs > 0) {
    save(sessionID, roomId, admission, now);
  }
  return admission;
}

export function prunePendingAdmission(
  sessionID: string,
  roomId: string,
  throughTs: number,
  rebuild: (items: QueueItem[]) => { prompt: string; capped: boolean },
  // Authoritative recheck: drop items the source no longer returns (recalled).
  keep?: (item: QueueItem) => boolean,
): PendingAdmission | undefined {
  const existing = pendingAdmission(sessionID, roomId);
  if (!existing) return undefined;
  if (existing.state === "admitted") {
    if (existing.maxTs <= throughTs) deletePendingAdmission(sessionID, roomId);
    return existing.maxTs <= throughTs ? undefined : existing;
  }
  const items = existing.items.filter((item) => item.createdAt > throughTs && (!keep || keep(item)));
  if (items.length === existing.items.length) return existing;
  if (!items.length) { deletePendingAdmission(sessionID, roomId); return undefined; }
  const { prompt, capped } = rebuild(items);
  const admission = { ...existing, id: queueAdmissionId(sessionID, roomId, items, prompt), prompt,
    itemCount: items.length, maxTs: Math.max(...items.map((item) => item.createdAt)), capped, items };
  save(sessionID, roomId, admission, Date.now());
  return admission;
}

export function rejectPendingAdmission(
  sessionID: string,
  roomId: string,
  admissionID: string,
): void {
  assertDeliveryLease();
  const admission = pendingAdmission(sessionID, roomId);
  if (admission?.state === "pending" && admission.id === admissionID) {
    deletePendingAdmission(sessionID, roomId);
  }
}

export function markPendingAdmissionAdmitted(
  sessionID: string,
  roomId: string,
  admissionID?: string,
): PendingAdmission | undefined {
  assertDeliveryLease();
  const now = Date.now();
  const admission = pendingAdmission(sessionID, roomId);
  if (admission && (admissionID === undefined || admission.id === admissionID)) {
    admission.state = "admitted";
    save(sessionID, roomId, admission, now);
  }
  return admission;
}

export function clearPendingAdmission(
  sessionID: string,
  roomId: string,
  confirmedTs: number,
): void {
  assertDeliveryLease();
  const admission = pendingAdmission(sessionID, roomId);
  if (!admission || confirmedTs < admission.maxTs) {
    return;
  }
  deletePendingAdmission(sessionID, roomId);
}

export function admissionMatches(
  value: unknown,
  body: QueueBody,
  sessionID: string,
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.id === body.id &&
    record.sessionID === sessionID &&
    (record.delivery === "queue" || record.delivery === "steer")
  ) {
    return true;
  }
  return isRecord(record.data)
    ? admissionMatches(record.data, body, sessionID)
    : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
