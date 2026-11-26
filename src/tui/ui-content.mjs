// State-to-renderable syncing for the OpenTUI view. These functions rebuild
// message and room rows only when their signature changes.
import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import { formatMessage, messageStamp, sanitizeText } from "./messages.mjs";
import { addNotice, buildMessageBlock, hashText, markdownStyle } from "./message-view.mjs";
import { syncMentionHighlights } from "./ui-mentions.mjs";
import { connectionStyle } from "./ui-theme.mjs";
import { t } from "./i18n.mjs";

const clear = (container) => {
  for (const child of container.getChildren()) {
    container.remove(child.id);
    child.destroyRecursively?.();
  }
};

export function syncLayout(ui) {
  const { renderer, theme } = ui;
  const narrow = renderer.width < 70;
  const showRooms = !narrow;
  const railWidth = renderer.width >= 120 ? 32 : renderer.width >= 100 ? 28 : 24;
  ui.roomsPane.visible = showRooms;
  ui.roomsPane.width = showRooms ? railWidth : 0;
  ui.roomsFooter.visible = showRooms;
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
  // Dialogs keep the OpenCode v2 habit: inset, readable measure and a top-third seat.
  const paletteMargin = narrow ? 0 : Math.max(1, Math.floor((renderer.width - 76) / 2));
  ui.paletteBox.left = paletteMargin;
  ui.paletteBox.right = paletteMargin;
  ui.paletteBox.bottom = narrow ? 1 : Math.max(1, Math.floor(renderer.height / 4));
  ui.paletteBox.height = Math.min(16, Math.max(9, Math.floor(renderer.height / 2) + 1));
  ui.helpBox.left = narrow ? 0 : 1;
  ui.helpBox.right = narrow ? 0 : 1;
  ui.helpBox.bottom = narrow ? 0 : 1;
  ui.helpBox.height = Math.min(16, Math.max(8, renderer.height - 4));
  ui.helpBody.gap = narrow ? 1 : 4;
  ui.helpBody.paddingX = narrow ? 1 : 2;
  ui.helpBody.paddingY = renderer.height < 22 ? 0 : 1;
  ui.roomsTitle.fg = theme.muted;
  ui.roomsTitle.content = t("rooms.title");
  ui.roomsCount.fg = theme.muted;
  ui.roomsFooter.fg = theme.faint;
  ui.roomsFooter.content = ` ${t("rooms.refreshHint")}`;
  ui.chatMeta.fg = theme.muted;
}

