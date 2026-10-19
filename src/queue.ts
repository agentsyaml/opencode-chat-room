import { createHash } from "node:crypto";
import { deletePendingAdmission, readPendingAdmission, savePendingAdmission } from "./receiver-state";
import { assertDeliveryLease } from "./session-delivery";

export type QueueItem = {
  id?: string;
  senderId: string;
  senderSessionID?: string;
  text: string;
  createdAt: number;
};

export type QueueBody = {
  id: string;
  prompt: { text: string };
  delivery: "queue" | "steer";
  resume: true;
};

export type PendingAdmission = {
  id: string;
  prompt: string;
  itemCount: number;
  maxTs: number;
  capped: boolean;
  state: "pending" | "admitted";
  items: QueueItem[];
};

const PENDING_TTL_MS = 5 * 60_000;
function save(sessionID: string, roomID: string, admission: PendingAdmission, now: number): void {
  savePendingAdmission(sessionID, roomID, admission, now + PENDING_TTL_MS, now);
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
      item.text,
      item.createdAt,
    ]),
  });
  return `msg_${createHash("sha256").update(fingerprint).digest("hex")}`;
}

export function pendingAdmission(
  sessionID: string,
  roomId: string,
): PendingAdmission | undefined {
  return readPendingAdmission<PendingAdmission>(sessionID, roomId, Date.now());
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
  if (
    existing &&
    (existing.state !== "admitted" || maxTs <= existing.maxTs)
  ) {
    return existing;
  }
  const admission: PendingAdmission = {
    id: queueAdmissionId(sessionID, roomId, items, prompt),
    prompt,
    itemCount: items.length,
    maxTs,
    capped,
    state: "pending",
    items: items.slice(-20).map((item) => ({ ...item })),
  };
  if (maxTs > 0) {
    save(sessionID, roomId, admission, now);
  }
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
