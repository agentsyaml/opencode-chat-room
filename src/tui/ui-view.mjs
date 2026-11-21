// OpenTUI renderable tree for the chat room. Colors come from the semantic
// theme in ui-theme.mjs; behavior and syncing live in ui.mjs/ui-content.mjs.
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";

export function createView(renderer, theme) {
  const view = {};

  view.root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  renderer.root.add(view.root);

  view.headerBox = new BoxRenderable(renderer, {
    id: "header-box",
    height: 2,
    flexShrink: 0,
    border: ["bottom"],
    borderColor: theme.border,
    paddingX: 2,
  });
  view.root.add(view.headerBox);

  view.headerRow = new BoxRenderable(renderer, {
    id: "header-row",
    height: 1,
    flexDirection: "row",
    gap: 1,
  });
  view.headerBox.add(view.headerRow);

  view.headerLeft = new TextRenderable(renderer, {
    id: "header-left",
    flexGrow: 1,
    height: 1,
    truncate: true,
    wrapMode: "none",
    content: "opencode-chat-room",
  });
  view.headerRow.add(view.headerLeft);

  view.headerRight = new TextRenderable(renderer, {
    id: "header-right",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    content: "",
  });
  view.headerRow.add(view.headerRight);

  view.body = new BoxRenderable(renderer, {
    id: "body",
    flexGrow: 1,
    flexDirection: "row",
    minHeight: 0,
  });
  view.root.add(view.body);

  view.roomsPane = new BoxRenderable(renderer, {
    id: "rooms-pane",
    width: 28,
    flexDirection: "column",
    border: ["right"],
    borderColor: theme.border,
    minHeight: 0,
  });
  view.body.add(view.roomsPane);

  view.roomsHeader = new BoxRenderable(renderer, {
    id: "rooms-header",
    height: 1,
    flexDirection: "row",
    paddingX: 1,
  });
  view.roomsPane.add(view.roomsHeader);

  view.roomsTitle = new TextRenderable(renderer, {
    id: "rooms-title",
    flexGrow: 1,
    height: 1,
    wrapMode: "none",
    fg: theme.muted,
    content: "ROOMS",
  });
  view.roomsHeader.add(view.roomsTitle);

  view.roomsCount = new TextRenderable(renderer, {
    id: "rooms-count",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    fg: theme.faint,
    content: "",
  });
  view.roomsHeader.add(view.roomsCount);

  view.roomScroll = new ScrollBoxRenderable(renderer, {
    id: "room-scroll",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    scrollX: false,
  });
  view.roomsPane.add(view.roomScroll);
  view.roomScroll.verticalScrollBar.visible = false;

  view.roomContent = new BoxRenderable(renderer, {
    id: "room-content",
    width: "100%",
    flexDirection: "column",
  });
  view.roomScroll.add(view.roomContent);

  view.chatPane = new BoxRenderable(renderer, {
    id: "chat-pane",
    flexGrow: 1,
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    paddingX: 2,
  });
  view.body.add(view.chatPane);

  view.chatHeader = new BoxRenderable(renderer, {
    id: "chat-header",
    height: 1,
    flexDirection: "row",
    gap: 1,
  });
  view.chatPane.add(view.chatHeader);

  view.chatTitle = new TextRenderable(renderer, {
    id: "chat-title",
    flexGrow: 1,
    height: 1,
    truncate: true,
    wrapMode: "none",
    content: "# no room selected",
  });
  view.chatHeader.add(view.chatTitle);

  view.chatMeta = new TextRenderable(renderer, {
    id: "chat-meta",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    fg: theme.muted,
    content: "",
  });
  view.chatHeader.add(view.chatMeta);

  view.scrollBox = new ScrollBoxRenderable(renderer, {
    id: "messages",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    scrollX: false,
  });
  view.chatPane.add(view.scrollBox);
  view.scrollBox.verticalScrollBar.visible = false;

  view.messageContent = new BoxRenderable(renderer, {
    id: "message-content",
    width: "100%",
    flexDirection: "column",
  });
  view.scrollBox.add(view.messageContent);

  view.composer = new BoxRenderable(renderer, {
    id: "composer-box",
    height: 5,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    title: " message ",
    titleAlignment: "left",
    paddingX: 2,
    marginX: 1,
  });
  view.root.add(view.composer);

  view.composerRow = new BoxRenderable(renderer, {
    id: "composer-row",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  });
  view.composer.add(view.composerRow);

  view.prompt = new TextRenderable(renderer, {
    id: "prompt",
    width: 2,
    height: 3,
    fg: theme.accent,
    content: "› ",
  });
  view.composerRow.add(view.prompt);

  view.textarea = new TextareaRenderable(renderer, {
    id: "composer",
    flexGrow: 1,
    height: 3,
    wrapMode: "char",
    placeholder: "Write a message...",
    placeholderColor: theme.faint,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: theme.text,
    focusedTextColor: theme.text,
  });
  view.composerRow.add(view.textarea);

  view.statusBox = new BoxRenderable(renderer, {
    id: "status-box",
    height: 2,
    flexShrink: 0,
    border: ["top"],
    borderColor: theme.border,
    paddingX: 2,
  });
  view.root.add(view.statusBox);

  view.statusRow = new BoxRenderable(renderer, {
    id: "status-row",
    height: 1,
    flexDirection: "row",
    gap: 1,
  });
  view.statusBox.add(view.statusRow);

  view.statusLine = new TextRenderable(renderer, {
    id: "status",
    flexGrow: 1,
    height: 1,
    truncate: true,
    wrapMode: "none",
    fg: theme.muted,
    content: "ready",
  });
  view.statusRow.add(view.statusLine);

  view.statusHints = new TextRenderable(renderer, {
    id: "status-hints",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    fg: theme.faint,
    content: "Tab focus · Alt+Space palette · ? help",
  });
  view.statusRow.add(view.statusHints);

  view.paletteBox = new BoxRenderable(renderer, {
    id: "palette",
    position: "absolute",
    left: 1,
    right: 1,
    bottom: 1,
    height: Math.min(14, Math.max(8, Math.floor(renderer.height / 2))),
    zIndex: 100,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.accent,
    backgroundColor: theme.surface,
    flexDirection: "column",
  });
  renderer.root.add(view.paletteBox);

  view.paletteBar = new BoxRenderable(renderer, {
    id: "palette-bar",
    height: 1,
    flexDirection: "row",
    backgroundColor: theme.raised,
    paddingX: 1,
  });
  view.paletteBox.add(view.paletteBar);

  view.paletteTitle = new TextRenderable(renderer, {
    id: "palette-title",
    flexGrow: 1,
    height: 1,
    wrapMode: "none",
    fg: theme.text,
    content: "Palette",
  });
  view.paletteBar.add(view.paletteTitle);

  view.paletteScope = new TextRenderable(renderer, {
    id: "palette-scope",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    fg: theme.muted,
    content: "",
  });
  view.paletteBar.add(view.paletteScope);

  view.paletteInputRow = new BoxRenderable(renderer, {
    id: "palette-input-row",
    height: 1,
    flexDirection: "row",
    gap: 1,
    paddingX: 1,
  });
  view.paletteBox.add(view.paletteInputRow);

  view.palettePrompt = new TextRenderable(renderer, {
    id: "palette-prompt",
    width: 2,
    height: 1,
    fg: theme.accent,
    content: "› ",
  });
  view.paletteInputRow.add(view.palettePrompt);

  view.paletteInput = new InputRenderable(renderer, {
    id: "palette-input",
    flexGrow: 1,
    height: 1,
    placeholder: "Search or run a command",
    placeholderColor: theme.faint,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: theme.text,
    focusedTextColor: theme.text,
  });
  view.paletteInputRow.add(view.paletteInput);

  view.paletteList = new SelectRenderable(renderer, {
    id: "palette-list",
    flexGrow: 1,
    minHeight: 0,
    options: [],
    showDescription: false,
    showScrollIndicator: false,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: theme.text,
    focusedTextColor: theme.text,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedFg,
  });
  view.paletteBox.add(view.paletteList);

  view.paletteHint = new TextRenderable(renderer, {
    id: "palette-hint",
    height: 1,
    truncate: true,
    wrapMode: "none",
    fg: theme.muted,
    paddingX: 1,
    content: "",
  });
  view.paletteBox.add(view.paletteHint);

  view.helpBox = new BoxRenderable(renderer, {
    id: "help",
    position: "absolute",
    left: 1,
    right: 1,
    bottom: 1,
    height: 12,
    zIndex: 90,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.surface,
    flexDirection: "column",
  });
  renderer.root.add(view.helpBox);

  view.helpBar = new BoxRenderable(renderer, {
    id: "help-bar",
    height: 1,
    flexDirection: "row",
    backgroundColor: theme.raised,
    paddingX: 1,
  });
  view.helpBox.add(view.helpBar);

  view.helpTitle = new TextRenderable(renderer, {
    id: "help-title",
    flexGrow: 1,
    height: 1,
    wrapMode: "none",
    fg: theme.text,
    content: "Keyboard shortcuts",
  });
  view.helpBar.add(view.helpTitle);

  view.helpClose = new TextRenderable(renderer, {
    id: "help-close",
    flexShrink: 0,
    height: 1,
    wrapMode: "none",
    fg: theme.muted,
    content: "? or Esc closes",
  });
  view.helpBar.add(view.helpClose);

  view.helpBody = new BoxRenderable(renderer, {
    id: "help-body",
    flexGrow: 1,
    flexDirection: "row",
    gap: 4,
    paddingX: 2,
    paddingY: 1,
  });
  view.helpBox.add(view.helpBody);

  view.helpLeft = new TextRenderable(renderer, {
    id: "help-left",
    flexGrow: 1,
    wrapMode: "none",
    fg: theme.text,
    content: "",
  });
  view.helpBody.add(view.helpLeft);

  view.helpRight = new TextRenderable(renderer, {
    id: "help-right",
    flexGrow: 1,
    wrapMode: "none",
    fg: theme.text,
    content: "",
  });
  view.helpBody.add(view.helpRight);

  view.helpFooter = new TextRenderable(renderer, {
    id: "help-footer",
    height: 1,
    truncate: true,
    wrapMode: "none",
    fg: theme.muted,
    paddingX: 2,
    content: "  ? or Esc closes · Alt+Space or Ctrl+P palette · Ctrl+C quit",
  });
  view.helpBox.add(view.helpFooter);

  return view;
}