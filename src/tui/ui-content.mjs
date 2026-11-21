// State-to-renderable syncing for the OpenTUI view. These functions rebuild
// message and room rows only when their signature changes.
import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  dim,
  fg,
  italic,
} from "@opentui/core";
import { formatMessage, messageStamp, sanitizeText } from "./messages.mjs";
import { connectionStyle } from "./ui-theme.mjs";

const clear = (container) => {
  for (const child of container.getChildren()) container.remove(child.id);
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function syncLayout(ui) {
  const { renderer, theme } = ui;
  const narrow = renderer.width < 70;
  const showRooms = !narrow;
  ui.roomsPane.visible = showRooms;
  ui.roomsPane.width = showRooms ? Math.min(30, Math.max(22, Math.floor(renderer.width * 0.3))) : 0;
  ui.roomsPane.borderColor = theme.border;
  ui.headerBox.borderColor = theme.border;
  ui.headerBox.paddingX = narrow ? 1 : 2;
  ui.statusBox.paddingX = narrow ? 1 : 2;
  ui.statusBox.borderColor = theme.border;
  ui.chatPane.paddingX = narrow ? 1 : 2;
  ui.composer.marginX = narrow ? 0 : 1;
  ui.composer.height = renderer.height < 18 ? 4 : 5;
  ui.textarea.height = ui.composer.height - 2;
  ui.prompt.height = ui.textarea.height;
  ui.statusHints.visible = !narrow;
  ui.paletteBox.left = narrow ? 0 : 1;
  ui.paletteBox.right = narrow ? 0 : 1;
  ui.paletteBox.bottom = narrow ? 0 : 1;
  ui.paletteBox.height = Math.min(16, Math.max(9, Math.floor(renderer.height / 2) + 1));
  ui.helpBox.left = narrow ? 0 : 1;
  ui.helpBox.right = narrow ? 0 : 1;
  ui.helpBox.bottom = narrow ? 0 : 1;
  ui.helpBox.height = Math.min(13, Math.max(8, renderer.height - 4));
  ui.helpBody.gap = narrow ? 1 : 4;
  ui.helpBody.paddingX = narrow ? 1 : 2;
  ui.roomsTitle.fg = theme.muted;
  ui.roomsCount.fg = theme.muted;
  ui.chatMeta.fg = theme.muted;
}

export function syncHeader(ui, state) {
  const { theme } = ui;
  const narrow = ui.renderer.width < 70;
  const left = [bold(fg(theme.accent)("opencode-chat-room"))];
  if (!narrow) {
    left.push(fg(theme.muted)("  ·  "));
    left.push(fg(theme.muted)(sanitizeText(state.host || "server")));
  }
  ui.headerLeft.content = new StyledText(left);

  const status = connectionStyle(theme, state.connection);
  const right = [];
  right.push(fg(theme.text)(sanitizeText(state.participant || "?")), fg(theme.muted)("  "));
  right.push(fg(status.color)(`${status.dot} ${status.label}`));
  ui.headerRight.content = new StyledText(right);
}

function roomLabel(room, pendingID, theme, active) {
  const pending = pendingID === room.id;
  const marker = pending ? "?" : room.joined ? "●" : "○";
  const markerColor = active ? theme.selectedFg : pending ? theme.warning : room.joined ? theme.success : theme.muted;
  const nameColor = active ? theme.selectedFg : theme.text;
  return new StyledText([
    fg(markerColor)(`${marker} `),
    fg(nameColor)(bold(sanitizeText(room.name))),
  ]);
}

export function updateRoomStyles(ui, state) {
  const selectedID = state.rooms[state.selected]?.id;
  for (const [id, entry] of ui.roomRows) {
    const room = state.rooms.find((item) => item.id === id);
    if (!room) continue;
    const active = id === selectedID;
    const hovered = id === ui.hoverRoomId;
    entry.row.backgroundColor = active ? ui.theme.selectedBg : hovered ? ui.theme.raised : "transparent";
    entry.label.content = roomLabel(room, state.pending?.roomId, ui.theme, active);
    entry.count.fg = active ? ui.theme.selectedFg : ui.theme.muted;
  }
  if (selectedID && selectedID !== ui.selectedRoomID) {
    ui.selectedRoomID = selectedID;
    ui.pendingRoomScroll = `room-${selectedID}`;
  }
}

export function syncRooms(ui, state) {
  const pendingID = state.pending?.roomId;
  const signature = `${ui.theme.mode}|${pendingID ?? ""}|${state.rooms
    .map((room) => `${room.id}:${room.name}:${room.joined}:${room.participants.length}`)
    .join("|")}`;
  ui.roomsCount.content = state.rooms.length ? String(state.rooms.length) : "";
  if (signature !== ui.roomSignature) {
    ui.roomSignature = signature;
    clear(ui.roomContent);
    ui.roomRows.clear();
    if (!state.rooms.length) {
      ui.roomContent.add(new TextRenderable(ui.renderer, {
        id: "room-empty",
        height: 1,
        wrapMode: "none",
        fg: ui.theme.muted,
        paddingX: 1,
        content: "No rooms yet",
      }));
    }
    for (const [index, room] of state.rooms.entries()) {
      const row = new BoxRenderable(ui.renderer, {
        id: `room-${room.id}`,
        height: 1,
        flexDirection: "row",
        gap: 1,
        paddingX: 1,
      });
      const label = new TextRenderable(ui.renderer, {
        id: `room-label-${room.id}`,
        flexGrow: 1,
        height: 1,
        wrapMode: "none",
        truncate: true,
        content: roomLabel(room, pendingID, ui.theme, false),
      });
      const count = new TextRenderable(ui.renderer, {
        id: `room-count-${room.id}`,
        flexShrink: 0,
        height: 1,
        wrapMode: "none",
        fg: ui.theme.muted,
        content: String(room.participants.length),
      });
      row.add(label);
      row.add(count);
      row.onMouseOver = () => {
        ui.hoverRoomId = room.id;
        updateRoomStyles(ui, state);
        ui.renderer.requestRender();
      };
      row.onMouseOut = () => {
        if (ui.hoverRoomId === room.id) ui.hoverRoomId = null;
        updateRoomStyles(ui, state);
        ui.renderer.requestRender();
      };
      row.onMouseUp = (event) => {
        if (event.button !== 0) return;
        ui.app.selectRoom(index);
        void ui.app.openRoom(index);
      };
      ui.roomContent.add(row);
      ui.roomRows.set(room.id, { row, label, count });
    }
  }
  updateRoomStyles(ui, state);
}

function messageChunks(ui, message, info) {
  const { theme } = ui;
  const chunks = [];
  const highlighted = message.id === ui.app.state.highlight;
  if (highlighted) chunks.push(bold(fg(theme.accent)("▸ ")));
  if (info.question) chunks.push(bold(fg(theme.warning)("? ")));
  chunks.push(dim(`${info.time} `));
  const own = message.senderId === ui.app.state.participant;
  chunks.push(bold(fg(own ? theme.accent : theme.text)(info.sender)));
  return chunks;
}

function messageBody(ui, info) {
  if (info.recalled) return new StyledText([dim(italic(info.body))]);
  return new StyledText([fg(ui.theme.text)(info.body)]);
}

export function syncMessages(ui, state) {
  const { current, pending, joined, messages, highlight } = state;
  const messageKey = messages
    .map((message) => `${message.id}:${message.recalledAt ? 1 : 0}:${message.isQuestion ? 1 : 0}:${message.text?.length ?? 0}`)
    .join("|");
  const signature = `${ui.theme.mode}:${current?.id ?? ""}:${joined}:${pending?.roomId ?? ""}:${pending?.message ?? ""}:${highlight ?? ""}:${messageKey}`;

  if (current) {
    ui.chatTitle.content = new StyledText([bold(fg(ui.theme.accent)(`# ${sanitizeText(current.name)}`))]);
    ui.chatMeta.content = plural(current.participants.length, "member");
    ui.chatMeta.fg = ui.theme.muted;
  } else {
    ui.chatTitle.content = new StyledText([fg(ui.theme.muted)("# no room selected")]);
    ui.chatMeta.content = "";
  }

  if (signature === ui.messageSignature) return;
  const previousTop = ui.scrollBox.scrollTop;
  const wasAtBottom = ui.scrollBox.scrollHeight - ui.scrollBox.scrollTop - ui.scrollBox.viewport.height < 2;
  ui.messageSignature = signature;

  clear(ui.messageContent);
  ui.pendingScrollTo = null;
  ui.pendingBottom = false;

  if (pending && pending.roomId === current?.id) {
    addNotice(ui, "pending", sanitizeText(pending.message), ui.theme.warning);
    addNotice(ui, "pending-wait", "Waiting for approval...", ui.theme.muted);
  } else if (!current) {
    addNotice(ui, "empty", "Select a room and press Enter.", ui.theme.muted);
  } else if (!joined) {
    addNotice(ui, "empty", "Not joined · press Enter to join again.", ui.theme.muted);
  } else if (!messages.length) {
    addNotice(ui, "empty", "No messages yet. Say hello.", ui.theme.muted);
  } else {
    messages.forEach((message, index) => {
      const info = formatMessage(message, current);
      const previous = messages[index - 1];
      const gap = previous
        ? previous.senderId !== message.senderId || messageStamp(message) - messageStamp(previous) > 300000
        : false;
      const highlighted = message.id === highlight;
      const block = new BoxRenderable(ui.renderer, {
        id: `message-${message.id}`,
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
        marginTop: index === 0 || gap ? 1 : 0,
      });
      block.add(new TextRenderable(ui.renderer, {
        id: `message-head-${message.id}`,
        width: "100%",
        height: 1,
        wrapMode: "none",
        truncate: true,
        content: new StyledText(messageChunks(ui, message, info)),
      }));
      block.add(new TextRenderable(ui.renderer, {
        id: `message-body-${message.id}`,
        width: "100%",
        flexShrink: 0,
        wrapMode: "word",
        marginLeft: 2,
        paddingRight: 1,
        bg: highlighted ? ui.theme.raised : undefined,
        content: messageBody(ui, info),
      }));
      ui.messageContent.add(block);
    });
    if (highlight) ui.pendingScrollTo = `message-${highlight}`;
    else if (wasAtBottom) ui.pendingBottom = true;
  }

  if (!ui.pendingScrollTo && !ui.pendingBottom && previousTop > 0) {
    ui.scrollBox.scrollTop = previousTop;
  }
}

function addNotice(ui, id, text, color) {
  ui.messageContent.add(new TextRenderable(ui.renderer, {
    id: `message-${id}`,
    width: "100%",
    flexShrink: 0,
    wrapMode: "char",
    content: new StyledText([fg(color)(sanitizeText(text))]),
  }));
}

export function syncComposer(ui, state) {
  const draft = String(state.draft ?? "");
  ui.textarea.placeholderColor = ui.theme.faint;
  ui.textarea.textColor = ui.theme.text;
  ui.textarea.focusedTextColor = ui.theme.text;
  ui.prompt.fg = ui.theme.accent;
  if (ui.textarea.plainText === draft) return;
  ui.syncingComposer = true;
  try {
    ui.textarea.setText(draft);
    // setText can leave the caret at the start. A character typed while the
    // room list was focused would then be followed by the rest before it.
    ui.textarea.cursorOffset = draft.length;
  } finally {
    ui.syncingComposer = false;
  }
}

export function syncStatus(ui, state) {
  const { theme } = ui;
  const text = state.status || "Ready";
  ui.statusLine.content = sanitizeText(text);
  ui.statusLine.fg = state.statusKind === "error"
    ? theme.error
    : state.statusKind === "success"
      ? theme.success
      : theme.muted;
  const status = connectionStyle(theme, state.connection);
  ui.statusHints.content = ui.renderer.width < 70
    ? "? help"
    : `${status.dot} ${status.label} · Tab focus · Alt+Space palette · ? help`;
  ui.statusHints.fg = theme.muted;
}

export function syncFocus(ui, state) {
  const target = state.palette ? "palette" : state.help ? "help" : state.focus === "composer" ? "composer" : "rooms";
  if (target !== ui.focusKey) {
    if (ui.focusKey === "composer") ui.textarea.blur();
    if (ui.focusKey === "palette") ui.paletteInput.blur();
    if (target === "composer") ui.textarea.focus();
    if (target === "palette") ui.paletteInput.focus();
    ui.focusKey = target;
  }
  const accent = target === "composer";
  ui.composer.borderColor = accent ? ui.theme.accent : ui.theme.border;
  ui.prompt.fg = accent ? ui.theme.accent : ui.theme.muted;
}

export function syncPalette(ui, state) {
  const { theme, paletteBox } = ui;
  const palette = state.palette;
  paletteBox.visible = Boolean(palette);
  if (!palette) return;

  paletteBox.backgroundColor = theme.surface;
  paletteBox.borderColor = theme.accent;
  ui.paletteBar.backgroundColor = theme.raised;
  ui.paletteTitle.fg = theme.text;
  ui.paletteScope.fg = theme.muted;
  ui.palettePrompt.fg = theme.accent;
  ui.paletteInput.placeholderColor = theme.faint;
  ui.paletteInput.textColor = theme.text;
  ui.paletteInput.focusedTextColor = theme.text;
  ui.paletteList.textColor = theme.text;
  ui.paletteList.focusedTextColor = theme.text;
  ui.paletteList.selectedBackgroundColor = theme.selectedBg;
  ui.paletteList.selectedTextColor = theme.selectedFg;

  const scope = palette.scope === "all" ? "all joined rooms" : "this room";
  ui.paletteTitle.content = palette.mode === "prompt" ? "New room" : palette.mode === "search" ? "Search messages" : "Palette";
  ui.paletteScope.content = palette.mode === "prompt" ? "create" : palette.mode === "search" ? scope : "commands";
  ui.paletteInput.placeholder = palette.mode === "prompt"
    ? "Room name"
    : palette.mode === "search"
      ? "Type to search messages"
      : "Type to search or run a command";

  const value = palette.mode === "prompt" ? palette.prompt?.value ?? "" : palette.query;
  if (ui.paletteInput.value !== value) {
    ui.syncingPalette = true;
    try {
      ui.paletteInput.value = value;
    } finally {
      ui.syncingPalette = false;
    }
  }

  let options;
  if (palette.mode === "commands") {
    options = ui.app.paletteCommands().map((command) => ({ name: command.label, description: "", value: command.id }));
  } else if (palette.mode === "prompt") {
    options = [{ name: "Enter creates the room", description: "", value: "" }];
  } else if (!palette.results.length) {
    options = [{ name: palette.searching ? "Searching..." : "No matches", description: "", value: "" }];
  } else {
    options = palette.results.map((result) => {
      const info = formatMessage(result.message, null);
      return {
        name: `${sanitizeText(result.roomName)}  ${info.time} ${info.sender}  ${sanitizeText(result.snippet)}`,
        description: "",
        value: result.message.id,
      };
    });
  }
  ui.paletteList.options = options;
  ui.paletteList.setSelectedIndex(Math.min(palette.selected, Math.max(0, options.length - 1)));

  const footer = palette.error
    || (palette.mode === "prompt"
      ? "Enter create · Esc close"
      : palette.mode === "search"
        ? `↑↓ select · Enter open · Tab: ${palette.scope === "all" ? "this room" : "all rooms"} · Esc close${palette.searching ? " · searching..." : ""}`
        : "↑↓ select · Enter run · Esc close");
  ui.paletteHint.content = `  ${sanitizeText(footer)}`;
  ui.paletteHint.fg = palette.error ? theme.error : theme.muted;
}

function shortcutChunks(title, rows, theme) {
  const chunks = [bold(fg(theme.accent)(`${title}\n`))];
  for (const [key, label] of rows) {
    chunks.push(fg(theme.accent)(key.padEnd(12)));
    chunks.push(fg(theme.text)(`${label}\n`));
  }
  return chunks;
}

export function syncHelp(ui, state) {
  const show = Boolean(state.help) && !state.palette;
  ui.helpBox.visible = show;
  if (!show) return;
  ui.helpBox.borderColor = ui.theme.border;
  ui.helpBox.backgroundColor = ui.theme.surface;
  ui.helpBar.backgroundColor = ui.theme.raised;
  ui.helpTitle.fg = ui.theme.text;
  ui.helpClose.fg = ui.theme.muted;
  ui.helpFooter.fg = ui.theme.muted;
  const signature = ui.theme.mode;
  if (signature === ui.helpSignature) return;
  ui.helpSignature = signature;
  ui.helpLeft.content = new StyledText(shortcutChunks("Navigation", [
    ["↑ / ↓", "select room"],
    ["Enter", "open / join"],
    ["Tab", "focus composer"],
    ["PgUp / PgDn", "scroll messages"],
    ["Alt+Home", "first message"],
    ["Alt+End", "last message"],
  ], ui.theme));
  ui.helpRight.content = new StyledText(shortcutChunks("Composer", [
    ["Enter", "send message"],
    ["Ctrl+J", "insert newline"],
    ["Esc", "clear / blur"],
    ["Alt+Space", "palette / search"],
    ["Ctrl+R", "refresh rooms"],
    ["Ctrl+C", "quit"],
  ], ui.theme));
}