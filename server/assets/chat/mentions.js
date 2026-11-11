import { editorSelectionOffsets, replaceEditorRange } from "./editor.js";

export function initMentions(app) {
  const $ = app.$;
  const mention = { active: false, start: 0, query: "", items: [], index: 0, editor: null };
  app.mention = mention;
  app.mentionActive = false;
  app.updateMentionList = (query = mention.query) => {
    mention.query = query;
    mention.items = filterNames(query, app.mentionNames());
    mention.index = mention.items.length ? 0 : -1;
    const picker = $("#mentionPicker");
    picker.textContent = "";
    const list = document.createElement("ul");
    mention.items.forEach((name, index) => list.append(createOption(name, index, query, app)));
    picker.append(list);
    if (!mention.items.length) {
      const empty = document.createElement("p");
      empty.className = "mention-empty";
      empty.textContent = app.t("mentionEmpty");
      picker.append(empty);
    }
    const hint = document.createElement("p");
    hint.className = "mention-hint";
    hint.textContent = app.t("mentionHint");
    picker.append(hint);
    highlightMention(app, mention);
  };

  app.openMention = (start, query, input = $("#msgInput")) => {
    mention.active = app.mentionActive = true;
    mention.editor = input;
    mention.start = start;
    app.updateMentionList(query);
    const picker = $("#mentionPicker"); picker.hidden = false;
    if (input.id !== "msgInput") {
      const rect = input.getBoundingClientRect();
      Object.assign(picker.style, { position: "fixed", left: `${rect.left}px`, right: `${innerWidth - rect.right}px`, bottom: `${innerHeight - rect.top + 8}px` });
    }
    input.setAttribute("aria-expanded", "true");
  };
  app.closeMention = () => {
    mention.active = app.mentionActive = false;
    mention.items = [];
    mention.editor?.setAttribute("aria-expanded", "false");
    mention.editor?.removeAttribute("aria-activedescendant"); mention.editor = null;
    const picker = $("#mentionPicker"); picker.hidden = true; picker.removeAttribute("style");
  };

  app.recomputeMention = (input = $("#msgInput")) => {
    if (!(input instanceof HTMLElement)) input = $("#msgInput");
    if (mention.active && mention.editor !== input) app.closeMention();
    const match = currentMention(input);
    if (match) {
      mention.active ? app.updateMentionList(match.query) : app.openMention(match.start, match.query, input);
    } else if (mention.active) app.closeMention();
  };
  app.moveMention = (direction) => {
    if (!mention.items.length) return;
    mention.index = (mention.index + direction + mention.items.length) % mention.items.length;
    highlightMention(app, mention);
  };
  app.handleMentionKey = (event, input) => {
    if (!mention.active || mention.editor !== input || event.isComposing || event.keyCode === 229) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); app.moveMention(event.key === "ArrowDown" ? 1 : -1); return true;
    }
    if (event.key === "Escape") { event.preventDefault(); app.closeMention(); return true; }
    if (event.key === "Enter" || event.key === "Tab") {
      if (mention.items.length) { event.preventDefault(); app.insertMention(mention.items[mention.index]); return true; }
      app.closeMention(); return event.key === "Tab";
    }
    return false;
  };
  app.insertMention = (name) => {
    const input = mention.editor || $("#msgInput"), end = mention.start + 1 + mention.query.length;
    if (input.value.slice(mention.start, end) !== `@${mention.query}`) return app.closeMention();
    replaceEditorRange(input, mention.start, end, `<at>@${name}</at>`);
    app.closeMention();
    // Chrome can reset the selection while focus() lands; restore the caret last.
    input.focus({ preventScroll: true });
    input.setCaret?.(mention.start + `<at>@${name}</at>`.length);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  };
}

function filterNames(query, names) {
  const normalized = query.toLocaleLowerCase();
  const starts = [], contains = [];
  for (const name of names) {
    if (!name) continue;
    if (name.toLocaleLowerCase().startsWith(normalized)) starts.push(name);
    else if (name.toLocaleLowerCase().includes(normalized)) contains.push(name);
  }
  const allMatches = !normalized || "all".includes(normalized) || "所有人".includes(normalized);
  return (allMatches ? ["all"] : []).concat(starts, contains);
}

function createOption(name, index, query, app) {
  const option = document.createElement("li");
  option.className = "mention-opt";
  option.id = `mention-opt-${index}`;
  option.dataset.name = name;
  option.setAttribute("role", "option");
  const at = document.createElement("span");
  at.className = "mention-at";
  at.textContent = "@";
  option.append(at);
  const label = name === "all" ? app.t("allMembers") : name;
  const offset = label.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (!query || offset < 0) option.append(document.createTextNode(label));
  else {
    option.append(document.createTextNode(label.slice(0, offset)));
    const hit = document.createElement("span");
    hit.className = "mention-hit";
    hit.textContent = label.slice(offset, offset + query.length);
    option.append(hit, document.createTextNode(label.slice(offset + query.length)));
  }
  return option;
}

function currentMention(input) {
  const [position, end] = editorSelectionOffsets(input), value = input.value;
  if (position !== end) return null;
  let start = position;
  while (start > 0 && /[\p{L}\p{N}_]/u.test(value[start - 1])) start--;
  const at = start - 1;
  if (at >= 0 && value[at] === "@" && (at === 0 || !/[A-Za-z0-9_]/.test(value[at - 1]))) {
    return { start: at, query: value.slice(start, position) };
  }
  return null;
}

function highlightMention(app, mention) {
  const input = mention.editor || app.$("#msgInput"), options = app.$("#mentionPicker").querySelectorAll(".mention-opt");
  options.forEach((option, index) => {
    option.classList.toggle("active", index === mention.index);
    option.setAttribute("aria-selected", String(index === mention.index));
  });
  const active = options[mention.index];
  if (!active) { input.removeAttribute("aria-activedescendant"); return; }
  input.setAttribute("aria-activedescendant", active.id);
}
