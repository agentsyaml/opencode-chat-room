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

export function trimMessages(list, app) {
  if (list.children.length <= 400 || hasMessageSelection(list)) return;
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
