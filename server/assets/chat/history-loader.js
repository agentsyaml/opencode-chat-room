import { LOADED_MESSAGE_LIMIT } from "./state.js";

// IM-style upward pagination: near the top of the thread, fetch the previous
// history page and prepend it without moving the reader's viewport.
export function initHistoryLoader(app) {
  const $ = app.$;
  let loading = false;
  const spinner = document.createElement("li");
  spinner.className = "history-loading";
  spinner.setAttribute("role", "status");
  const wheel = document.createElement("span");
  wheel.className = "history-spinner";
  wheel.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.dataset.i18n = "loadingHistory";
  label.textContent = app.t("loadingHistory");
  spinner.append(wheel, label);

  const prependOlder = (older, thread, list) => {
    const tailSep = list.firstElementChild;
    const fragment = document.createDocumentFragment();
    let day = null;
    for (const message of older) {
      const messageDay = new Date(message.createdAt).toDateString();
      if (messageDay !== day) {
        const separator = document.createElement("li");
        separator.className = "day-sep";
        separator.dataset.day = messageDay;
        separator.textContent = app.dayText(message.createdAt);
        fragment.append(separator);
        day = messageDay;
      }
      const row = app.renderMessage(message, false);
      row.dataset.day = messageDay;
      fragment.append(row);
    }
    const beforeHeight = thread.scrollHeight, beforeTop = thread.scrollTop;
    list.prepend(fragment);
    if (tailSep?.classList.contains("day-sep") && new Date(older.at(-1).createdAt).toDateString() === tailSep.dataset.day) tailSep.remove();
    app.cancelThreadScrollAnimation?.();
    thread.scrollTop = beforeTop + (thread.scrollHeight - beforeHeight);
    app.queueReceiptRefresh?.();
  };

  app.loadOlderHistory = async () => {
    const room = app.state.room, entry = room && app.state.rooms.get(room.id);
    const thread = $("#thread"), list = $("#msgList");
    if (!room || !entry || loading) return;
    loading = true;
    const generation = app.state.pollGeneration;
    try {
      const firstRow = list.querySelector("[data-msg-id]");
      const cachedIndex = firstRow ? entry.room.messages.findIndex((message) => message.id === firstRow.dataset.msgId) : -1;
      if (cachedIndex > 0) {
        prependOlder(entry.room.messages.slice(Math.max(0, cachedIndex - 100), cachedIndex), thread, list);
        return;
      }
      if (entry.historyComplete || entry.historyBeforeSeq == null) return;
      list.prepend(spinner);
      const page = await app.api(`/rooms/${encodeURIComponent(room.id)}/history?beforeSeq=${entry.historyBeforeSeq}&limit=100`);
      if (app.state.room?.id !== room.id || app.state.pollGeneration !== generation) return;
      const known = new Set(entry.room.messages.map((message) => message.id));
      const older = (page.messages || []).filter((message) => !known.has(message.id));
      entry.historyComplete = !page.hasMore;
      spinner.remove();
      if (older.length) {
        prependOlder(older, thread, list);
        entry.room.messages = [...older, ...entry.room.messages].sort((left, right) => left.createdAt - right.createdAt);
        if (entry.room.messages.length > LOADED_MESSAGE_LIMIT) entry.room.messages.splice(0, entry.room.messages.length - LOADED_MESSAGE_LIMIT);
        app.cacheRoomSoon?.(room.id);
      }
      entry.historyBeforeSeq = page.hasMore ? (page.nextBeforeSeq ?? entry.room.messages[0]?.seq ?? null) : null;
    } catch { /* the next scroll toward the top retries */ }
    finally { loading = false; spinner.remove(); }
  };
}
