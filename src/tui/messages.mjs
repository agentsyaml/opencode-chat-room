// Shared message helpers: ordering, sequence cursors, merging and display text.
export function messageStamp(message) {
  const value = message?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function oldestSeq(messages) {
  let oldest;
  for (const message of messages) {
    if (typeof message?.seq === "number" && (oldest === undefined || message.seq < oldest)) oldest = message.seq;
  }
  return oldest;
}

/** Merge by message id, keep the first copy, and pick up recall updates. */
export function mergeMessages(target, items) {
  if (!Array.isArray(items) || !items.length) return target;
  const known = new Map(target.map((message) => [message.id, message]));
  for (const item of items) {
    if (!item || typeof item !== "object" || !item.id) continue;
    const found = known.get(item.id);
    if (found) {
      if (item.recalledAt && !found.recalledAt) found.recalledAt = item.recalledAt;
      continue;
    }
    const copy = { ...item };
    known.set(item.id, copy);
    target.push(copy);
  }
  target.sort((a, b) => messageStamp(a) - messageStamp(b));
  return target;
}

/** Strip terminal control characters from server-provided text. */
export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\t/g, "  ");
}

function formatTime(value) {
  const date = new Date(typeof value === "number" ? value : String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "--:--";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function senderName(room, message) {
  const id = message?.senderId ?? message?.senderSessionID ?? "?";
  const person = (room?.participants ?? []).find((entry) => entry?.id === id);
  return sanitizeText(person?.name ?? id);
}

/** Display fields for one message; recalled bodies are never shown. */
export function formatMessage(message, room) {
  const recalled = Boolean(message?.recalledAt);
  return {
    time: formatTime(message?.createdAt),
    sender: senderName(room, message),
    body: recalled ? "[recalled]" : sanitizeText(message?.text),
    recalled,
    question: Boolean(message?.isQuestion),
  };
}