export function syncHeader(ui, state) {
  const { theme } = ui;
  const narrow = ui.renderer.width < 70;
  const left = [bold(fg(theme.accent)("opencode-chat-room"))];
  if (!narrow) {
    left.push(fg(theme.muted)("  ·  "));
    left.push(fg(theme.muted)(sanitizeText(state.host || t("common.server"))));
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
  const signature = `${ui.theme.mode}|${state.language}|${state.connection}|${pendingID ?? ""}|${state.rooms
    .map((room) => `${room.id}:${room.name}:${room.joined}:${room.participants.length}`)
    .join("|")}`;
  ui.roomsCount.content = state.rooms.length ? String(state.rooms.length) : "";
  if (signature !== ui.roomSignature) {
    ui.roomSignature = signature;
    clear(ui.roomContent);
    ui.roomRows.clear();
    if (!state.rooms.length) {
      const emptyLabel = state.connection === "connecting"
        ? t("connection.connecting")
        : state.connection === "offline"
          ? t("connection.offline")
          : t("rooms.empty");
      ui.roomContent.add(new TextRenderable(ui.renderer, {
        id: "room-empty",
        height: 1,
        wrapMode: "none",
        fg: ui.theme.muted,
        paddingX: 1,
        content: emptyLabel,
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
  const signature = `${ui.theme.mode}:${state.language}:${current?.id ?? ""}:${joined}:${pending?.roomId ?? ""}:${pending?.message ?? ""}:${highlight ?? ""}:${messageKey}`;

  if (current) {
    ui.chatTitle.content = new StyledText([bold(fg(ui.theme.accent)(`# ${sanitizeText(current.name)}`))]);
    const count = current.participants.length;
    ui.chatMeta.content = t(count === 1 ? "common.member" : "common.members", { count });
    ui.chatMeta.fg = ui.theme.muted;
  } else {
    ui.chatTitle.content = new StyledText([fg(ui.theme.muted)(t("chat.noRoom"))]);
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
    addNotice(ui, "pending-wait", t("chat.waitingApproval"), ui.theme.muted);
  } else if (!current) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", t("chat.selectRoom"), ui.theme.muted);
  } else if (!joined) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", t("chat.notJoined"), ui.theme.muted);
  } else if (!messages.length) {
    clear(ui.messageContent);
    ui.messageBlocks = [];
    addNotice(ui, "empty", t("chat.noMessages"), ui.theme.muted);
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
  ui.textarea.placeholder = t("chat.composerPlaceholder");
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
  const connection = connectionStyle(theme, state.connection);
  const text = state.status
    || (state.connection === "online" ? t("status.ready") : `${connection.dot} ${connection.label}`);
  ui.statusLine.content = sanitizeText(text);
  ui.statusLine.fg = state.statusKind === "error"
    ? theme.error
    : state.statusKind === "success"
      ? theme.success
      : theme.muted;
  const hints = state.focus === "composer"
    ? t("status.composerHints")
    : t("status.roomHints");
  ui.statusHints.content = ui.renderer.width < 70 ? t("status.hintsShort") : hints;
  ui.statusHints.fg = theme.faint;
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

  const scope = palette.scope === "all" ? t("palette.scopeAll") : t("palette.scopeRoom");
  const defaultTitle = mode === "prompt"
    ? t("palette.newRoom")
    : mode === "search"
      ? t("palette.searchMessages")
      : t("palette.title");
  ui.paletteTitle.content = new StyledText([bold(fg(theme.text)(palette.title || defaultTitle))]);
  ui.paletteScope.content = palette.subtitle
    || (mode === "prompt" ? t("palette.create") : mode === "search" ? scope : t("palette.commands"));
  ui.paletteInput.placeholder = mode === "prompt"
    ? palette.prompt?.label || t("palette.valuePlaceholder")
    : mode === "search"
      ? t("palette.searchPlaceholder")
      : t("palette.commandPlaceholder");

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
    options = !String(palette.query ?? "").trim()
      ? [{ name: t("palette.searchPlaceholder"), description: "", value: "" }]
      : !palette.results.length
      ? [{ name: palette.searching ? t("palette.searching") : t("palette.noMatches"), description: "", value: "" }]
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
      ? [{ name: t("common.loading"), description: "", value: "" }]
      : palette.items.length
        ? palette.items.map((item) => ({ name: item.name, description: "", value: item.value }))
        : [{ name: palette.error ? t("palette.unavailable") : t("palette.nothing"), description: "", value: "" }];
  }
  ui.paletteList.options = options;
  if (isList) ui.paletteList.setSelectedIndex(Math.min(palette.selected ?? 0, Math.max(0, options.length - 1)));

  let desiredHeight;
  if (mode === "commands" || mode === "info") {
    desiredHeight = Math.min(16, ui.renderer.height - 2, Math.max(9, options.length + 4));
  } else if (isDetail) {
    desiredHeight = Math.min(ui.renderer.height - 2, Math.max(12, Math.floor(ui.renderer.height * 0.8)));
  } else if (isConfirm) {
    desiredHeight = Math.min(9, Math.max(6, ui.renderer.height - 4));
  } else {
    desiredHeight = Math.min(16, Math.max(9, Math.floor(ui.renderer.height / 2) + 1));
  }
  desiredHeight = Math.max(4, Math.min(desiredHeight, ui.renderer.height - Math.max(1, Math.floor(ui.renderer.height / 4)) - 1));
  paletteBox.bottom = Math.max(1, ui.renderer.height - Math.max(1, Math.floor(ui.renderer.height / 4)) - desiredHeight);
  if (paletteBox.height !== desiredHeight) paletteBox.height = desiredHeight;

  ui.paletteDetailMarkdown.syntaxStyle = markdownStyle(ui);
  ui.paletteDetailMarkdown.fg = theme.text;
  if (isDetail) {
    const signature = `${theme.mode}:${state.language}:${palette.detail?.title}:${palette.detail?.markdown}`;
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
      ? palette.hint || t("palette.promptHint")
      : mode === "search"
        ? t("palette.searchHint", {
          scope: palette.scope === "all" ? t("palette.scopeRoom") : t("palette.scopeAll"),
          searching: palette.searching ? t("palette.searchingSuffix") : "",
        })
        : mode === "detail"
          ? palette.hint || t("palette.detailHint")
          : mode === "confirm"
            ? palette.hint || t("palette.confirmHint")
            : palette.hint || (mode === "info" ? t("palette.listHint") : t("palette.runHint")));
  ui.paletteHint.content = `  ${sanitizeText(footer)}${palette.searching && mode !== "search" ? `  · ${t("palette.working")}` : ""}`;
  ui.paletteHint.fg = palette.error ? theme.error : theme.muted;
}
