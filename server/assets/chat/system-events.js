// Room notices are inline events: a small icon, a tinted chip, and the time.
import { iconNode } from "./icons.js";
import { formatRelayMessage, formatSystemMessage, systemMessageKind } from "./system-messages.js";
import { renderMarkdown, renderResourceText } from "./markdown.js";

const icons = {
  join: "add",
  leave: "arrow_exit",
  remove: "delete",
  admin: "shield_checkmark",
  forward: "arrow_swap",
  reminder: "alert",
  notice: "megaphone",
};

// Notices are Markdown and switch from a pill to a card once they pass three
// rendered lines; relays always keep the message-card shape because they carry
// attachments.
function markNoticeShape(row) {
  if (row.dataset.kind === "relay") return;
  const text = row.querySelector(".sys-text");
  if (!text || !text.isConnected) return;
  const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight) || 18;
  row.dataset.long = text.getBoundingClientRect().height > lineHeight * 3 + 1 ? "true" : "false";
}

let resizeBound = false;
function bindNoticeResize() {
  if (resizeBound) return;
  resizeBound = true;
  window.addEventListener("resize", () => {
    for (const row of document.querySelectorAll('.sys[data-kind]:not([data-kind="relay"])')) markNoticeShape(row);
  }, { passive: true });
}

export function renderSystemRow(row, message, app) {
  row.className = "sys";
  row.dataset.kind = systemMessageKind(message);
  const event = document.createElement("span"), mark = document.createElement("span");
  const text = document.createElement("span"), time = document.createElement("time");
  event.className = "sys-event";
  event.setAttribute("role", "note");
  mark.className = "sys-icon";
  mark.append(iconNode(icons[row.dataset.kind] || icons.notice, "sys-icon-glyph"));
  text.className = "sys-text";
  if (row.dataset.kind === "relay") renderResourceText(text, formatRelayMessage(message, app), app);
  else renderMarkdown(text, formatSystemMessage(message, app), app);
  time.className = "sys-time";
  time.dateTime = new Date(message.createdAt).toISOString();
  // Notices and relays both put a full, muted date first; a bare clock is
  // ambiguous once a row has scrolled or came from another timezone.
  time.textContent = app.fmtTime(message.createdAt);
  event.append(mark, text, time);
  row.append(event);
  bindNoticeResize();
  requestAnimationFrame(() => markNoticeShape(row));
  return row;
}