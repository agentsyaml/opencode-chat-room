// Room notices are inline events: a small icon, a tinted chip, and the time.
import { iconNode } from "./icons.js";
import { formatSystemMessage, systemMessageKind } from "./system-messages.js";

const icons = {
  join: "add",
  leave: "arrow_exit",
  remove: "delete",
  admin: "shield_checkmark",
  forward: "arrow_swap",
  reminder: "alert",
  notice: "megaphone",
};

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
  text.textContent = formatSystemMessage(message, app);
  time.className = "sys-time";
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = app.messageTime(message.createdAt);
  event.append(mark, text, time);
  row.append(event);
  return row;
}