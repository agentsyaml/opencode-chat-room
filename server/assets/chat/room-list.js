import { formatRoomPreview } from "./system-messages.js";

// The room rows in the rail and the mobile drawer share one renderer.
export function renderRoomOptions(app, list, rooms) {
    if (!list) return;
    list.textContent = "";
    const ordered = [...rooms].sort((left, right) => Number(app.state.rooms.has(right.id)) - Number(app.state.rooms.has(left.id)));
    for (const room of ordered) {
      const row = document.createElement("li"), button = document.createElement("button");
      button.type = "button";
      button.dataset.roomId = room.id;
      const entry = app.state.rooms.get(room.id);
      button.className = `room-row${app.state.room?.id === room.id ? " selected" : ""}${entry ? " joined" : ""}`;
      if (app.state.room?.id === room.id) button.setAttribute("aria-current", "page");
      button.title = app.t(entry ? "joined" : "joinAction");
      const name = document.createElement("span");
      name.className = "r-name";
      name.textContent = room.name;
      const kind = document.createElement("span");
      kind.className = "r-kind";
      if (room.kind === "direct") app.setText(kind, "direct");
      const meta = document.createElement("span");
      meta.className = "r-meta";
      const shownRoom = entry?.room || room;
      meta.textContent = app.t("roomMeta", { members: shownRoom.participants.length, count: shownRoom.messages.length });
      const preview = document.createElement("span");
      preview.className = "r-preview";
      preview.textContent = entry ? formatRoomPreview(entry, room.messages.at(-1), app) : "";
      const status = document.createElement("span");
      status.className = "r-status";
      app.setText(status, entry ? "joined" : "joinAction");
      button.append(name, kind, meta, preview, status);
      const unread = entry && app.state.room?.id !== room.id ? (entry.unreadOverflow ? 100 : entry.unreadIds.size) : 0;
      const openQuestions = Number(shownRoom.openQuestions) || 0;
      // Same badge slot as unread: a pending question shows "?" instead of a count.
      if (unread || openQuestions) {
        const badge = document.createElement("span");
        badge.className = openQuestions ? "r-badge r-badge-question" : "r-badge";
        badge.textContent = openQuestions ? "?" : (unread > 99 ? "99+" : String(unread));
        const label = openQuestions ? app.t("openQuestions", { count: openQuestions }) : app.t("unreadMessages", { count: unread });
        badge.title = label;
        badge.setAttribute("aria-label", label);
        button.append(badge);
      }
      button.addEventListener("click", () => app.joinRoom(room.id, app.state.myName || app.$("#inName").value.trim() || app.t("guest")));
      row.append(button);
      list.append(row);
    }
    // Other rooms' unread changes only reach the title through this rerender.
    app.updateTitle();
  }
