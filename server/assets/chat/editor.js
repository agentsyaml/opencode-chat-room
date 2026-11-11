import { createRandomId } from "./state.js";

const trustedChipNames = new Map();
const autoSeparator = "\uE000\uE001";
function mentionName(node) {
  const name = trustedChipNames.get(node.dataset?.chatChip);
  return name !== undefined && node.dataset.mention === name && node.textContent === `@${name}` ? name : null;
}

export function editorText(editor, draft = false) {
  if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === "BR") return "";
  if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === "DIV" && editor.firstElementChild?.nodeName === "BR") return "";
  let value = "";
  const block = (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === "DIV";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) value += draft ? encodeDraftText(node.nodeValue) : node.nodeValue;
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const mention = mentionName(node);
      if (node.dataset?.chatAutoSeparator) value += draft && node.textContent.startsWith(" ")
        ? autoSeparator + encodeDraftText(node.textContent.slice(1)) : draft ? encodeDraftText(node.textContent) : node.textContent;
      else if (mention !== null) value += `<at>@${mention}</at>`;
      else if (node.tagName === "BR") value += "\n";
      else node.childNodes.forEach((child, index, all) => {
        if (index && (block(child) || block(all[index - 1]))) value += "\n";
        if (!(block(child) && child.childNodes.length === 1 && child.firstChild.nodeName === "BR")) walk(child);
      });
    }
  };
  editor.childNodes.forEach((node, index, all) => {
    if (index && (block(node) || block(all[index - 1]))) value += "\n";
    if (!(block(node) && node.childNodes.length === 1 && node.firstChild.nodeName === "BR")) walk(node);
  });
  return value;
}

export const editorDraftText = (editor) => editorText(editor, true);
export const autoMentionDraft = (name) => `<at>@${name}</at>${autoSeparator}`;
const literalMention = /<at>@([^<]+)<\/at>/g;
function encodeDraftText(text) { return String(text).replace(/\uE000/g, "\uE000\uE000").replace(literalMention, "\uE000$&"); }

export function setEditorText(editor, value, draft = false) {
  editor.replaceChildren();
  const pattern = draft ? /\uE000\uE001|\uE000\uE000|\uE000<at>@([^<]+)<\/at>|<at>@([^<]+)<\/at>/g : /<at>@([^<]+)<\/at>/g;
  let offset = 0, match;
  while ((match = pattern.exec(String(value))) !== null) {
    editor.append(document.createTextNode(String(value).slice(offset, match.index)));
    if (draft && match[0] === autoSeparator) { editor.append(createAutoSeparator()); offset = pattern.lastIndex; continue; }
    if (draft && match[0] === "\uE000\uE000") { editor.append(document.createTextNode("\uE000")); offset = pattern.lastIndex; continue; }
    if (draft && match[0].startsWith("\uE000")) { editor.append(document.createTextNode(match[0].slice(1))); offset = pattern.lastIndex; continue; }
    editor.append(createMention(draft ? match[2] : match[1])); offset = pattern.lastIndex;
  }
  editor.append(document.createTextNode(String(value).slice(offset)));
  pruneTrustedChipNames();
}

export function editorSelectionOffsets(editor) {
  const selection = getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return [editorText(editor).length, editorText(editor).length];
  const selected = selection.getRangeAt(0);
  const offset = (node, position) => lengthBefore(editor, node, position);
  return [offset(selected.startContainer, selected.startOffset), offset(selected.endContainer, selected.endOffset)];
}

