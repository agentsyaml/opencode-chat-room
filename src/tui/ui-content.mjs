// State-to-renderable syncing for the OpenTUI view. These functions rebuild
// message and room rows only when their signature changes.
import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import { formatMessage, messageStamp, sanitizeText } from "./messages.mjs";
import { addNotice, buildMessageBlock, hashText, markdownStyle } from "./message-view.mjs";
import { syncMentionHighlights } from "./ui-mentions.mjs";
import { connectionStyle } from "./ui-theme.mjs";

const clear = (container) => {
  for (const child of container.getChildren()) {
    container.remove(child.id);
    child.destroyRecursively?.();
  }
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

  ui.pendingScrollTo = null;
  ui.pendingBottom = false;

  if (pending && pending.roomId === current?.id) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "pending", sanitizeText(pending.message), ui.theme.warning);
    addNotice(ui, "pending-wait", "Waiting for approval...", ui.theme.muted);
  } else if (!current) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", "Select a room and press Enter.", ui.theme.muted);
  } else if (!joined) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", "Not joined · press Enter to join again.", ui.theme.muted);
  } else if (!messages.length) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", "No messages yet. Say hello.", ui.theme.muted);
  } else {
    if (!ui.messageBlocks.length && ui.messageContent.getChildren().length) clear(ui.messageContent);
    const nextBlocks = [];
    messages.forEach((message, index) => {
      const info = formatMessage(message, current);
      const previous = messages[index - 1];
      const gap = previous
        ? previous.senderId !== message.senderId || messageStamp(message) - messageStamp(previous) > 300000
        : false;
      const highlighted = message.id === highlight;
      const key = [
        ui.theme.mode,
        current.id,
        message.id,
        message.recalledAt ? 1 : 0,
        message.isQuestion ? 1 : 0,
        message.senderId,
        message.createdAt,
        highlighted ? 1 : 0,
        hashText(info.body),
      ].join("|");
      const existing = ui.messageBlocks[index];
      let block;
      if (existing?.key === key) {
        block = existing.block;
        block.marginTop = index === 0 || gap ? 1 : 0;
      } else {
        if (existing) {
          ui.messageContent.remove(existing.block.id);
          existing.block.destroyRecursively();
        }
        block = buildMessageBlock(ui, message, info, highlighted, index === 0 || gap ? 1 : 0);
        ui.messageContent.add(block, index);
      }
      nextBlocks.push({ key, block });
    });
    for (const stale of ui.messageBlocks.slice(messages.length)) {
      ui.messageContent.remove(stale.block.id);
      stale.block.destroyRecursively();
    }
    ui.messageBlocks = nextBlocks;
    if (highlight) ui.pendingScrollTo = `message-${highlight}`;
    else if (wasAtBottom) ui.pendingBottom = true;
  }

  if (!ui.pendingScrollTo && !ui.pendingBottom && previousTop > 0) {
    ui.scrollBox.scrollTop = previousTop;
  }
}

export function syncComposer(ui, state) {
  const draft = String(state.draft ?? "");
  ui.textarea.placeholderColor = ui.theme.faint;
  ui.textarea.textColor = ui.theme.text;
  ui.textarea.focusedTextColor = ui.theme.text;
  ui.prompt.fg = ui.theme.accent;
  if (ui.textarea.plainText === draft) {
    syncMentionHighlights(ui, state);
    return;
  }
  ui.syncingComposer = true;
  try {
    ui.textarea.setText(draft);
    // setText can leave the caret at the start. A character typed while the
    // room list was focused would then be followed by the rest before it.
    ui.textarea.cursorOffset = draft.length;
  } finally {
    ui.syncingComposer = false;
  }
  ui.mentionSignature = "";
  syncMentionHighlights(ui, state);
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
  const paletteInput = Boolean(state.palette) && ["commands", "search", "prompt"].includes(state.palette.mode);
  if (target !== ui.focusKey) {
    if (ui.focusKey === "composer") ui.textarea.blur();
    if (ui.focusKey === "palette") ui.paletteInput.blur();
    if (target === "composer") ui.textarea.focus();
    if (target === "palette" && paletteInput) ui.paletteInput.focus();
    ui.focusKey = target;
  }
  if (ui.paletteInputMode !== paletteInput) {
    if (paletteInput) ui.paletteInput.focus();
    else ui.paletteInput.blur();
    ui.paletteInputMode = paletteInput;
  }
  const accent = target === "composer";
  ui.composer.borderColor = accent ? ui.theme.accent : ui.theme.border;
  ui.prompt.fg = accent ? ui.theme.accent : ui.theme.muted;
}

