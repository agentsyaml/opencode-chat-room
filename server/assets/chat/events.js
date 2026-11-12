import { LS } from "./state.js";
import { copyTextToClipboard } from "./markdown.js";

export function initEvents(app) {
  const $ = app.$;
  app.showRestoreFailure = (message) => {
    document.documentElement.classList.add("session-restore");
    $("#joinView").hidden = $("#chatView").hidden = true;
    $("#restoreView").hidden = false;
    $("#restoreError").textContent = message;
    $("#restoreError").hidden = false;
    $("#btnRestoreRetry").hidden = false;
  };
  const roomRail = $("#roomRail"), drawerTrigger = $("#btnRoomsDrawer"), backdrop = $("#roomDrawerBackdrop");
  const smallScreen = () => matchMedia("(max-width: 760px)").matches;
  let readingPosition = null, resizeFrame = 0, resizeGeneration = 0, scrollGeneration = 0, resizeResetTimer = 0;
  function captureReadingPosition() {
    const thread = $("#thread"), edge = thread.getBoundingClientRect(), top = edge.top + thread.clientTop;
    const anchor = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((row) => row.getBoundingClientRect().bottom > top);
    readingPosition = { roomId: app.state.room?.id, messageId: anchor?.dataset.msgId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      atBottom: thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 4 };
    const missing = app.state.readAnchorGuard?.roomId === readingPosition.roomId && app.state.readAnchorGuard.missing;
    if (readingPosition.roomId && anchor && (!missing || performance.now() <= app.state.userScrollIntentUntil)) {
      app.savePosition(readingPosition.roomId, { messageId: readingPosition.messageId, offset: readingPosition.offset });
    }
  }
  app.captureReadingPosition = captureReadingPosition;
  let layoutQueue = Promise.resolve();
  app.preserveReadingLayout = (change) => {
    const task = layoutQueue.then(async () => {
      captureReadingPosition();
      const saved = readingPosition, roomId = app.state.room?.id, generation = scrollGeneration;
      app.state.layoutScrollAdjusting = true;
      try {
        await change();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (roomId && app.state.room?.id === roomId && generation === scrollGeneration) {
          const thread = $("#thread");
          if (saved.atBottom) thread.scrollTop = thread.scrollHeight;
          else if (saved.messageId) {
            const row = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((item) => item.dataset.msgId === saved.messageId);
            if (row) thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop + saved.offset);
          }
        }
        captureReadingPosition();
      } finally { requestAnimationFrame(() => { app.state.layoutScrollAdjusting = false; }); }
    });
    layoutQueue = task.catch(() => {});
    return task;
  };
  app.restoreReadingPosition = (roomId) => {
    const thread = $("#thread"), saved = app.state.positions.get(roomId), entry = app.state.rooms.get(roomId);
    const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 4;
    const align = (messageId, offset) => {
      const row = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((item) => item.dataset.msgId === messageId);
      if (!row) return false;
      thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop + offset);
      captureReadingPosition(); return true;
    };
    if (typeof saved === "number") { thread.scrollTop = saved; captureReadingPosition(); return { messageId: readingPosition?.messageId, atBottom: atBottom() }; }
    const readTs = entry?.readTs || app.state.lastReadTs.get(roomId) || 0;
    const boundary = readTs && entry?.room.messages.find((message) => message.createdAt > readTs);
    // Unread messages win over the old offset: open on the first unread instead of leaving it below.
    if ((entry?.unreadIds.size || entry?.unreadOverflow) && boundary && align(boundary.id, 0)) return { messageId: boundary.id, atBottom: atBottom() };
    if (saved?.messageId && align(saved.messageId, Number(saved.offset) || 0)) return { messageId: saved.messageId, atBottom: atBottom() };
    if (boundary && align(boundary.id, 0)) return { messageId: boundary.id, atBottom: atBottom() };
    if (!saved && !boundary) return false;
    return saved?.messageId || readTs ? { messageId: saved?.messageId || null, missing: true } : false;
  };
  function closeRoomDrawer(restore = true) {
    roomRail.classList.remove("drawer-open"); roomRail.inert = true; roomRail.setAttribute("aria-hidden", "true");
    backdrop.hidden = true; drawerTrigger.setAttribute("aria-expanded", "false");
    if (restore && smallScreen()) drawerTrigger.focus({ preventScroll: true });
  }
  function syncRoomDrawer() {
    if (!smallScreen()) { roomRail.classList.remove("drawer-open"); roomRail.inert = false; roomRail.removeAttribute("aria-hidden"); backdrop.hidden = true; drawerTrigger.setAttribute("aria-expanded", "false"); }
    else if (!roomRail.classList.contains("drawer-open")) {
      if (roomRail.contains(document.activeElement)) drawerTrigger.focus({ preventScroll: true });
      roomRail.inert = true; roomRail.setAttribute("aria-hidden", "true");
    }
  }
  function preserveReadingPosition() {
    syncRoomDrawer();
    if (!app.state.resizeScrollAdjusting) app.state.userScrollIntentUntil = 0;
    app.state.resizeScrollAdjusting = true;
    const generation = ++resizeGeneration;
    if (app.state.receiptObservationFrame) cancelAnimationFrame(app.state.receiptObservationFrame);
    app.state.receiptObservationFrame = 0; app.state.receiptObservation = null;
    clearTimeout(resizeResetTimer);
    resizeResetTimer = setTimeout(() => { if (generation === resizeGeneration) app.state.resizeScrollAdjusting = false; }, 500);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      const position = readingPosition, thread = $("#thread");
      if (!position?.roomId || position.roomId !== app.state.room?.id) return captureReadingPosition();
      if (position.atBottom) thread.scrollTop = thread.scrollHeight;
      else if (position.messageId) {
        const row = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((item) => item.dataset.msgId === position.messageId);
        if (row) thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop + position.offset);
      }
      captureReadingPosition();
    });
  }
  syncRoomDrawer();
  window.addEventListener("resize", preserveReadingPosition);
  window.addEventListener("pagehide", captureReadingPosition);
  drawerTrigger.addEventListener("click", () => {
    if (roomRail.classList.contains("drawer-open")) return closeRoomDrawer();
    app.closePanels(); roomRail.inert = false; roomRail.removeAttribute("aria-hidden"); roomRail.classList.add("drawer-open");
    backdrop.hidden = false; drawerTrigger.setAttribute("aria-expanded", "true");
    (roomRail.querySelector('.room-row[aria-current="page"]') || $("#btnRefreshRooms")).focus();
  });
  backdrop.addEventListener("click", () => closeRoomDrawer());
  $("#roomListChat").addEventListener("click", (event) => { if (roomRail.classList.contains("drawer-open") && event.target.closest("[data-room-id]")) closeRoomDrawer(); });
  const activateRoom = app.activateRoom;
  const pendingAnchorLoads = new Map();
  function cancelAnchorLoads() {
    for (const { controller } of pendingAnchorLoads.values()) controller.abort();
    pendingAnchorLoads.clear();
  }
  const showJoin = app.showJoin;
  app.showJoin = (...args) => { cancelAnchorLoads(); return showJoin(...args); };
  const removeJoinedRoom = app.removeJoinedRoom;
  app.removeJoinedRoom = (roomId, options) => {
    if (app.state.room?.id === roomId) cancelAnchorLoads();
    return removeJoinedRoom(roomId, options);
  };
  function activateNow(id, preserveRoomListGeneration = false) {
    activateRoom(id, preserveRoomListGeneration); captureReadingPosition();
    if (roomRail.classList.contains("drawer-open")) closeRoomDrawer();
  }
  app.activateRoom = (id, preserveRoomListGeneration = false) => {
    cancelAnchorLoads();
    const entry = app.state.rooms.get(id), saved = app.state.positions.get(id);
    const intent = ++app.state.navigationGeneration;
    if (!entry) return activateNow(id, preserveRoomListGeneration);
    const readTs = entry.readTs || app.state.lastReadTs.get(id) || 0;
    const needAnchor = saved?.messageId && !entry.room.messages.some((message) => message.id === saved.messageId);
    const latest = entry.room.messages.at(-1);
    const needBoundary = !saved?.messageId && readTs && (!latest || latest.createdAt > readTs && !entry.room.messages.some((message) => message.createdAt <= readTs));
    if (!needAnchor && !needBoundary) return activateNow(id, preserveRoomListGeneration);
    const controller = new AbortController();
    const task = loadAnchorHistory(id, entry, saved?.messageId, app, needBoundary ? readTs : 0, controller.signal).catch(() => {}).finally(() => {
      if (pendingAnchorLoads.get(id)?.controller === controller) pendingAnchorLoads.delete(id);
      if (intent === app.state.navigationGeneration) activateNow(id, preserveRoomListGeneration);
    });
    pendingAnchorLoads.set(id, { controller, task });
  };
  document.querySelectorAll(".locale-select").forEach((select) => {
    select.addEventListener("change", () => {
      app.setLocale(select.value);
      if (!app.state.availableRooms) return;
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    });
  });
  $("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#inRoomId").value.trim(), name = $("#inName").value.trim();
    if (!id) return app.showJoinError("roomIdRequired");
    if (!name) return app.showJoinError("nameRequired");
    void app.joinRoom(id, name);
  });
  $("#createForm").addEventListener("submit", (event) => { event.preventDefault(); void app.createRoom(); });
  $("#btnSend").addEventListener("click", () => void app.send());
  $("#btnJump").addEventListener("click", app.jumpToBottom);
  $("#btnCopyId").addEventListener("click", () => void app.copyRoomId());
  $("#btnLeave").addEventListener("click", () => app.leaveRoom(false));
  $("#btnDeleteRoom").addEventListener("click", () => void app.deleteRoom());
  $("#btnMembers").addEventListener("click", () => app.togglePanel("#memberPanel"));
  $("#btnSettings").addEventListener("click", () => app.togglePanel("#chatSettings"));
  $("#btnRoomOptions").addEventListener("click", () => {
    const panel = $("#roomOptions"), open = panel.hidden;
    app.closePanels(); panel.hidden = !open;
    $("#btnRoomOptions").setAttribute("aria-expanded", String(open));
  });
  $("#btnRestoreRetry").addEventListener("click", () => {
    $("#btnRestoreRetry").hidden = true;
    $("#restoreError").hidden = true;
    void app.refreshRoomList();
  });
  $("#btnRefreshRooms").addEventListener("click", () => void app.refreshRoomList());
  $("#btnNewRoom").addEventListener("click", () => {
    const form = $("#railRoomForm");
    form.hidden = !form.hidden;
    if (!form.hidden) $("#inRoomNameChat").focus();
  });
  $("#railRoomForm").addEventListener("submit", (event) => { event.preventDefault(); void app.createRoom(); });
  $("#inRoomNameChat").addEventListener("input", app.hideSendError);

  const input = $("#msgInput");
  window.addEventListener("resize", () => app.autoGrow(input));
  $(".composer").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-failed-action]");
    if (!button) return;
    const { failedAction, failedRoom, failedId } = button.dataset;
    if (failedAction === "retry") void app.retryFailedMessage(failedRoom, failedId);
    else app.discardFailedMessage(failedRoom, failedId);
  });
  input.addEventListener("input", (event) => {
    app.autoGrow(input);
    app.updateSendState();
    app.updateDraftCount();
    if (app.state.room) {
      const id = app.state.room.id;
      app.state.draftRevision.set(id, (app.state.draftRevision.get(id) || 0) + 1);
      app.saveDraft(id, input.draftValue);
    }
    if (!event.isComposing) app.recomputeMention();
  });
  input.addEventListener("compositionend", () => app.recomputeMention(input));
  input.addEventListener("keydown", (event) => handleMessageKey(event, app));
  input.addEventListener("keyup", (event) => {
    if (app.mentionActive && /^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) app.recomputeMention();
  });
  input.addEventListener("click", app.recomputeMention);
  input.addEventListener("blur", () => app.closeMention());
  $("#mentionPicker").addEventListener("mousedown", (event) => {
    const option = event.target.closest(".mention-opt");
    if (!option) return;
    event.preventDefault();
    app.insertMention(option.dataset.name);
  });
  const thread = $("#thread");
  const markScrollIntent = () => { scrollGeneration++; app.state.userScrollIntentUntil = performance.now() + 700; };
  // Stop wheel overscroll at the ends. Without this, some layouts let the
  // document absorb the leftover delta and the view jumps a few pixels.
  thread.addEventListener("wheel", (event) => {
    markScrollIntent();
    const gap = thread.scrollHeight - thread.clientHeight - thread.scrollTop;
    if (event.deltaY < 0 && thread.scrollTop <= 0 || event.deltaY > 0 && gap <= 2) event.preventDefault();
  }, { passive: false });
  thread.addEventListener("touchmove", markScrollIntent, { passive: true });
  thread.addEventListener("keydown", (event) => {
    if (/^(PageDown|PageUp|End|Home|ArrowDown|ArrowUp| )$/.test(event.key)) markScrollIntent();
  });
  thread.addEventListener("pointerdown", (event) => {
    if (event.clientX >= thread.getBoundingClientRect().right - 18) markScrollIntent();
  });
  thread.addEventListener("scroll", () => {
    const adjusting = (app.state.resizeScrollAdjusting || app.state.layoutScrollAdjusting)
      && performance.now() > app.state.userScrollIntentUntil;
    if (!adjusting || performance.now() <= app.state.userScrollIntentUntil) captureReadingPosition();
    if (!adjusting && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) void app.markActiveRoomRead(performance.now() <= app.state.userScrollIntentUntil);
    app.queueReceiptRefresh();
    if (!adjusting) app.queueReceiptObservation();
    app.updateJump();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (!app.state.resizeScrollAdjusting && !app.state.layoutScrollAdjusting) void app.markActiveRoomRead();
      void app.loadManageableMembers();
    }
  });
  window.addEventListener("focus", () => {
    if (!app.state.resizeScrollAdjusting && !app.state.layoutScrollAdjusting) { void app.markActiveRoomRead(); app.queueReceiptObservation(); }
    app.queueReceiptRefresh();
  });
  $("#msgList").addEventListener("click", (event) => {
    const messageButton = event.target.closest("[data-copy-message]");
    if (messageButton) void copyTextToClipboard(messageButton._copyText).then((copied) => app.flash(messageButton, copied ? "copiedMessage" : "copyMessageFailed"));
  });
  ["#inRoomId", "#inName", "#inRoomName"].forEach((selector) => {
    $(selector).addEventListener("input", app.hideJoinError);
  });
  ["#inToken", "#inTokenChat"].forEach((selector) => {
    $(selector).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector(`[data-token-save="${selector.slice(1)}"]`).click();
      }
    });
  });

  document.addEventListener("click", (event) => {
    const save = event.target.closest("[data-token-save]");
    if (save) {
      saveAccessToken(save, app);
      return;
    }
    if (app.mentionActive && !event.target.closest("#mentionPicker")) app.closeMention();
    if (!event.target.closest(".anchor")) app.closePanels();
    if (!event.target.closest("#railRoomForm, #btnNewRoom")) $("#railRoomForm").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && roomRail.classList.contains("drawer-open")) {
      const stops = [...roomRail.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter((node) => node.getClientRects().length);
      const first = stops[0], last = stops.at(-1);
      if (!roomRail.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === "Escape" && roomRail.classList.contains("drawer-open")) { event.preventDefault(); closeRoomDrawer(); return; }
    if (event.key === "Escape" && app.mentionActive) app.closeMention();
    if (event.key === "Escape" && !$("#railRoomForm").hidden) $("#railRoomForm").hidden = true;
    if (event.key === "Escape" && (!$("#memberPanel").hidden || !$("#chatSettings").hidden)) {
      app.closePanels();
      app.lastFocus?.focus();
    }
  });

  app.applyLocale();
  $("#inToken").value = LS.token;
  $("#inTokenChat").value = LS.token;
  void app.refreshRoomList();
  if (!$("#joinView").hidden) $("#inRoomId").focus();
}

