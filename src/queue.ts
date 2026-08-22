import { createHash } from "node:crypto";

export type QueueItem = {
  id?: string;
  senderId: string;
  text: string;
  createdAt: number;
};

export type QueueBody = {
  id: string;
  prompt: { text: string };
  delivery: "queue";
  resume: true;
};

export type PendingAdmission = {
  id: string;
  prompt: string;
  itemCount: number;
  maxTs: number;
  capped: boolean;
  state: "pending" | "admitted";
};

type PendingEntry = {
  admission: PendingAdmission;
  expiresAt: number;
};

// ponytail: lazy expiry avoids one timer per admission; the hard cap keeps the
// module-level map bounded even when no later queue activity triggers pruning.
const PENDING_TTL_MS = 5 * 60_000;
const MAX_PENDING_ADMISSIONS = 1024;
const pending = new Map<string, PendingEntry>();

function keyFor(sessionID: string, roomId: string): string {
  return `${sessionID}|${roomId}`;
}

function pruneExpired(now: number): void {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(key);
    }
  }
}

function pendingEntry(key: string, now: number): PendingEntry | undefined {
  pruneExpired(now);
  return pending.get(key);
}

function rememberPending(
  key: string,
  admission: PendingAdmission,
  now: number,
): void {
  pending.delete(key);
  pending.set(key, {
    admission,
    expiresAt: now + PENDING_TTL_MS,
  });
  while (pending.size > MAX_PENDING_ADMISSIONS) {
    const oldest = pending.keys().next();
    if (oldest.done) {
      break;
    }
    pending.delete(oldest.value);
  }
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
  return pendingEntry(keyFor(sessionID, roomId), Date.now())?.admission;
}

export function getOrCreatePendingAdmission(
  sessionID: string,
  roomId: string,
  items: ReadonlyArray<QueueItem>,
  prompt: string,
  maxTs: number,
  capped: boolean,
): PendingAdmission {
  const key = keyFor(sessionID, roomId);
  const now = Date.now();
  const existing = pendingEntry(key, now)?.admission;
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
  };
  if (maxTs > 0) {
    rememberPending(key, admission, now);
  }
  return admission;
}

export function rejectPendingAdmission(
  sessionID: string,
  roomId: string,
  admissionID: string,
): void {
  const key = keyFor(sessionID, roomId);
  const admission = pendingEntry(key, Date.now())?.admission;
  if (admission?.state === "pending" && admission.id === admissionID) {
    pending.delete(key);
  }
}

export function markPendingAdmissionAdmitted(
  sessionID: string,
  roomId: string,
  admissionID?: string,
): PendingAdmission | undefined {
  const admission = pendingEntry(keyFor(sessionID, roomId), Date.now())?.admission;
  if (admission && (admissionID === undefined || admission.id === admissionID)) {
    admission.state = "admitted";
  }
  return admission;
}

export function clearPendingAdmission(
  sessionID: string,
  roomId: string,
  confirmedTs: number,
): void {
  const key = keyFor(sessionID, roomId);
  const admission = pendingEntry(key, Date.now())?.admission;
  if (!admission || confirmedTs < admission.maxTs) {
    return;
  }
  pending.delete(key);
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
  const admission =
    typeof record.data === "object" && record.data !== null
      ? (record.data as Record<string, unknown>)
      : record;
  return (
    admission.id === body.id &&
    admission.sessionID === sessionID &&
    admission.delivery === "queue"
  );
}
