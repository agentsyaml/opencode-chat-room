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
      else if (node.tagName === "BR") { if (!node.dataset?.chatTail) value += "\n"; }
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
function appendText(editor, text) {
  String(text).split("\n").forEach((line, index) => {
    if (index) editor.append(document.createElement("br"));
    if (line) editor.append(document.createTextNode(line));
  });
}

export function setEditorText(editor, value, draft = false) {
  editor.replaceChildren();
  const pattern = draft ? /\uE000\uE001|\uE000\uE000|\uE000<at>@([^<]+)<\/at>|<at>@([^<]+)<\/at>/g : /<at>@([^<]+)<\/at>/g;
  let offset = 0, match;
  while ((match = pattern.exec(String(value))) !== null) {
    appendText(editor, String(value).slice(offset, match.index));
    if (draft && match[0] === autoSeparator) { editor.append(createAutoSeparator()); offset = pattern.lastIndex; continue; }
    if (draft && match[0] === "\uE000\uE000") { appendText(editor, "\uE000"); offset = pattern.lastIndex; continue; }
    if (draft && match[0].startsWith("\uE000")) { appendText(editor, match[0].slice(1)); offset = pattern.lastIndex; continue; }
    editor.append(createMention(draft ? match[2] : match[1])); offset = pattern.lastIndex;
  }
  appendText(editor, String(value).slice(offset));
  editor.dataset.empty = value ? "false" : "true";
  pruneTrustedChipNames();
}

export function editorSelectionOffsets(editor) {
  const selection = getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return [editorText(editor).length, editorText(editor).length];
  const selected = selection.getRangeAt(0), collapsed = selected.collapsed;
  const offset = (node, position, isStart) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const chip = element?.closest(".editor-mention");
    const raw = lengthBefore(editor, node, position);
    if (chip && editor.contains(chip) && mentionName(chip) !== null) {
      const start = lengthBefore(editor, chip, 0), end = start + `<at>@${mentionName(chip)}</at>`.length;
      // A caret strictly inside a non-editable chip (e.g. left there by an
      // ESC-cancelled IME composition) is not a text position; snap to the end.
      // A selection edge inside a chip expands to the whole chip so copy and
      // cut keep the mention token instead of falling back to plain text.
      if (raw > start && raw < end) return collapsed || !isStart ? end : start;
    }
    return raw;
  };
  return [offset(selected.startContainer, selected.startOffset, true), offset(selected.endContainer, selected.endOffset, false)];
}

function lengthBefore(root, target, position) {
  const block = (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === "DIV";
  const length = (node) => node.nodeType === Node.TEXT_NODE ? node.length
    : mentionName(node) !== null ? `<at>@${mentionName(node)}</at>`.length
      : node.tagName === "BR" ? (node.dataset?.chatTail ? 0 : 1) : childrenLength(node);
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
  if (child?.nodeType === Node.TEXT_NODE && child.length === 0) {
    const next = child.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE) { child.remove(); return [next, 0]; }
  }
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
  const atEnd = offset === editorText(editor).length;
  if (atEnd && editor.lastChild?.nodeType === Node.TEXT_NODE && editor.lastChild.nodeValue === "") editor.lastChild.remove();
  const last = editor.lastElementChild;
  if (atEnd && editor.lastChild === last && last?.tagName === "DIV" && last.firstChild?.nodeName === "BR") {
    const text = last.appendChild(document.createTextNode("")); return [text, 0];
  }
  if (atEnd && editor.lastChild?.nodeName === "BR") {
    if (!editor.lastChild.dataset?.chatTail) {
      const tail = document.createElement("br");
      tail.dataset.chatTail = "true";
      editor.append(tail);
    }
    return [editor, editor.childNodes.length - 1];
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
  const emptyBefore = !editorText(editor);
  setEditorSelection(editor, start, end);
  if (!parseMentions && document.execCommand("insertText", false, String(value))) {
    if (emptyBefore && !String(value).endsWith("\n")) trimTrailingBreak(editor);
    editor.dataset.empty = editorText(editor) ? "false" : "true";
    return;
  }
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
    if (emptyBefore && !String(value).endsWith("\n")) trimTrailingBreak(editor);
    setCaret(editor, start + source.length);
    pruneTrustedChipNames();
  } else {
    const current = editorText(editor), next = current.slice(0, start) + value + current.slice(end);
    if (parseMentions) setEditorText(editor, next); else editor.replaceChildren(document.createTextNode(next));
    if (generatedSpace) wrapAutoSeparator(editor, start + source.length - 1);
    setCaret(editor, start + value.length);
    pruneTrustedChipNames();
  }
  editor.dataset.empty = editorText(editor) ? "false" : "true";
}

function trimTrailingBreak(editor) {
  let last = editor.lastChild;
  if (last?.nodeName === "BR" && last.dataset?.chatTail) last = last.previousSibling;
  if (last?.nodeName === "BR") last.remove();
}

function sanitizeEditor(editor) {
  for (const node of editor.querySelectorAll("*")) {
    if (node.tagName === "BR" || node.classList.contains("editor-mention") || node.hasAttribute("data-chat-auto-separator")) continue;
    const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const [start, end] = editorSelectionOffsets(editor), text = editorText(editor);
    let atEnd = false;
    if (range?.collapsed && editor.contains(range.endContainer)) {
      const tail = document.createRange();
      tail.setStart(range.endContainer, range.endOffset);
      tail.setEnd(editor, editor.childNodes.length);
      atEnd = tail.toString().length === 0;
    }
    setEditorText(editor, text);
    setEditorSelection(editor, atEnd ? text.length : start, atEnd ? text.length : end);
    return;
  }
}

