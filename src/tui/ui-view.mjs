// OpenTUI renderable tree for the chat room. Colors come from the semantic
// theme in ui-theme.mjs; behavior and syncing live in ui.mjs/ui-content.mjs.
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { createOverlays } from "./ui-overlay-view.mjs";

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

  createOverlays(renderer, theme, view);

  return view;
}