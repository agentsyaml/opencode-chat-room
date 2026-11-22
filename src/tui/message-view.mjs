// Message row renderables: grouped metadata plus a Markdown body with mention
// highlighting. Split from ui-content.mjs to keep the state sync readable.
import {
  BoxRenderable,
  MarkdownRenderable,
  StyledText,
  TextRenderable,
  bold,
  dim,
  fg,
  getTreeSitterClient,
  italic,
} from "@opentui/core";
import {
  MENTION_SENTINEL,
  createMarkdownSyntax,
  createMentionRenderNode,
  formatAttachments,
  prepareMarkdown,
} from "./markdown.mjs";

let treeSitter;
const treeClient = () => (treeSitter ??= getTreeSitterClient());

export function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function markdownStyle(ui) {
  let style = ui.syntaxStyles.get(ui.theme.mode);
  if (!style) {
    style = createMarkdownSyntax(ui.theme);
    ui.syntaxStyles.set(ui.theme.mode, style);
  }
  return style;
}

function messageChunks(ui, message, info) {
  const { theme } = ui;
  const chunks = [];
  const highlighted = message.id === ui.app.state.highlight;
  if (highlighted) chunks.push(bold(fg(theme.accent)("▸ ")));
  if (info.question) chunks.push(bold(fg(theme.warning)("? ")));
  chunks.push(dim(`${info.time} `));
  const own = message.senderId === ui.app.state.participant;
  chunks.push(bold(fg(own ? theme.accent : theme.text)(info.sender)));
  return chunks;
}

function messageBody(ui, message, info, highlighted) {
  const body = new BoxRenderable(ui.renderer, {
    id: `message-body-${message.id}`,
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingLeft: 2,
    paddingRight: 1,
    backgroundColor: highlighted ? ui.theme.raised : undefined,
  });
  if (info.recalled) {
    body.add(new TextRenderable(ui.renderer, {
      id: `message-recalled-${message.id}`,
      width: "100%",
      wrapMode: "word",
      content: new StyledText([dim(italic("[recalled]"))]),
    }));
    return body;
  }
  const markdown = prepareMarkdown(formatAttachments(info.body));
  body.add(new MarkdownRenderable(ui.renderer, {
    id: `message-markdown-${message.id}`,
    width: "100%",
    content: markdown,
    syntaxStyle: markdownStyle(ui),
    treeSitterClient: treeClient(),
    fg: ui.theme.text,
    conceal: true,
    concealCode: false,
    streaming: false,
    tableOptions: {
      style: "columns",
      widthMode: "full",
      wrapMode: "word",
      cellPaddingX: 1,
      cellPaddingY: 0,
      borderColor: ui.theme.border,
    },
    ...(markdown.includes(MENTION_SENTINEL)
      ? { renderNode: createMentionRenderNode(ui.renderer, ui.theme, `message-${message.id}`) }
      : {}),
  }));
  return body;
}

export function buildMessageBlock(ui, message, info, highlighted, marginTop) {
  const block = new BoxRenderable(ui.renderer, {
    id: `message-${message.id}`,
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    marginTop,
  });
  block.add(new TextRenderable(ui.renderer, {
    id: `message-head-${message.id}`,
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    content: new StyledText(messageChunks(ui, message, info)),
  }));
  block.add(messageBody(ui, message, info, highlighted));
  return block;
}

export function addNotice(ui, id, text, color) {
  ui.messageContent.add(new TextRenderable(ui.renderer, {
    id: `message-${id}`,
    width: "100%",
    flexShrink: 0,
    wrapMode: "char",
    content: new StyledText([fg(color)(text)]),
  }));
}