export function syncPalette(ui, state) {
  const { theme, paletteBox } = ui;
  const palette = state.palette;
  paletteBox.visible = Boolean(palette);
  if (!palette) {
    ui.detailSignature = "";
    return;
  }

  const mode = palette.mode;
  const isInput = mode === "commands" || mode === "search" || mode === "prompt";
  const isList = mode === "commands" || mode === "search" || mode === "info";
  const isDetail = mode === "detail";
  const isConfirm = mode === "confirm";

  paletteBox.backgroundColor = theme.surface;
  paletteBox.borderColor = theme.accent;
  ui.paletteBar.backgroundColor = theme.raised;
  ui.paletteTitle.fg = theme.text;
  ui.paletteScope.fg = theme.muted;
  ui.palettePrompt.fg = theme.accent;
  ui.paletteInputRow.visible = isInput;
  ui.paletteList.visible = isList;
  ui.paletteDetailScroll.visible = isDetail;
  ui.paletteConfirm.visible = isConfirm;
  ui.paletteInput.placeholderColor = theme.faint;
  ui.paletteInput.textColor = theme.text;
  ui.paletteInput.focusedTextColor = theme.text;
  ui.paletteList.textColor = theme.text;
  ui.paletteList.focusedTextColor = theme.text;
  ui.paletteList.selectedBackgroundColor = theme.selectedBg;
  ui.paletteList.selectedTextColor = theme.selectedFg;

  const scope = palette.scope === "all" ? "all joined rooms" : "this room";
  const defaultTitle = mode === "prompt"
    ? "New room"
    : mode === "search"
      ? "Search messages"
      : "Palette";
  ui.paletteTitle.content = palette.title || defaultTitle;
  ui.paletteScope.content = palette.subtitle
    || (mode === "prompt" ? "create" : mode === "search" ? scope : "commands");
  ui.paletteInput.placeholder = mode === "prompt"
    ? palette.prompt?.label || "Enter a value"
    : mode === "search"
      ? "Type to search messages"
      : "Type to search or run a command";

  const value = mode === "prompt" ? palette.prompt?.value ?? "" : palette.query ?? "";
  if (ui.paletteInput.value !== value) {
    ui.syncingPalette = true;
    try {
      ui.paletteInput.value = value;
    } finally {
      ui.syncingPalette = false;
    }
  }

  let options = [];
  if (mode === "commands") {
    options = ui.app.paletteCommands().map((command) => ({ name: command.label, description: "", value: command.id }));
  } else if (mode === "search") {
    options = !palette.results.length
      ? [{ name: palette.searching ? "Searching..." : "No matches", description: "", value: "" }]
      : palette.results.map((result) => {
        const info = formatMessage(result.message, null);
        return {
          name: `${sanitizeText(result.roomName)}  ${info.time} ${info.sender}  ${sanitizeText(result.snippet)}`,
          description: "",
          value: result.message.id,
        };
      });
  } else if (mode === "info") {
    options = palette.loading
      ? [{ name: "Loading...", description: "", value: "" }]
      : palette.items.length
        ? palette.items.map((item) => ({ name: item.name, description: "", value: item.value }))
        : [{ name: palette.error ? "Unavailable" : "Nothing here", description: "", value: "" }];
  }
  ui.paletteList.options = options;
  if (isList) ui.paletteList.setSelectedIndex(Math.min(palette.selected ?? 0, Math.max(0, options.length - 1)));

  let desiredHeight;
  if (mode === "commands" || mode === "info") {
    desiredHeight = Math.min(ui.renderer.height - 2, Math.max(9, options.length + 5));
  } else if (isDetail) {
    desiredHeight = Math.min(ui.renderer.height - 2, Math.max(12, Math.floor(ui.renderer.height * 0.8)));
  } else if (isConfirm) {
    desiredHeight = Math.min(9, Math.max(6, ui.renderer.height - 4));
  } else {
    desiredHeight = Math.min(16, Math.max(9, Math.floor(ui.renderer.height / 2) + 1));
  }
  if (paletteBox.height !== desiredHeight) paletteBox.height = desiredHeight;

  ui.paletteDetailMarkdown.syntaxStyle = markdownStyle(ui);
  ui.paletteDetailMarkdown.fg = theme.text;
  if (isDetail) {
    const signature = `${theme.mode}:${palette.detail?.title}:${palette.detail?.markdown}`;
    if (signature !== ui.detailSignature) {
      ui.detailSignature = signature;
      ui.paletteDetailMarkdown.content = palette.detail?.markdown ?? "";
      ui.paletteDetailScroll.scrollTop = 0;
    }
  }
  if (isConfirm) {
    ui.paletteConfirm.content = `  ${palette.confirm?.text ?? ""}`;
    ui.paletteConfirm.fg = theme.warning;
  }

  const footer = palette.error
    || (mode === "prompt"
      ? palette.hint || "Enter confirm · Esc cancel"
      : mode === "search"
        ? `↑↓ select · Enter open · Tab: ${palette.scope === "all" ? "this room" : "all rooms"} · Esc close${palette.searching ? " · searching..." : ""}`
        : mode === "detail"
          ? palette.hint || "↑↓ scroll · Esc back"
          : mode === "confirm"
            ? palette.hint || "Enter or y confirms · n or Esc cancels"
            : palette.hint || (mode === "info" ? "↑↓ select · Enter open · Esc close" : "↑↓ select · Enter run · Esc close"));
  ui.paletteHint.content = `  ${sanitizeText(footer)}${palette.searching && mode !== "search" ? "  · working..." : ""}`;
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
    ["/", "inline commands"],
    ["@", "mention members"],
    ["Alt+Space", "palette / search"],
    ["Ctrl+R", "refresh rooms"],
    ["Ctrl+C", "quit"],
  ], ui.theme));
}