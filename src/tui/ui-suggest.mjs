// Inline slash-command and @mention suggestions. The popup is rendered above
// the composer but never receives focus; Enter either runs a command or inserts
// a mention, and Esc only dismisses the popup.
import { buildCommands, filterCommands } from "./palette.mjs";
import { insertMention, mentionItems, mentionTrigger } from "./mentions.mjs";
import { SUGGEST_LIMIT } from "./ui-suggest-view.mjs";
import { syncMentionHighlights } from "./ui-mentions.mjs";
import { t } from "./i18n.mjs";

function hide(ui) {
  ui.suggestBox.visible = false;
  ui.suggestKind = null;
  ui.suggestItems = [];
  ui.suggestTrigger = null;
}

function reset(ui) {
  hide(ui);
  ui.suggestSnapshot = null;
  ui.suggestSelected = 0;
  ui.suggestQuery = "";
  ui.suggestDismissed = null;
}

function activeSuggestion(ui, state, draft) {
  if (state.focus !== "composer" || state.palette || state.help) return null;
  if (draft.startsWith("/")) {
    if (draft.includes("\n")) return null;
    if (ui.suggestDismissed?.kind === "slash" && ui.suggestDismissed.draft === draft) return null;
    return { kind: "slash", query: draft.replace(/^\s*\//, "") };
  }
  if (ui.suggestDismissed?.kind === "mention" && ui.suggestDismissed.draft === draft) return null;
  const trigger = mentionTrigger(draft);
  if (!trigger) return null;
  return { kind: "mention", query: trigger.query, trigger };
}

function setComposer(ui, text) {
  ui.syncingComposer = true;
  try {
    ui.textarea.setText(text);
    ui.textarea.cursorOffset = text.length;
  } finally {
    ui.syncingComposer = false;
  }
  ui.app.setDraft(text);
  ui.mentionSignature = "";
  syncMentionHighlights(ui, ui.app.state);
}

function renderSuggest(ui, state, kind, items) {
  const theme = ui.theme;
  const selected = ui.suggestSelected;
  const start = items.length > SUGGEST_LIMIT
    ? Math.max(0, Math.min(selected - Math.floor(SUGGEST_LIMIT / 2), items.length - SUGGEST_LIMIT))
    : 0;
  const count = Math.min(SUGGEST_LIMIT, Math.max(1, items.length));

  ui.suggestBox.visible = true;
  ui.suggestBox.left = ui.renderer.width < 70 ? 0 : 1;
  ui.suggestBox.right = ui.renderer.width < 70 ? 0 : 1;
  ui.suggestBox.bottom = ui.statusBox.height + ui.composer.height;
  ui.suggestBox.height = count + 3;
  ui.suggestBox.borderColor = theme.border;
  ui.suggestBox.backgroundColor = theme.surface;
  ui.suggestBox.title = ` ${kind === "slash" ? t("suggest.commands") : t("suggest.mentions")} `;
  ui.suggestHint.fg = theme.muted;

  ui.suggestRows.forEach(({ row, label }, index) => {
    const item = items[start + index];
    if (!item) {
      row.visible = index === 0 && !items.length;
      if (index === 0 && !items.length) {
        row.backgroundColor = "transparent";
        label.content = t("suggest.noCommands");
        label.fg = theme.muted;
      }
      return;
    }
    const active = start + index === selected;
    row.visible = true;
    row.backgroundColor = active ? theme.selectedBg : "transparent";
    label.content = item.label ?? item.name ?? "";
    label.fg = active ? theme.selectedFg : theme.text;
  });

  const counter = items.length ? ` · ${Math.min(selected + 1, items.length)}/${items.length}` : "";
  ui.suggestHint.content = kind === "slash"
    ? items.length
      ? ` ${t("suggest.runHint", { count: counter })}`
      : ` ${t("suggest.emptyHint")}`
    : ` ${t("suggest.mentionHint", { count: counter })}`;
  ui.renderer.requestRender();
}

export function syncSuggest(ui, state) {
  const draft = String(state.draft ?? "");
  const active = activeSuggestion(ui, state, draft);
  if (!active) {
    if (draft.startsWith("/") || mentionTrigger(draft)) {
      hide(ui);
    } else {
      reset(ui);
    }
    return;
  }

  if (active.kind === "slash") {
    if (ui.suggestKind !== "slash") {
      ui.suggestSnapshot = buildCommands({
        rooms: state.rooms,
        current: state.current,
        joined: state.joined,
        help: state.help,
      });
      ui.suggestSelected = 0;
    }
    ui.suggestKind = "slash";
    ui.suggestTrigger = null;
    if (ui.suggestQuery !== active.query) {
      ui.suggestQuery = active.query;
      ui.suggestSelected = 0;
    }
    const items = filterCommands(ui.suggestSnapshot ?? [], active.query);
    ui.suggestItems = items;
    if (ui.suggestSelected >= items.length) ui.suggestSelected = Math.max(0, items.length - 1);
    renderSuggest(ui, state, "slash", items);
    return;
  }

  const items = mentionItems(state.current?.participants, active.query);
  if (!items.length) {
    hide(ui);
    return;
  }
  if (ui.suggestKind !== "mention" || ui.suggestQuery !== active.query) {
    ui.suggestSelected = 0;
  }
  ui.suggestKind = "mention";
  ui.suggestQuery = active.query;
  ui.suggestTrigger = active.trigger;
  ui.suggestItems = items;
  if (ui.suggestSelected >= items.length) ui.suggestSelected = items.length - 1;
  renderSuggest(ui, state, "mention", items);
}

function clearComposer(ui) {
  setComposer(ui, "");
  reset(ui);
}

function runSelected(ui) {
  if (ui.suggestKind === "mention") {
    const item = ui.suggestItems[ui.suggestSelected];
    if (!item) return false;
    const next = insertMention(ui.app.state.draft, ui.suggestTrigger, item.insert);
    setComposer(ui, next);
    reset(ui);
    ui.suggestDismissed = { kind: "mention", draft: next };
    syncSuggest(ui, ui.app.state);
    ui.renderer.requestRender();
    return true;
  }
  const command = ui.suggestItems[ui.suggestSelected];
  if (!command) return false;
  clearComposer(ui);
  ui.app.openPalette();
  void ui.app.runPaletteCommand(command);
  return true;
}

export function handleSuggestKey(ui, key, state) {
  if (!ui.suggestBox.visible) return false;
  if (key.name === "escape") {
    key.preventDefault();
    ui.suggestDismissed = { kind: ui.suggestKind, draft: String(state.draft ?? "") };
    hide(ui);
    ui.renderer.requestRender();
    return true;
  }
  if (key.name === "up" || key.name === "down") {
    key.preventDefault();
    if (ui.suggestItems.length) {
      ui.suggestSelected = Math.max(0, Math.min(
        ui.suggestItems.length - 1,
        ui.suggestSelected + (key.name === "up" ? -1 : 1),
      ));
      syncSuggest(ui, state);
    }
    return true;
  }
  if (key.name === "return") {
    if (!runSelected(ui)) return false;
    key.preventDefault();
    return true;
  }
  return false;
}