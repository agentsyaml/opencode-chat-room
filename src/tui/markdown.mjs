// Mention and Markdown helpers shared by the TUI message renderer and tests.
// Mentions become a private inline-code marker before parsing: default
// Markdown rendering shows just @name, and paragraphs are upgraded by a custom
// renderNode to accent styling. Fenced/inline code is never rewritten.
import {
  StyledText,
  SyntaxStyle,
  TextRenderable,
  bg,
  bold,
  dim,
  fg,
  italic,
  strikethrough,
  underline,
} from "@opentui/core";

export const MENTION_SENTINEL = "\u200B";
const MENTION_TAG = /^<at>(@[^\n<>`\\]{1,64})<\/at>/u;
const RESOURCE_MARKER = /\[\[resource:[^\]\s]+\]\]/gi;

/** Show attachment markers as a readable label and never leak the UUID. */
export function formatAttachments(text) {
  const source = String(text ?? "");
  const markers = source.match(RESOURCE_MARKER);
  if (!markers) return source;
  const clean = source
    .replace(RESOURCE_MARKER, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!clean) return "Attachments";
  return `${clean} · Attachments`;
}

function inlineMentions(line) {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let run = 0;
      while (line[index + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = line.indexOf(fence, index + run);
      if (close === -1) {
        out += line.slice(index);
        break;
      }
      out += line.slice(index, close + run);
      index = close + run;
      continue;
    }
    const match = line.slice(index).match(MENTION_TAG);
    if (match) {
      out += `\`${MENTION_SENTINEL}${match[1]}\``;
      index += match[0].length;
      continue;
    }
    out += line[index];
    index += 1;
  }
  return out;
}

/** Rewrite <at>@name</at> in prose, leaving fenced and inline code untouched. */
export function prepareMarkdown(text) {
  let fence = null;
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker[1];
        return line;
      }
      return inlineMentions(line);
    })
    .join("\n");
}

export function isMentionCode(token) {
  return token?.type === "codespan" && String(token.text ?? "").startsWith(MENTION_SENTINEL);
}

export function containsMention(token) {
  if (!token) return false;
  if (isMentionCode(token)) return true;
  if (Array.isArray(token.tokens) && token.tokens.some(containsMention)) return true;
  return typeof token.raw === "string" && token.raw.includes(MENTION_SENTINEL);
}

function chunk(text, color, style = {}) {
  let value = fg(color)(text);
  if (style.bold) value = bold(value);
  if (style.italic) value = italic(value);
  if (style.underline) value = underline(value);
  if (style.strikethrough) value = strikethrough(value);
  if (style.bg) value = bg(style.bg)(value);
  if (style.dim) value = dim(value);
  return value;
}

function inlineTokens(tokens, theme, style = {}) {
  const chunks = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape":
        if (Array.isArray(token.tokens) && token.tokens.length) {
          chunks.push(...inlineTokens(token.tokens, theme, style));
        } else {
          chunks.push(chunk(token.text ?? "", style.color ?? theme.text, style));
        }
        break;
      case "strong":
        chunks.push(...inlineTokens(token.tokens, theme, { ...style, bold: true }));
        break;
      case "em":
        chunks.push(...inlineTokens(token.tokens, theme, { ...style, italic: true }));
        break;
      case "del":
        chunks.push(...inlineTokens(token.tokens, theme, { ...style, strikethrough: true }));
        break;
      case "codespan":
        if (isMentionCode(token)) {
          chunks.push(chunk(String(token.text).slice(MENTION_SENTINEL.length), theme.accent, { bold: true }));
        } else {
          chunks.push(chunk(token.text ?? "", theme.text, { ...style, bg: theme.raised }));
        }
        break;
      case "link": {
        chunks.push(...inlineTokens(token.tokens, theme, {
          ...style,
          color: theme.accent,
          underline: true,
        }));
        if (token.href) chunks.push(chunk(` (${token.href})`, theme.muted, style));
        break;
      }
      case "image":
        chunks.push(chunk(token.text || "image", theme.muted, style));
        break;
      case "br":
        chunks.push(chunk("\n", theme.text, style));
        break;
      case "list":
        chunks.push(...flattenList(token, theme));
        break;
      case "table":
        chunks.push(...flattenTable(token, theme));
        break;
      case "blockquote":
        chunks.push(chunk("│ ", theme.accent), ...inlineTokens(token.tokens, theme, { ...style, color: theme.muted }));
        break;
      default:
        if (Array.isArray(token.tokens) && token.tokens.length) {
          chunks.push(...inlineTokens(token.tokens, theme, style));
        } else if (typeof token.text === "string" || typeof token.raw === "string") {
          chunks.push(chunk(token.text ?? token.raw, style.color ?? theme.text, style));
        }
    }
  }
  return chunks;
}