function knownMentions(editor, text) {
  // A copied mention only comes back if that name is still in the room.
  return text.replace(/<at>@([^<]+)<\/at>/g, (token, name) => editor.isKnownMention && !editor.isKnownMention(name) ? `@${name}` : token);
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
  if (event.isComposing) return;
  const backward = event.inputType === "deleteContentBackward" || (event.key === "Backspace" && event.keyCode !== 229);
  if (!backward) return;
  const [caret, end] = editorSelectionOffsets(editor);
  if (caret !== end) return;
  const chips = [...editor.querySelectorAll(".editor-mention")];
  const separator = [...editor.querySelectorAll("[data-chat-auto-separator]")].find((node) => {
    const start = lengthBefore(editor, node, 0);
    return caret === start + 1 && node.previousElementSibling?.classList.contains("editor-mention");
  });
  const mention = separator?.previousElementSibling || chips.find((node) => {
    const start = lengthBefore(editor, node, 0);
    return caret > start && caret <= start + `<at>@${mentionName(node)}</at>`.length;
  });
  if (!mention) return;
  const start = lengthBefore(editor, mention, 0);
  const autoSeparator = mention.nextElementSibling?.dataset.chatAutoSeparator ? mention.nextElementSibling : null;
  event.preventDefault(); mention.remove(); autoSeparator?.remove(); setCaret(editor, start);
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
  editor.moveCaretToLineEdge = (end) => {
    const [start, finish] = editorSelectionOffsets(editor);
    const text = editorText(editor);
    const caret = end ? finish : start;
    const next = text.indexOf("\n", caret);
    // A native Home next to a non-editable chip can land inside the chip, where
    // the caret is invisible. Re-seat all line-edge moves in a real text node.
    const lineStart = end ? caret : text.lastIndexOf("\n", caret - 1) + 1;
    const target = end ? (next === -1 ? text.length : next) : lineStart;
    // A caret before a leading mention chip can render invisibly in Chromium.
    // Home starts at the first editable character after that chip instead.
    const leading = !end ? text.slice(lineStart).match(/^(?:<at>@[^<]+<\/at>)+/) : null;
    setCaret(editor, leading ? lineStart + leading[0].length : target);
  };
  editor.setSelectionRange = (start, end = start) => setEditorSelection(editor, start, end);
  editor.replaceTextRange = (start, end, value) => replaceEditorRange(editor, start, end, value);
  editor.addEventListener("input", pruneTrustedChipNames);
  editor.addEventListener("keydown", (event) => deleteMentionAtCaret(editor, event));
  editor.addEventListener("beforeinput", (event) => deleteMentionAtCaret(editor, event));
  editor.addEventListener("pointerdown", (event) => {
    const chip = event.target.closest?.(".editor-mention");
    if (!chip || !editor.contains(chip)) return;
    event.preventDefault();
    editor.focus({ preventScroll: true });
    // A tap on a chip is usually followed by Backspace/Delete. Place the caret
    // after it so a narrow or rounded chip cannot trap the caret before it.
    setCaret(editor, lengthBefore(editor, chip, 0) + `<at>@${mentionName(chip)}</at>`.length);
  });
  const copySelection = (event) => {
    const [start, end] = editorSelectionOffsets(editor);
    if (start === end) return "";
    const text = editorText(editor).slice(start, end);
    if (!text) return "";
    // Copy mentions in their token form so a paste rebuilds the same chips.
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    if (/<at>@[^<]+<\/at>/.test(text)) event.clipboardData?.setData("text/html", `<div data-chatroom-mentions>${escapeHTML(text)}</div>`);
    return text;
  };
  editor.addEventListener("copy", (event) => { copySelection(event); });
  editor.addEventListener("cut", (event) => {
    const [start, end] = editorSelectionOffsets(editor);
    if (!copySelection(event)) return;
    // The native cut would overwrite the token clipboard; delete the range here.
    replaceEditorRange(editor, start, end, "", false);
    sanitizeEditor(editor);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
  });
  editor.addEventListener("paste", (event) => {
    if (event.defaultPrevented || event.clipboardData?.files.length) return;
    event.preventDefault();
    const [start, end] = editorSelectionOffsets(editor);
    const text = event.clipboardData?.getData("text/plain") || "";
    // Rebuild chips only for copies this app marked; external text stays literal
    // and keeps the native insert path, which handles newlines correctly.
    const marked = (event.clipboardData?.getData("text/html") || "").includes("data-chatroom-mentions");
    const value = marked ? knownMentions(editor, text) : text;
    replaceEditorRange(editor, start, end, value, marked && /<at>@[^<]+<\/at>/.test(value));
    sanitizeEditor(editor);
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
    const marked = html.includes("data-chatroom-mentions");
    const value = marked ? knownMentions(editor, text) : text;
    replaceEditorRange(editor, start, end, value, marked && /<at>@[^<]+<\/at>/.test(value));
    sanitizeEditor(editor);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDrop" }));
  });
}
