// Compact command/mention suggestions floating just above the composer.
// Rows are plain renderables so the popup never owns keyboard focus.
import { BoxRenderable, TextRenderable } from "@opentui/core";

export const SUGGEST_LIMIT = 6;

export function createSuggestView(renderer, theme, view) {
  view.suggestBox = new BoxRenderable(renderer, {
    id: "suggest",
    position: "absolute",
    left: 1,
    right: 1,
    bottom: 7,
    height: 5,
    zIndex: 80,
    visible: false,
    focusable: false,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.surface,
    title: " commands ",
    titleAlignment: "left",
    flexDirection: "column",
  });
  renderer.root.add(view.suggestBox);

  view.suggestRows = [];
  for (let index = 0; index < SUGGEST_LIMIT; index += 1) {
    const row = new BoxRenderable(renderer, {
      id: `suggest-row-${index}`,
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingX: 1,
      visible: false,
    });
    const label = new TextRenderable(renderer, {
      id: `suggest-label-${index}`,
      flexGrow: 1,
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: theme.text,
      content: "",
    });
    row.add(label);
    view.suggestBox.add(row);
    view.suggestRows.push({ row, label });
  }

  view.suggestHint = new TextRenderable(renderer, {
    id: "suggest-hint",
    height: 1,
    flexShrink: 0,
    truncate: true,
    wrapMode: "none",
    paddingX: 1,
    fg: theme.muted,
    content: "",
  });
  view.suggestBox.add(view.suggestHint);
}