function flattenList(token, theme) {
  const chunks = [];
  const items = Array.isArray(token.items) ? token.items : [];
  for (const [index, item] of items.entries()) {
    const marker = token.ordered ? `${(token.start ?? 1) + index}. ` : "• ";
    if (item.task) chunks.push(chunk(item.checked ? "[x] " : "[ ] ", theme.muted));
    chunks.push(chunk(marker, theme.accent), ...inlineTokens(item.tokens, theme));
    chunks.push(chunk("\n", theme.text));
  }
  return chunks;
}

function flattenTable(token, theme) {
  const chunks = [];
  const rows = [token.header, ...(token.rows ?? [])];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    cells.forEach((cell, index) => {
      if (index) chunks.push(chunk(" │ ", theme.muted));
      const tokens = cell?.tokens?.length ? cell.tokens : [{ type: "text", text: cell?.text ?? "" }];
      chunks.push(...inlineTokens(tokens, theme));
    });
    chunks.push(chunk("\n", theme.text));
  }
  return chunks;
}

function rawMentionText(text) {
  return String(text ?? "")
    .replace(new RegExp("`" + MENTION_SENTINEL + "(@[^`]*)`", "g"), "$1")
    .split(MENTION_SENTINEL)
    .join("");
}

function mentionText(token, theme) {
  if (token.type === "heading") {
    return [
      chunk(`${"#".repeat(token.depth ?? 1)} `, theme.accent, { bold: true }),
      ...inlineTokens(token.tokens, theme, { bold: true }),
    ];
  }
  if (token.type === "list") return flattenList(token, theme);
  if (token.type === "table") return flattenTable(token, theme);
  if (token.type === "blockquote") {
    return [chunk("│ ", theme.accent), ...inlineTokens(token.tokens, theme, { color: theme.muted })];
  }
  if (Array.isArray(token.tokens) && token.tokens.length) return inlineTokens(token.tokens, theme);
  return [chunk(rawMentionText(token.raw ?? token.text), theme.text)];
}

export function inlineChunks(tokens, theme) {
  return inlineTokens(tokens, theme);
}

export function createMentionRenderNode(renderer, theme, baseID) {
  let counter = 0;
  return (token, context) => {
    if (!containsMention(token)) return context.defaultRender();
    const id = `${baseID}-mention-${counter}`;
    counter += 1;
    return new TextRenderable(renderer, {
      id,
      width: "100%",
      flexShrink: 0,
      wrapMode: "word",
      content: new StyledText(mentionText(token, theme)),
    });
  };
}

export function createMarkdownSyntax(theme) {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    conceal: { fg: theme.faint },
    "markup.heading": { fg: theme.accent, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.text, italic: true },
    "markup.strikethrough": { fg: theme.muted },
    "markup.raw": { fg: theme.accent, bg: theme.raised, bold: true },
    "markup.list": { fg: theme.accent },
    "markup.quote": { fg: theme.muted, italic: true },
    "markup.link": { fg: theme.muted },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted },
    keyword: { fg: theme.accent, bold: true },
    string: { fg: theme.success },
    comment: { fg: theme.muted, italic: true },
    number: { fg: theme.warning },
    constant: { fg: theme.warning },
    function: { fg: theme.text, bold: true },
    type: { fg: theme.warning },
    variable: { fg: theme.text },
    property: { fg: theme.text },
    operator: { fg: theme.muted },
    punctuation: { fg: theme.muted },
    tag: { fg: theme.accent },
    attribute: { fg: theme.warning },
  });
}