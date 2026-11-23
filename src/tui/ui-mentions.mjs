// Accent-colored mention chips inside the composer. Extmarks keep ranges tied
// to the text; we rebuild them only when the visible ranges or theme change.
import { SyntaxStyle } from "@opentui/core";
import { mentionNames, mentionRanges } from "./mentions.mjs";

function styleFor(ui) {
  let style = ui.mentionStyles.get(ui.theme.mode);
  if (!style) {
    style = SyntaxStyle.fromStyles({
      mention: { fg: ui.theme.accent, bold: true },
    });
    ui.mentionStyles.set(ui.theme.mode, style);
  }
  return style;
}

export function syncMentionHighlights(ui, state) {
  const textarea = ui.textarea;
  const text = textarea.plainText;
  const ranges = mentionRanges(text, state.current?.participants);
  const names = mentionNames(state.current?.participants).join(",");
  const signature = `${ui.theme.mode}:${names}:${ranges.map((range) => `${range.start}-${range.end}`).join(",")}`;
  if (signature === ui.mentionSignature) return;
  if (!ranges.length) {
    textarea.extmarks.clear();
    ui.mentionSignature = signature;
    return;
  }

  const style = styleFor(ui);
  const styleId = style.getStyleId("mention") ?? style.registerStyle("mention", {
    fg: ui.theme.accent,
    bold: true,
  });
  textarea.syntaxStyle = style;
  const extmarks = textarea.extmarks;
  const typeId = ui.mentionTypeId ??= extmarks.registerType("mention");
  extmarks.clear();
  for (const range of ranges) {
    extmarks.create({ start: range.start, end: range.end, styleId, typeId });
  }
  ui.mentionSignature = signature;
  ui.renderer.requestRender();
}