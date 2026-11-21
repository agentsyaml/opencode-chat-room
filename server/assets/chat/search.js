import { LOADED_MESSAGE_LIMIT } from "./state.js";
import { flashMessageRow } from "./message-window.js";

// Palette search: local scan first, then lazy history pages until the room's
// loaded window fills up. There is no server-side search endpoint.
export const SEARCH_RESULT_LIMIT = 100;
export const SEARCH_MESSAGE_LIMIT = LOADED_MESSAGE_LIMIT;
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_ROOM = Math.ceil(SEARCH_MESSAGE_LIMIT / PAGE_LIMIT);

export function initSearch(app) {
  app.searchMessages = (query, scope = "room") => searchMessages(app, query, scope);
  app.openSearchHit = (hit) => openSearchHit(app, hit);
}

export async function searchMessages(app, query, scope = "room") {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  if (!needle) return [];
  const activeId = app.state.room?.id;
  const roomIds = [...app.state.rooms.keys()]
    .filter((roomId) => scope === "all" || roomId === activeId)
    .sort((left, right) => {
      if (left === activeId) return -1;
      if (right === activeId) return 1;
      return latestAt(app, right) - latestAt(app, left);
    });
  const hits = [];
  for (const roomId of roomIds) {
    await collectRoomHits(app, roomId, needle, hits);
    // Keep the page responsive while several rooms are scanned.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return hits
    .sort((left, right) => right.createdAt - left.createdAt || (right.seq ?? 0) - (left.seq ?? 0))
    .slice(0, SEARCH_RESULT_LIMIT);
}

export async function openSearchHit(app, hit) {
  const roomId = hit?.roomId, messageId = hit?.messageId;
  if (!roomId || !messageId) return false;
  const entry = app.state.rooms.get(roomId);
  if (!entry?.room) return false;
  if (!entry.room.messages.some((message) => message.id === messageId)) {
    const seq = Number(hit.seq);
    // beforeSeq is exclusive: seq + 1 puts the target at the end of the page.
    if (!Number.isSafeInteger(seq)) return false;
    try {
      const page = await app.api(`/rooms/${encodeURIComponent(roomId)}/history?beforeSeq=${seq + 1}&limit=${PAGE_LIMIT}`);
      if (app.state.rooms.get(roomId) !== entry) return false;
      const messages = Array.isArray(page.messages) ? page.messages : [];
      mergeHistory(entry, roomId, messages);
      if (page.hasMore) {
        // Continue upward pagination from the oldest message now loaded.
        const oldest = entry.room.messages.find((message) => Number.isSafeInteger(message.seq))?.seq;
        if (Number.isSafeInteger(oldest)) entry.historyBeforeSeq = oldest;
      } else {
        entry.historyComplete = true;
        entry.historyBeforeSeq = null;
      }
      app.cacheRoomSoon?.(roomId);
      if (!entry.room.messages.some((message) => message.id === messageId)) return false;
    } catch { return false; }
  }
  if (app.state.room?.id !== roomId) app.activateRoom(roomId);
  if (app.state.room?.id !== roomId) return false;
  app.state.room = app.state.rooms.get(roomId)?.room || app.state.room;
  app.state.focusMessageId = messageId;
  app.state.followBottom = false;
  app.state.readAnchorGuard = null;
  app.renderMessages(false);
  const row = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
  if (!row) return false;
  flashMessageRow(app, row);
  return true;
}

async function collectRoomHits(app, roomId, needle, hits) {
  const entry = app.state.rooms.get(roomId);
  if (!entry?.room) return;
  const seen = new Set();
  const scan = (messages) => {
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.recalledAt || message.pending || message.senderId === "system") continue;
      const text = typeof message.text === "string" ? message.text : "";
      if (!text || !text.toLocaleLowerCase().includes(needle)) continue;
      hits.push({
        roomId,
        roomName: entry.room.name || roomId,
        messageId: message.id,
        seq: message.seq,
        sender: message.senderId,
        createdAt: message.createdAt,
        text,
        snippet: snippetFor(text, needle),
      });
    }
  };
  scan(entry.room.messages);
  let pages = 0;
  while (!entry.historyComplete && Number.isSafeInteger(entry.historyBeforeSeq)
      && entry.room.messages.length < SEARCH_MESSAGE_LIMIT && pages++ < MAX_PAGES_PER_ROOM) {
    try {
      const page = await app.api(`/rooms/${encodeURIComponent(roomId)}/history?beforeSeq=${entry.historyBeforeSeq}&limit=${PAGE_LIMIT}`);
      if (app.state.rooms.get(roomId) !== entry) return;
      const messages = Array.isArray(page.messages) ? page.messages : [];
      scan(messages);
      mergeHistory(entry, roomId, messages);
      const next = typeof page.nextBeforeSeq === "number" ? page.nextBeforeSeq : null;
      entry.historyComplete = !page.hasMore;
      if (entry.historyComplete) entry.historyBeforeSeq = null;
      else if (next === null || next >= entry.historyBeforeSeq) break;
      else entry.historyBeforeSeq = next;
    } catch { break; }
  }
}

function mergeHistory(entry, roomId, messages) {
  const merged = new Map(entry.room.messages.map((message) => [message.id, message]));
  for (const message of messages) if (!merged.has(message.id)) merged.set(message.id, { ...message, roomId });
  entry.room.messages = [...merged.values()]
    .sort((left, right) => left.createdAt - right.createdAt || (left.seq ?? 0) - (right.seq ?? 0))
    .slice(-LOADED_MESSAGE_LIMIT);
}

function latestAt(app, roomId) {
  return app.state.rooms.get(roomId)?.room.messages.at(-1)?.createdAt ?? 0;
}

function snippetFor(text, needle) {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return flat.slice(0, 140);
  const start = Math.max(0, index - 40), end = Math.min(flat.length, index + needle.length + 60);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}