async function loadAnchorHistory(roomId, entry, messageId, app, readTs = 0, signal) {
  let beforeSeq;
  const messages = [];
  while (!signal?.aborted) {
    const query = new URLSearchParams({ limit: "100" });
    if (beforeSeq) query.set("beforeSeq", String(beforeSeq));
    const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/history?${query}`, { signal });
    if (signal?.aborted) return;
    messages.push(...(result.messages || []));
    const found = messageId ? messages.some((message) => message.id === messageId)
      : messages.some((message) => message.createdAt > readTs) && messages.some((message) => message.createdAt <= readTs);
    if (found || !result.hasMore || !result.nextBeforeSeq || result.nextBeforeSeq === beforeSeq) break;
    beforeSeq = result.nextBeforeSeq;
  }
  if (messageId ? !messages.some((message) => message.id === messageId) : !messages.some((message) => message.createdAt > readTs)) return;
  const merged = new Map([...entry.room.messages, ...messages].map((message) => [message.id, { ...message, roomId }]));
  entry.room.messages = [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
}

function saveAccessToken(button, app) {
  const input = document.getElementById(button.dataset.tokenSave);
  input.value = app.setToken(input.value);
  document.querySelector("#inToken").value = LS.token;
  document.querySelector("#inTokenChat").value = LS.token;
  let persistent = false;
  try { persistent = localStorage.getItem("chat.token") === LS.token; } catch { /* Memory fallback is tab-scoped. */ }
  app.flash(button, persistent ? "saved" : "savedMemory");
  void app.refreshRoomList();
  void app.verifyAdminToken?.();
  app.retryPendingAction();
}

function handleMessageKey(event, app) {
  if (app.handleMentionKey(event, event.currentTarget)) return;
  if (app.mentionActive && !event.isComposing && event.keyCode !== 229) {
    if (event.key === "ArrowDown") { event.preventDefault(); app.moveMention(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); app.moveMention(-1); return; }
    if (event.key === "Escape") { event.preventDefault(); app.closeMention(); return; }
    if (event.key === "Enter" || event.key === "Tab") {
      if (app.mention?.items.length) {
        event.preventDefault();
        app.insertMention(app.mention.items[app.mention.index]);
        return;
      }
      app.closeMention();
      if (event.key === "Tab") return;
    }
  }
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && (event.ctrlKey || !event.shiftKey)) {
    event.preventDefault();
    void app.send();
  }
}