function lengthBefore(root, target, position) {
  const block = (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === "DIV";
  const length = (node) => node.nodeType === Node.TEXT_NODE ? node.length
    : mentionName(node) !== null ? `<at>@${mentionName(node)}</at>`.length
      : node.tagName === "BR" ? 1 : childrenLength(node);
  const childrenLength = (parent, until = parent.childNodes.length) => {
    let sum = 0;
    for (let index = 0; index < until; index++) {
      const child = parent.childNodes[index];
      if (index && (block(child) || block(parent.childNodes[index - 1]))) sum++;
      if (!(block(child) && child.childNodes.length === 1 && child.firstChild.nodeName === "BR")) sum += length(child);
    }
    return sum;
  };
  const visit = (node) => {
    if (node === target) return node.nodeType === Node.TEXT_NODE ? Math.min(position, node.length)
      : childrenLength(node, position);
    let total = 0;
    for (let index = 0; index < node.childNodes.length; index++) {
      const child = node.childNodes[index];
      if (index && (block(child) || block(node.childNodes[index - 1]))) total++;
      if (child === target || child.contains(target)) return total + visit(child);
      if (!(block(child) && child.childNodes.length === 1 && child.firstChild.nodeName === "BR")) total += length(child);
    }
    return total;
  };
  return visit(root);
}

export function setCaret(editor, offset) {
  const selection = getSelection(), range = document.createRange();
  // Chromium starts IME composition poorly at an element boundary next to a
  // non-editable chip; keep the caret inside a real text node instead.
  const [container, index] = textPoint(editorPoint(editor, offset));
  range.setStart(container, index); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
}

function textPoint([container, offset]) {
  if (container.nodeType !== Node.ELEMENT_NODE) return [container, offset];
  const child = container.childNodes[offset], previous = container.childNodes[offset - 1];
  if (child?.nodeType === Node.TEXT_NODE) return [child, 0];
  if (previous?.nodeType === Node.TEXT_NODE) return [previous, previous.length];
  const text = document.createTextNode("");
  container.insertBefore(text, child || null);
  return [text, 0];
}

export function setEditorSelection(editor, start, end = start) {
  const range = document.createRange(), selection = getSelection();
  const first = editorPoint(editor, start), last = editorPoint(editor, end);
  range.setStart(first[0], first[1]); range.setEnd(last[0], last[1]);
  selection.removeAllRanges(); selection.addRange(range);
}

function editorPoint(editor, offset) {
  const last = editor.lastElementChild;
  if (offset === editorText(editor).length && editor.lastChild === last && last?.tagName === "DIV" && last.firstChild?.nodeName === "BR") {
    const text = last.appendChild(document.createTextNode("")); return [text, 0];
  }
  if (offset === editorText(editor).length && editor.lastChild?.nodeName === "BR") {
    const text = editor.appendChild(document.createTextNode("")); return [text, 0];
  }
  const block = (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === "DIV";
  let left = offset, point = null;
  const visit = (node) => {
    if (point) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (left <= node.length) point = [node, left]; else left -= node.length;
    } else if (node.nodeType === Node.ELEMENT_NODE && mentionName(node) !== null) {
      const index = [...node.parentNode.childNodes].indexOf(node), length = `<at>@${mentionName(node)}</at>`.length;
      if (left <= length) point = [node.parentNode, index + (left ? 1 : 0)]; else left -= length;
    } else if (node.tagName === "BR") {
      const index = [...node.parentNode.childNodes].indexOf(node);
      if (left <= 1) point = [node.parentNode, index + (left ? 1 : 0)]; else left--;
    } else node.childNodes.forEach((child, index, all) => {
      if (index && (block(child) || block(all[index - 1]))) {
        if (left === 0) { point = [node, index]; return; }
        left--;
      }
      if (!(block(child) && child.childNodes.length === 1 && child.firstChild.nodeName === "BR")) visit(child);
    });
  };
  visit(editor);
  if (point) return point;
  const node = editor.appendChild(document.createTextNode("")); return [node, 0];
}

export function replaceEditorRange(editor, start, end, value, parseMentions = true) {
  setEditorSelection(editor, start, end);
  if (!parseMentions && document.execCommand("insertText", false, String(value))) return;
  const marker = `chat-insert-${createRandomId()}`;
  const source = String(value), generatedSpace = parseMentions && source.endsWith(" "), content = generatedSpace ? source.slice(0, -1) : source;
  const token = parseMentions ? /<at>@([^<]+)<\/at>/g : null;
  let html = "", cursor = 0, match;
  while (token && (match = token.exec(content))) {
    html += textHTML(content.slice(cursor, match.index));
    const name = escapeHTML(match[1]);
    const chipID = createRandomId(); trustedChipNames.set(chipID, match[1]);
    html += `<span class="editor-mention" data-mention="${name}" data-chat-chip="${chipID}" data-insert-marker="${marker}" contenteditable="false" role="img" aria-label="Mention ${name}">@${name}</span>`;
    cursor = token.lastIndex;
  }
  html += textHTML(content.slice(cursor));
  if (generatedSpace) html += `<span data-chat-auto-separator="true"> </span>`;
  if (document.execCommand("insertHTML", false, html)) {
    editor.querySelectorAll(`[data-insert-marker="${marker}"]`).forEach((chip) => chip.removeAttribute("data-insert-marker"));
    setCaret(editor, start + source.length);
    pruneTrustedChipNames();
  } else {
    const current = editorText(editor), next = current.slice(0, start) + value + current.slice(end);
    if (parseMentions) setEditorText(editor, next); else editor.replaceChildren(document.createTextNode(next));
    if (generatedSpace) wrapAutoSeparator(editor, start + source.length - 1);
    setCaret(editor, start + value.length);
    pruneTrustedChipNames();
  }
}

function escapeHTML(text) { return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function textHTML(text) { return escapeHTML(text).replace(/\r\n|\r|\n/g, "<br>"); }

function createMention(name) {
  const chip = document.createElement("span");
  chip.className = "editor-mention"; chip.dataset.mention = name;
  chip.dataset.chatChip = createRandomId(); trustedChipNames.set(chip.dataset.chatChip, name);
  chip.contentEditable = "false"; chip.setAttribute("role", "img");
  chip.setAttribute("aria-label", `Mention ${name}`); chip.textContent = `@${name}`;
  return chip;
}
function createAutoSeparator() {
  const separator = document.createElement("span");
  separator.dataset.chatAutoSeparator = "true"; separator.textContent = " ";
  return separator;
}
function wrapAutoSeparator(editor, offset) {
  const start = editorPoint(editor, offset), end = editorPoint(editor, offset + 1), range = document.createRange();
  range.setStart(start[0], start[1]); range.setEnd(end[0], end[1]); range.deleteContents(); range.insertNode(createAutoSeparator());
}

function deleteMentionAtCaret(editor, event) {
  if (event.isComposing || event.keyCode === 229 || event.key !== "Backspace") return;
  const [caret, end] = editorSelectionOffsets(editor);
  if (caret !== end) return;
  const separator = [...editor.querySelectorAll("[data-chat-auto-separator]")].find((node) => {
    const start = lengthBefore(editor, node, 0); return node.textContent === " " && caret === start + 1;
  });
  const mention = separator?.previousElementSibling || [...editor.querySelectorAll(".editor-mention")].find((node) => {
    return caret === lengthBefore(editor, node, 0) + `<at>@${mentionName(node)}</at>`.length;
  });
  if (!mention || (separator && separator.previousElementSibling !== mention)) return;
  const start = lengthBefore(editor, mention, 0);
  event.preventDefault(); mention.remove(); separator?.remove(); setCaret(editor, start);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
}

function pruneTrustedChipNames() {
  const live = new Set([...document.querySelectorAll("[data-chat-chip]")].map((node) => node.dataset.chatChip));
  const stale = [...trustedChipNames.keys()].filter((id) => !live.has(id));
  // shortcut: retain 2,048 detached IDs for undo history; raise if longer histories are required.
  stale.slice(0, Math.max(0, stale.length - 2048)).forEach((id) => trustedChipNames.delete(id));
}

export function installEditor(editor) {
  Object.defineProperty(editor, "value", {
    get: () => editorText(editor), set: (value) => setEditorText(editor, value),
  });
  Object.defineProperty(editor, "draftValue", {
    get: () => editorDraftText(editor), set: (value) => setEditorText(editor, value, true),
  });
  Object.defineProperties(editor, {
    selectionStart: { get: () => editorSelectionOffsets(editor)[0] },
    selectionEnd: { get: () => editorSelectionOffsets(editor)[1] },
  });
  editor.getSelectionOffsets = () => editorSelectionOffsets(editor);
  editor.setCaret = (offset) => setCaret(editor, offset);
  editor.setSelectionRange = (start, end = start) => setEditorSelection(editor, start, end);
  editor.replaceTextRange = (start, end, value) => replaceEditorRange(editor, start, end, value);
  editor.addEventListener("input", pruneTrustedChipNames);
  editor.addEventListener("keydown", (event) => deleteMentionAtCaret(editor, event));
  editor.addEventListener("paste", (event) => {
    if (event.defaultPrevented || event.clipboardData?.files.length) return;
    event.preventDefault();
    const [start, end] = editorSelectionOffsets(editor);
    replaceEditorRange(editor, start, end, event.clipboardData?.getData("text/plain") || "", false);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  });
  editor.addEventListener("drop", (event) => {
    if (event.defaultPrevented || event.dataTransfer?.files.length) return;
    const html = event.dataTransfer?.getData("text/html") || "";
    const text = event.dataTransfer?.getData("text/plain") || new DOMParser().parseFromString(html, "text/html").body.textContent || "";
    if (!text) return;
    event.preventDefault();
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY), selection = getSelection();
    if (range && editor.contains(range.startContainer)) { selection.removeAllRanges(); selection.addRange(range); }
    const [start, end] = editorSelectionOffsets(editor);
    replaceEditorRange(editor, start, end, text, false);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDrop" }));
  });
}
