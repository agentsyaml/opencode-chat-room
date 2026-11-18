import { LS } from "./state.js";
import { copyTextToClipboard } from "./markdown.js";
import { followsBottom, pointerOrSelectionActive } from "./message-window.js";

export function initEvents(app) {
  const $ = app.$;
  // Thread clicks land on non-focusable nodes, so the browser drops focus to BODY
  // and the next keystroke is lost. Returning it to the composer matches chat UX.
  app.focusComposer = () => {
    if (matchMedia("(max-width: 760px)").matches || document.querySelector("dialog[open]")) return;
    if ($("#chatView").hidden || $("#msgInput").contentEditable !== "true") return;
    if (document.activeElement !== document.body || window.getSelection()?.toString()) return;
    $("#msgInput").focus({ preventScroll: true });
  };
  document.addEventListener("click", () => requestAnimationFrame(() => app.focusComposer?.()));
  // Mobile panels sit below the header, whose height depends on the title and locale.
  const chatHead = document.querySelector("#chatView > .chat-head");
  if (chatHead) {
    const syncHeadBottom = () => document.documentElement.style.setProperty("--chat-head-bottom", `${Math.round(chatHead.getBoundingClientRect().bottom + 8)}px`);
    new ResizeObserver(syncHeadBottom).observe(chatHead);
    syncHeadBottom();
  }
  // The rail footer divider sits above the identity row. Keep it on the composer's
  // divider while the composer is idle; staged files or wrapped lines grow only the
  // composer, so the footer keeps its idle height instead of stretching with it.
  const composer = document.querySelector("#chatView > .composer");
  if (composer) {
    const root = document.documentElement, editor = app.$("#msgInput");
    // A restored draft or staged files must not become the idle height people see on load.
    const idleComposer = () => !editor?.textContent?.trim()
      && !["#sendError", "#replyPreview", "#mentionPicker", "#attachmentTray"].some((selector) => { const node = app.$(selector); return node && !node.hidden; })
      && !composer.querySelector(".failed-messages:not([hidden])");
    const syncComposerBlock = () => {
      const height = composer.getBoundingClientRect().height;
      if (!height || !idleComposer()) return;
      const idle = parseFloat(getComputedStyle(root).getPropertyValue("--composer-block")) || 0;
      if (idle && height > idle + 2) return;
      root.style.setProperty("--composer-block", `${Math.round(height)}px`);
    };
    new ResizeObserver(syncComposerBlock).observe(composer);
    syncComposerBlock();
  }
  // Images, diagrams and attachments grow the list after the first paint and the browser
  // answers with a scroll that looks like the reader moving. Subtract the growth: only a
  // reader who was already at the bottom gets pinned back.
  const messageList = $("#msgList");
  const rememberListMetrics = () => {
    const thread = $("#thread");
    app.state.listMetrics = { height: messageList.offsetHeight, top: thread.scrollTop, client: thread.clientHeight };
  };
  new ResizeObserver(() => {
    const thread = $("#thread"), previous = app.state.listMetrics;
    const grew = messageList.offsetHeight > previous.height, sameBox = thread.clientHeight === previous.client;
    // Rows arrive in bursts, so judging each burst on its own loses the reader after the
    // first one. Follow while the reader has not scrolled away: then every growth pins.
    // A changed viewport height (composer, window) is not list growth and keeps its anchor.
    // A pointer or selection is mid-gesture: moving the content under it loses a drag,
    // a click, or the reader's own position.
    if (grew && sameBox && followsBottom(app)
        && thread.scrollHeight - thread.scrollTop - thread.clientHeight > 1) {
      thread.scrollTop = thread.scrollHeight;
    }
    rememberListMetrics();
  }).observe(messageList);
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
      atBottom: thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 80 };
    const guard = app.state.readAnchorGuard;
    let missing = Boolean(guard) && guard.roomId === readingPosition.roomId && Boolean(guard.missing);
    // A failed restore keeps its anchor while the landing stays put; scrolling to a
    // different message means the reader chose a new position and the old one is stale.
    if (missing) {
      if (!guard.landingId) guard.landingId = readingPosition.messageId;
      else if (readingPosition.messageId !== guard.landingId) missing = guard.missing = false;
    }
    if (readingPosition.roomId && anchor && (!missing || performance.now() <= app.state.userScrollIntentUntil)) {
      app.savePosition(readingPosition.roomId, { messageId: readingPosition.messageId, offset: readingPosition.offset, atBottom: readingPosition.atBottom });
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
          if (saved.atBottom && followsBottom(app)) thread.scrollTop = thread.scrollHeight;
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
  app.restoreReadingPosition = () => {
    const thread = $("#thread");
    // Entering a room always shows the newest messages. Restoring an old anchor
    // leaves the reader above messages that already arrived or grew afterwards.
    thread.scrollTop = thread.scrollHeight;
    app.state.followBottom = true;
    captureReadingPosition();
    return { messageId: readingPosition?.messageId, atBottom: true };
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
      if (position.atBottom && !pointerOrSelectionActive(app)) thread.scrollTop = thread.scrollHeight;
      else if (position.messageId) {
        const row = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((item) => item.dataset.msgId === position.messageId);
        if (row) thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop + position.offset);
      }
      captureReadingPosition();
    });
  }
  syncRoomDrawer();
  window.addEventListener("resize", preserveReadingPosition);
  window.addEventListener("pagehide", () => { captureReadingPosition(); app.flushReadOnHide?.(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { captureReadingPosition(); app.flushReadOnHide?.(); } });
  drawerTrigger.addEventListener("click", () => {
    if (roomRail.classList.contains("drawer-open")) return closeRoomDrawer();
    app.closePanels(); roomRail.inert = false; roomRail.removeAttribute("aria-hidden"); roomRail.classList.add("drawer-open");
    backdrop.hidden = false; drawerTrigger.setAttribute("aria-expanded", "true");
    (roomRail.querySelector('.room-row[aria-current="page"]') || $("#btnRefreshRooms")).focus();
  });
  backdrop.addEventListener("click", () => closeRoomDrawer());
  $("#roomListChat").addEventListener("click", (event) => { if (roomRail.classList.contains("drawer-open") && event.target.closest("[data-room-id]")) closeRoomDrawer(); });
  const activateRoom = app.activateRoom;
  app.activateRoom = (id, preserveRoomListGeneration = false) => {
    activateRoom(id, preserveRoomListGeneration);
    captureReadingPosition();
    if (roomRail.classList.contains("drawer-open")) closeRoomDrawer();
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
  $("#btnCancelToken").addEventListener("click", () => $("#tokenBox").close());
  $("#tokenBox").addEventListener("close", () => {
    if (LS.token) return;
    try { sessionStorage.setItem("chat.keyPromptDismissed", "1"); } catch { /* Storage may be blocked. */ }
  });
  $("#btnRefreshRooms").addEventListener("click", () => void app.refreshRoomList());
  $("#btnNewRoom").addEventListener("click", () => {
    const form = $("#railRoomForm");
    form.hidden = !form.hidden;
    if (!form.hidden) $("#inRoomNameChat").focus();
  });
  $("#railRoomForm").addEventListener("submit", (event) => { event.preventDefault(); void app.createRoom(); });
  $("#inRoomNameChat").addEventListener("input", app.hideSendError);

  const input = $("#msgInput"), thread = $("#thread");
  const markScrollIntent = () => { scrollGeneration++; app.state.userScrollIntentUntil = performance.now() + 700; };
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
  input.addEventListener("compositionend", () => {
    // An ESC-cancelled composition next to a chip can leave the caret inside the
    // non-editable chip, which blocks typing; re-seat it in a real text node.
    const anchor = getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    if (element?.closest(".editor-mention")) input.setCaret(input.selectionStart);
    app.recomputeMention(input);
  });
  input.addEventListener("keydown", (event) => {
    if ((event.key === "PageUp" || event.key === "PageDown")
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      markScrollIntent();
      thread.scrollTop += (event.key === "PageDown" ? 1 : -1) * Math.max(80, thread.clientHeight * 0.9);
      return;
    }
    handleMessageKey(event, app);
  });
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
    app.state.threadPointerDown = true;
  });
  const releasePointer = () => { app.state.threadPointerDown = false; };
  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", releasePointer);
  window.addEventListener("blur", releasePointer);
  thread.addEventListener("scroll", () => {
    const adjusting = (app.state.resizeScrollAdjusting || app.state.layoutScrollAdjusting)
      && performance.now() > app.state.userScrollIntentUntil;
    if (!adjusting) {
      // The growth baseline belongs to the observer alone. A scroll caused by the growth
      // itself arrives before the observer sees the new height, and refreshing the
      // baseline here would make that growth look like no growth at all.
      // Only a scroll the reader started ends following; layout shifts do not.
      const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      if (gap <= 80) app.state.followBottom = true;
      else if (performance.now() <= app.state.userScrollIntentUntil) app.state.followBottom = false;
    }
    if (!adjusting || performance.now() <= app.state.userScrollIntentUntil) captureReadingPosition();
    if (!adjusting && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) void app.markActiveRoomRead(performance.now() <= app.state.userScrollIntentUntil);
    app.queueReceiptRefresh();
    if (!adjusting) app.queueReceiptObservation();
    app.updateJump();
    if (!adjusting && thread.scrollTop < 160) void app.loadOlderHistory?.();
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
    if (messageButton) void copyTextToClipboard(messageButton._copyText, true).then((copied) => app.flash(messageButton, copied ? "copiedMessage" : "copyMessageFailed"));
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
    if (!event.target.closest(".anchor, dialog")) app.closePanels();
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
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      // Same switch as a rail row click on a joined room, in the order the rail renders.
      const joined = (app.state.availableRooms || []).filter((room) => app.state.rooms.has(room.id));
      const index = joined.findIndex((room) => room.id === app.state.room?.id);
      if (event.defaultPrevented || joined.length < 2 || index < 0 || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      app.activateRoom(joined[(index + step + joined.length) % joined.length].id);
    }
  });

  app.applyLocale();
  $("#inToken").value = LS.token;
  $("#inTokenChat").value = LS.token;
  void app.seedFromCache?.().finally(() => app.refreshRoomList());
  if (!$("#joinView").hidden) $("#inRoomId").focus();
}

function saveAccessToken(button, app) {
  const input = document.getElementById(button.dataset.tokenSave);
  input.value = app.setToken(input.value);
  document.querySelector("#inToken").value = LS.token;
  document.querySelector("#inTokenChat").value = LS.token;
  let persistent = false;
  try { persistent = localStorage.getItem("chat.token") === LS.token; } catch { /* Memory fallback is tab-scoped. */ }
  app.flash(button, persistent ? "saved" : "savedMemory");
  // The key prompt is a one-time visit: a stored key gets out of the way again.
  if (LS.token) document.getElementById("tokenBox")?.close();
  void app.refreshRoomList();
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
