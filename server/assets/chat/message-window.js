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
