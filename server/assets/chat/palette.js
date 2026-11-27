import { icon } from "./icons.js";

// Alt+Space or Ctrl+P opens one keyboard-first surface: message search plus common room commands.

const SEARCH_DEBOUNCE_MS = 120;

export function initPalette(app) {
  const dialog = app.$("#paletteDialog");
  if (!dialog) return;
  const input = app.$("#paletteInput"), list = app.$("#paletteList"), status = app.$("#paletteStatus");
  const scopeButton = app.$("#paletteScope"), scopeLabel = app.$("#paletteScopeLabel"), modeLabel = app.$("#paletteMode");
  let scope = "room", items = [], selected = -1, sequence = 0, searchTimer = 0, suppressComposerFocus = false, hitTimer = 0;
  const t = (key, values) => app.t(key, values);
  const room = () => app.state.room;

  // The eyebrow names the real key on this platform, matching the shortcut sheet.
  const combo = app.$("#paletteCombo");
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  if (combo) combo.textContent = mac ? "Ctrl + P / Option + Space" : "Ctrl + P / Alt + Space";

  const commands = () => {
    const available = [
      { id: "refresh", label: t("refreshRooms"), en: "Refresh rooms", icon: "arrow_sync", keywords: "reload rooms", run: () => void app.refreshRoomList?.() },
      { id: "create", label: t("createRoom"), en: "New room", icon: "add", keywords: "new room", focusComposer: false,
        run: () => room() ? app.openCreateRoomDialog?.() : app.$("#inRoomName")?.focus({ preventScroll: true }) },
      { id: "settings", label: t("settings"), en: "Settings", icon: "options", keywords: "preferences theme language", focusComposer: false, run: () => app.openSettings?.() },
    ];
    if (room()) available.push(
      { id: "members", label: t("members"), en: "Members", icon: "people", keywords: "people roster", focusComposer: false, run: () => app.$("#btnMembers")?.click() },
      { id: "questions", label: t("questions"), en: "Questions", icon: "question_circle", keywords: "answers", focusComposer: false, run: () => app.$("#btnQuestions")?.click() },
      { id: "announcements", label: t("announcements"), en: "Announcements", icon: "megaphone", keywords: "notice board", focusComposer: false, run: () => app.$("#btnAnnouncements")?.click() },
      ...(room().kind === "direct" ? [] : [{ id: "tasks", label: t("tasksTitle"), en: "Tasks", icon: "checkmark", keywords: "todo checklist work", focusComposer: false, run: () => app.openTasksDialog?.() }]),
      { id: "reminders", label: t("reminders"), en: "Reminders", icon: "alert", keywords: "schedule alarm", focusComposer: false, run: () => app.$("#btnReminders")?.click() },
      { id: "leave", label: t("paletteLeaveRoom"), en: "Leave room", icon: "arrow_exit", keywords: "exit quit", focusComposer: false, run: () => app.leaveRoom?.(false) },
      { id: "latest", label: t("paletteJumpLatest"), en: "Jump to latest", icon: "arrow_down", keywords: "bottom newest", run: () => app.jumpToBottom?.() },
    );
    return available;
  };

  const scopeText = () => t(scope === "all" ? "paletteScopeAll" : "paletteScopeRoom");
  const syncScope = () => {
    scopeLabel.textContent = scopeText();
    scopeButton.dataset.scope = scope;
    scopeButton.title = t("paletteScopeHint");
    scopeButton.setAttribute("aria-label", `${scopeText()}. ${t("paletteScopeHint")}`);
  };

  const appendSnippet = (node, text, needle) => {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!flat) { node.textContent = ""; return; }
    const lower = flat.toLowerCase(), match = needle ? lower.indexOf(needle.toLowerCase()) : -1;
    let start = 0, end = flat.length;
    if (flat.length > 180) {
      start = match > 60 ? match - 60 : 0;
      end = Math.min(flat.length, start + 180);
    }
    const body = flat.slice(start, end);
    if (start > 0) node.append("…");
    if (match >= start && match < end) {
      const offset = match - start;
      node.append(body.slice(0, offset));
      const mark = document.createElement("mark");
      mark.textContent = body.slice(offset, offset + needle.length);
      node.append(mark, body.slice(offset + needle.length));
    } else node.append(body);
    if (end < flat.length) node.append("…");
  };

  const syncSelection = () => {
    const rows = [...list.querySelectorAll(".palette-row")];
    rows.forEach((row, index) => {
      row.setAttribute("aria-selected", String(index === selected));
      const enter = row.querySelector(".palette-enter");
      if (enter) enter.hidden = index !== selected;
    });
    input.setAttribute("aria-expanded", String(items.length > 0));
    if (items.length && selected >= 0) input.setAttribute("aria-activedescendant", `palette-option-${selected}`);
    else input.removeAttribute("aria-activedescendant");
    rows[selected]?.scrollIntoView({ block: "nearest" });
  };

  const render = (next, emptyKey) => {
    items = next;
    selected = next.length ? 0 : -1;
    list.textContent = "";
    next.forEach((item, index) => {
      const row = document.createElement("li");
      row.id = `palette-option-${index}`;
      row.className = `palette-row ${item.kind === "command" ? "palette-command" : "palette-result"}`;
      row.setAttribute("role", "option");
      row.style.setProperty("--palette-i", String(Math.min(index, 9)));
      if (item.kind === "command") {
        const badge = document.createElement("span");
        badge.className = "palette-icon";
        badge.innerHTML = icon(item.icon || "arrow_right");
        const label = document.createElement("span");
        label.className = "palette-label";
        label.textContent = item.label;
        const enter = document.createElement("kbd");
        enter.className = "palette-enter";
        enter.setAttribute("aria-hidden", "true");
        enter.textContent = "↵";
        row.append(badge, label, enter);
      } else {
        const top = document.createElement("span");
        top.className = "palette-result-top";
        const roomName = document.createElement("span");
        roomName.className = "palette-room";
        roomName.textContent = item.roomName || app.state.roomNames.get(item.roomId) || "";
        const sender = document.createElement("span");
        sender.className = "palette-sender";
        sender.textContent = item.sender || "";
        const time = document.createElement("time");
        time.className = "palette-time";
        if (item.createdAt) time.dateTime = new Date(item.createdAt).toISOString();
        time.textContent = item.createdAt ? app.fmtTime(item.createdAt) : "";
        top.append(roomName, sender, time);
        const snippet = document.createElement("span");
        snippet.className = "palette-snippet";
        appendSnippet(snippet, item.text, input.value.trim());
        row.append(top, snippet);
      }
      row.addEventListener("click", () => { selected = index; syncSelection(); activate(item); });
      list.append(row);
    });
    if (!next.length && emptyKey) {
      const empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = t(emptyKey);
      list.append(empty);
    }
    syncSelection();
  };

  // Empty input is search, not a command wall: commands appear only after "/".
  const showIdle = () => {
    clearTimeout(searchTimer);
    sequence++;
    dialog.dataset.mode = "search";
    dialog.dataset.state = "ready";
    modeLabel.textContent = t("paletteSearchMode");
    list.setAttribute("aria-busy", "false");
    render([], null);
    status.textContent = t("palettePlaceholder");
  };

  const showCommands = (fragment = "") => {
    clearTimeout(searchTimer);
    sequence++;
    const needle = fragment.trim().toLowerCase();
    const available = commands()
      .filter((command) => !needle || `${command.label} ${command.en || ""} ${command.keywords || ""} ${command.id}`.toLowerCase().includes(needle))
      .map((command) => ({ kind: "command", ...command }));
    dialog.dataset.mode = "commands";
    dialog.dataset.state = "ready";
    modeLabel.textContent = t("paletteCommandMode");
    list.setAttribute("aria-busy", "false");
    render(available, "paletteNoCommands");
    status.textContent = needle
      ? available.length ? t("paletteResults", { count: available.length }) : t("paletteNoCommands")
      : t("paletteCommandsHint");
  };

  const senderName = (source, message) => {
    if (source.kind === "direct") return source.participants?.find((person) => person.id === message.senderId)?.name || message.senderId;
    return message.senderId;
  };

  const localSearch = (text, searchScope) => {
    const needle = text.toLowerCase();
    const entries = searchScope === "all"
      ? [...app.state.rooms.values()]
      : [app.state.rooms.get(app.state.room?.id)].filter(Boolean);
    const hits = [];
    for (const entry of entries) {
      const source = entry.room;
      if (!source?.messages) continue;
      for (const message of source.messages) {
        if (message.recalledAt || message.pending || message.senderId === "system") continue;
        const body = String(message.text ?? "");
        if (!body.toLowerCase().includes(needle)) continue;
        const hit = {
          roomId: source.id,
          roomName: source.name || app.state.roomNames.get(source.id) || "",
          messageId: message.id,
          sender: senderName(source, message),
          createdAt: message.createdAt,
          text: body,
        };
        hits.push({ kind: "hit", raw: hit, ...hit });
      }
    }
    hits.sort((a, b) => b.createdAt - a.createdAt);
    return hits.slice(0, 80);
  };

  const normalizeHits = (raw) => raw.map((item) => {
    if (!item || typeof item !== "object") return null;
    const message = item.message || {};
    const roomId = String(item.roomId ?? item.roomID ?? item.room?.id ?? "");
    const messageId = String(item.messageId ?? item.messageID ?? message.id ?? item.id ?? "");
    if (!messageId) return null;
    return {
      kind: "hit",
      raw: item,
      roomId,
      messageId,
      roomName: String(item.roomName ?? item.room?.name ?? app.state.roomNames.get(roomId) ?? app.state.rooms.get(roomId)?.room?.name ?? ""),
      sender: String(item.senderName ?? item.sender ?? item.senderId ?? message.senderId ?? ""),
      createdAt: Number(item.createdAt ?? message.createdAt ?? item.ts ?? 0) || 0,
      text: String(item.text ?? item.snippet ?? item.preview ?? message.text ?? ""),
    };
  }).filter(Boolean);

  const failSearch = () => {
    dialog.dataset.state = "ready";
    list.setAttribute("aria-busy", "false");
    render([], null);
    status.textContent = t("paletteSearchFailed");
  };

  const executeSearch = async (text, token) => {
    let result;
    try {
      result = typeof app.searchMessages === "function" ? await app.searchMessages(text, scope) : localSearch(text, scope);
    } catch {
      if (token === sequence) failSearch();
      return;
    }
    if (token !== sequence) return;
    const raw = Array.isArray(result) ? result
      : Array.isArray(result?.hits) ? result.hits
        : Array.isArray(result?.results) ? result.results
          : Array.isArray(result?.items) ? result.items : [];
    const hits = normalizeHits(raw).slice(0, 80);
    dialog.dataset.state = "ready";
    list.setAttribute("aria-busy", "false");
    render(hits, "paletteNoResults");
    status.textContent = hits.length ? t("paletteResults", { count: hits.length }) : t("paletteNoResults");
  };

  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    const token = ++sequence;
    const value = input.value;
    if (!value.trim()) { showIdle(); return; }
    if (value.startsWith("/")) { showCommands(value.slice(1)); return; }
    const wasSearch = dialog.dataset.mode === "search";
    dialog.dataset.mode = "search";
    dialog.dataset.state = "searching";
    modeLabel.textContent = t("paletteSearchMode");
    list.setAttribute("aria-busy", "true");
    // Keep the previous hits visible while typing. Clearing them on every
    // keystroke is what makes the result list flicker.
    if (!wasSearch || !items.length) render([], null);
    else { selected = -1; syncSelection(); }
    status.textContent = t("paletteSearching");
    const text = value.trim();
    searchTimer = setTimeout(() => { void executeSearch(text, token); }, SEARCH_DEBOUNCE_MS);
  };

  const highlightHit = (item) => {
    if (!item?.messageId) return;
    clearTimeout(hitTimer);
    document.querySelectorAll("#msgList .palette-hit").forEach((row) => row.classList.remove("palette-hit"));
    let attempts = 0;
    const reveal = () => {
      const row = document.querySelector(`#msgList [data-msg-id="${CSS.escape(item.messageId)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        row.classList.add("palette-hit");
        hitTimer = setTimeout(() => row.classList.remove("palette-hit"), 4000);
        return;
      }
      if (++attempts < 50) setTimeout(reveal, 50);
    };
    reveal();
  };

  const openLocalHit = (item) => {
    if (item.roomId && app.state.room?.id !== item.roomId) app.activateRoom?.(item.roomId);
  };

  const activate = (item) => {
    if (!item) return;
    if (item.kind === "command") {
      closePalette({ focusComposer: item.focusComposer !== false });
      try { item.run(); } catch { /* The command owns its own error surface. */ }
      return;
    }
    closePalette();
    const raw = item.raw || item;
    if (typeof app.openSearchHit === "function") {
      Promise.resolve().then(() => app.openSearchHit(raw)).catch(() => openLocalHit(item)).finally(() => highlightHit(item));
    } else { openLocalHit(item); highlightHit(item); }
  };

  const moveSelection = (step) => {
    if (!items.length) return;
    selected = selected < 0 ? 0 : (selected + step + items.length) % items.length;
    syncSelection();
  };

  const toggleScope = () => {
    scope = scope === "room" ? "all" : "room";
    syncScope();
    const value = input.value;
    if (!value.trim()) showIdle();
    else if (value.startsWith("/")) showCommands(value.slice(1));
    else scheduleSearch();
  };

  const closePalette = (options = {}) => {
    if (!dialog.open) return;
    suppressComposerFocus = options.focusComposer === false;
    dialog.close();
  };

  const openPalette = () => {
    if (dialog.open) { input.focus(); return; }
    app.closePanels?.();
    app.closeMention?.();
    input.value = "";
    scope = "room";
    syncScope();
    showIdle();
    dialog.showModal();
    input.focus();
  };
  app.openPalette = openPalette;

  input.addEventListener("input", (event) => { if (!event.isComposing) scheduleSearch(); });
  // IME commits (Chinese, Japanese, Korean) may fire no plain input event after
  // composition ends, so filter the committed text here as well.
  input.addEventListener("compositionend", () => scheduleSearch());
  scopeButton.addEventListener("click", () => { toggleScope(); input.focus(); });
  app.$("#btnClosePalette")?.addEventListener("click", () => closePalette());
  let dismissPress = false;
  dialog.addEventListener("pointerdown", (event) => { dismissPress = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dismissPress) closePalette();
    dismissPress = false;
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closePalette(); });
  dialog.addEventListener("close", () => {
    clearTimeout(searchTimer);
    sequence++;
    list.setAttribute("aria-busy", "false");
    const suppressed = suppressComposerFocus;
    suppressComposerFocus = false;
    if (suppressed) return;
    requestAnimationFrame(() => {
      // A stacked dialog keeps its own focus; otherwise the composer owns the page.
      if (document.querySelector("dialog[open]")) return;
      const composer = app.$("#msgInput");
      if (app.state.room && !app.$("#chatView")?.hidden && composer?.contentEditable === "true") {
        const selection = getSelection();
        const selectionInside = Boolean(selection?.anchorNode && composer.contains(selection.anchorNode));
        composer.focus({ preventScroll: true });
        if (!selectionInside) composer.setCaret?.(composer.value.length);
      } else if (!app.state.room) app.$("#inRoomId")?.focus({ preventScroll: true });
    });
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Tab") {
      event.preventDefault();
      toggleScope();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!items.length) return;
      event.preventDefault();
      selected = event.key === "Home" ? 0 : items.length - 1;
      syncSelection();
      return;
    }
    if (event.key === "Enter") {
      if (!items.length || selected < 0) return;
      event.preventDefault();
      activate(items[selected]);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
      const index = digit ? Number(digit) - 1 : -1;
      if (digit) {
        event.preventDefault();
        event.stopPropagation();
        if (index >= 0 && index < items.length) {
          selected = index;
          syncSelection();
        }
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const altSpace = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.code === "Space" || event.key === " ");
    const ctrlP = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
      && (event.code === "KeyP" || event.key.toLowerCase() === "p");
    if (!altSpace && !ctrlP) return;
    event.preventDefault();
    event.stopPropagation();
    openPalette();
  }, true);

  const applyLocale = app.applyLocale;
  app.applyLocale = () => {
    applyLocale();
    syncScope();
    if (!dialog.open) return;
    const value = input.value;
    if (!value.trim()) showIdle();
    else if (value.startsWith("/")) showCommands(value.slice(1));
    else scheduleSearch();
  };
}