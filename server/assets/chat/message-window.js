export function pruneMessageRows(list, messages) {
  const ids = new Set(messages.map((message) => message.id));
  for (const row of list.querySelectorAll("[data-msg-id]")) if (!ids.has(row.dataset.msgId)) row.remove();
  const days = new Set([...list.querySelectorAll("[data-msg-id]")].map((row) => row.dataset.day));
  for (const separator of list.querySelectorAll(".day-sep")) if (!days.has(separator.dataset.day)) separator.remove();
  if (!days.size) list.querySelectorAll(".gap").forEach((gap) => gap.remove());
}

export function hasMessageSelection(list) {
  const selection = getSelection();
  return Boolean(selection && !selection.isCollapsed
    && (list.contains(selection.anchorNode) || list.contains(selection.focusNode)));
}

// A held pointer or a live selection owns the viewport. Layout writes may only
// follow the bottom when neither gesture is active.
export function pointerOrSelectionActive(app) {
  if (app.state.threadPointerDown) return true;
  const list = document.querySelector("#msgList");
  return Boolean(list && hasMessageSelection(list));
}

export function followsBottom(app, threshold = -1) {
  if (pointerOrSelectionActive(app)) return false;
  const thread = document.querySelector("#thread");
  return Boolean(app.state.followBottom || (thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight <= threshold));
}

// A search jump parks one row near the top of the thread and flashes it briefly.
export function flashMessageRow(app, row) {
  const thread = document.querySelector("#thread");
  thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop) - 12;
  app.state.followBottom = false;
  // Keep a programmatic search jump from being mistaken for the reader returning to the tail.
  app.state.focusHoldUntil = performance.now() + 900;
  clearTimeout(row._jumpFlashTimer);
  row.classList.remove("jump-flash");
  void row.offsetWidth;
  row.classList.add("jump-flash");
  row._jumpFlashTimer = setTimeout(() => row.classList.remove("jump-flash"), 900);
  app.updateJump?.();
}

// Resolve app.state.focusMessageId against the loaded state and rendered rows.
export function focusedMessage(app, list, messages) {
  const id = app.state.focusMessageId;
  if (!id) return null;
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) { app.state.focusMessageId = null; return null; }
  return { id, index, existing: list.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) };
}

export function trimMessages(list, app) {
  if (list.children.length <= 400 || hasMessageSelection(list)) return;
  // Trimming removes content above the reader. While they are browsing older
  // history that would shift the viewport, so only trim near the newest tail.
  const thread = document.querySelector("#thread");
  if (thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight > 80) return;
  const saved = app.state.positions.get(app.state.room?.id), rows = [...list.querySelectorAll("[data-msg-id]")];
  const anchor = saved?.messageId && rows.find((row) => row.dataset.msgId === saved.messageId);
  if (anchor && rows.indexOf(anchor) < rows.length - 280) {
    const recent = rows.at(-300);
    while (list.firstElementChild && list.firstElementChild !== anchor) list.firstElementChild.remove();
    let next = anchor.nextElementSibling;
    while (next && next !== recent) { const after = next.nextElementSibling; next.remove(); next = after; }
    const gap = document.createElement("li"); gap.className = "gap"; app.setText(gap, "messagesBetweenOmitted"); anchor.after(gap);
    return;
  }
  while (list.children.length > 300) list.removeChild(list.firstChild);
  if (list.firstElementChild && !list.firstElementChild.classList.contains("gap")) {
    const gap = document.createElement("li"); gap.className = "gap"; app.setText(gap, "earlierMessages"); list.insertBefore(gap, list.firstChild);
  }
}
