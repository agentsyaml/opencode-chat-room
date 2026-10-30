export function initMentions(app) {
  const $ = app.$;
  const mention = { active: false, start: 0, query: "", items: [], index: 0 };
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

  app.openMention = (start, query) => {
    mention.active = app.mentionActive = true;
    mention.start = start;
    app.updateMentionList(query);
    $("#mentionPicker").hidden = false;
    $("#msgInput").setAttribute("aria-expanded", "true");
  };
  app.closeMention = () => {
    mention.active = app.mentionActive = false;
    mention.items = [];
    $("#mentionPicker").hidden = true;
    $("#msgInput").setAttribute("aria-expanded", "false");
    $("#msgInput").removeAttribute("aria-activedescendant");
  };

  app.recomputeMention = () => {
    const input = $("#msgInput"), match = currentMention(input);
    if (match) {
      mention.active ? app.updateMentionList(match.query) : app.openMention(match.start, match.query);
    } else if (mention.active) {
      const at = input.value.lastIndexOf("@");
      if (at < 0) return app.closeMention();
      mention.start = at;
      app.updateMentionList(input.value.slice(at + 1, input.selectionStart));
    }
  };
  app.moveMention = (direction) => {
    if (!mention.items.length) return;
    mention.index = (mention.index + direction + mention.items.length) % mention.items.length;
    highlightMention(app, mention);
  };
  app.insertMention = (name) => {
    const input = $("#msgInput"), end = mention.start + 1 + mention.query.length;
    if (input.value.slice(mention.start, end) !== `@${mention.query}`) return app.closeMention();
    input.setRangeText(`<at>@${name}</at>`, mention.start, end, "end");
    app.closeMention();
    app.autoGrow(input);
    app.updateSendState();
    app.updateDraftCount();
    if (app.state.room) {
      const id = app.state.room.id;
      app.state.draftRevision.set(id, (app.state.draftRevision.get(id) || 0) + 1);
      app.saveDraft(id, input.value);
    }
    input.focus({ preventScroll: true });
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
  const position = input.selectionStart, value = input.value;
  let start = position;
  while (start > 0 && /[\p{L}\p{N}_]/u.test(value[start - 1])) start--;
  const at = start - 1;
  if (at >= 0 && value[at] === "@" && (at === 0 || !/[A-Za-z0-9_]/.test(value[at - 1]))) {
    return { start: at, query: value.slice(start, position) };
  }
  return null;
}

function highlightMention(app, mention) {
  const input = app.$("#msgInput"), options = app.$("#mentionPicker").querySelectorAll(".mention-opt");
  options.forEach((option, index) => {
    option.classList.toggle("active", index === mention.index);
    option.setAttribute("aria-selected", String(index === mention.index));
  });
  const active = options[mention.index];
  if (!active) { input.removeAttribute("aria-activedescendant"); return; }
  input.setAttribute("aria-activedescendant", active.id);
}
