// Keyboard help overlay: themed shortcut columns, compact on short terminals.
import { StyledText, bold, fg } from "@opentui/core";
import { t } from "./i18n.mjs";

function shortcutChunks(title, rows, theme) {
  const chunks = [bold(fg(theme.accent)(`${title}\n`))];
  for (const [key, label] of rows) {
    chunks.push(fg(theme.accent)(key.padEnd(12)));
    chunks.push(fg(theme.text)(`${label}\n`));
  }
  return chunks;
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
  const signature = `${ui.theme.mode}:${state.language}`;
  if (signature === ui.helpSignature) return;
  ui.helpSignature = signature;
  const compact = ui.renderer.height < 22;
  const navigation = compact
    ? [
      ["↑ / ↓", t("help.selectRoom")],
      ["Enter", t("help.openJoin")],
      ["Tab", t("help.focusComposer")],
      ["PgUp / PgDn", t("help.scrollMessages")],
    ]
    : [
      ["↑ / ↓", t("help.selectRoom")],
      ["Enter", t("help.openJoin")],
      ["Tab", t("help.focusComposer")],
      ["PgUp / PgDn", t("help.scrollMessages")],
      ["Alt+Home", t("help.firstMessage")],
      ["Alt+End", t("help.lastMessage")],
    ];
  const composer = compact
    ? [
      ["Enter", t("help.sendMessage")],
      ["Esc", t("help.clearBlur")],
      ["/", t("help.inlineCommands")],
      ["@", t("help.mentionMembers")],
      ["Ctrl+C", t("help.quit")],
    ]
    : [
      ["Enter", t("help.sendMessage")],
      ["Ctrl+J", t("help.newline")],
      ["Esc", t("help.clearBlur")],
      ["/", t("help.inlineCommands")],
      ["@", t("help.mentionMembers")],
      ["Alt+Space", t("help.paletteSearch")],
      ["Ctrl+R", t("help.refreshRooms")],
      ["/exit", t("help.quit")],
      ["Ctrl+C", t("help.quit")],
    ];
  ui.helpLeft.content = new StyledText(shortcutChunks(t("help.navigation"), navigation, ui.theme));
  ui.helpRight.content = new StyledText(shortcutChunks(t("help.composer"), composer, ui.theme));
}