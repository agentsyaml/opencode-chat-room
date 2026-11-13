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

  app.loadOlderHistory = async () => {
    const room = app.state.room, entry = room && app.state.rooms.get(room.id);
    const thread = $("#thread"), list = $("#msgList");
    if (!room || !entry || loading || entry.historyComplete || entry.historyBeforeSeq == null) return;
    loading = true;
    const generation = app.state.pollGeneration;
    list.prepend(spinner);
    try {
      const page = await app.api(`/rooms/${encodeURIComponent(room.id)}/history?beforeSeq=${entry.historyBeforeSeq}&limit=100`);
      if (app.state.room?.id !== room.id || app.state.pollGeneration !== generation) return;
      const known = new Set(entry.room.messages.map((message) => message.id));
      const older = (page.messages || []).filter((message) => !known.has(message.id));
      entry.historyComplete = !page.hasMore;
      spinner.remove();
      if (older.length) {
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
        // Baseline after the fetch: polls may have grown the tail meanwhile.
        const beforeHeight = thread.scrollHeight, beforeTop = thread.scrollTop;
        list.prepend(fragment);
        if (tailSep?.classList.contains("day-sep") && new Date(older.at(-1).createdAt).toDateString() === tailSep.dataset.day) tailSep.remove();
        entry.room.messages = [...older, ...entry.room.messages].sort((left, right) => left.createdAt - right.createdAt);
        if (entry.room.messages.length > LOADED_MESSAGE_LIMIT) entry.room.messages.splice(0, entry.room.messages.length - LOADED_MESSAGE_LIMIT);
        thread.scrollTop = beforeTop + (thread.scrollHeight - beforeHeight);
        app.cacheRoomSoon?.(room.id);
        app.queueReceiptRefresh?.();
      }
      entry.historyBeforeSeq = page.hasMore ? (page.nextBeforeSeq ?? entry.room.messages[0]?.seq ?? null) : null;
    } catch { /* the next scroll toward the top retries */ }
    finally { loading = false; spinner.remove(); }
  };
}
