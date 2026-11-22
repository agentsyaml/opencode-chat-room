// Floating palette, info/detail overlay and keyboard help. Split from the main
// layout so ui-view.mjs stays a readable screen skeleton.
import {
  BoxRenderable,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  getTreeSitterClient,
} from "@opentui/core";
import { createMarkdownSyntax } from "./markdown.mjs";

export function createOverlays(renderer, theme, view) {
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

  view.paletteDetailScroll = new ScrollBoxRenderable(renderer, {
    id: "palette-detail",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    scrollX: false,
    visible: false,
  });
  view.paletteBox.add(view.paletteDetailScroll);
  view.paletteDetailScroll.verticalScrollBar.visible = false;

  view.paletteDetailBody = new BoxRenderable(renderer, {
    id: "palette-detail-body",
    width: "100%",
    flexDirection: "column",
    paddingX: 2,
    paddingY: 1,
  });
  view.paletteDetailScroll.add(view.paletteDetailBody);

  view.paletteDetailMarkdown = new MarkdownRenderable(renderer, {
    id: "palette-detail-markdown",
    width: "100%",
    content: "",
    syntaxStyle: createMarkdownSyntax(theme),
    treeSitterClient: getTreeSitterClient(),
    fg: theme.text,
    conceal: true,
    concealCode: false,
    tableOptions: {
      style: "columns",
      widthMode: "full",
      wrapMode: "word",
      cellPaddingX: 1,
      cellPaddingY: 0,
      borderColor: theme.border,
    },
  });
  view.paletteDetailBody.add(view.paletteDetailMarkdown);

  view.paletteConfirm = new TextRenderable(renderer, {
    id: "palette-confirm",
    flexGrow: 1,
    wrapMode: "word",
    fg: theme.text,
    paddingX: 2,
    paddingY: 1,
    content: "",
    visible: false,
  });
  view.paletteBox.add(view.paletteConfirm);

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
}