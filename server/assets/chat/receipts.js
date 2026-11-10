export function initReceipts(app) {
  const $ = app.$, panel = $("#readerPanel");
  let selectedID = "", trigger = null;
  app.createReceiptButton = (message, own) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-readers";
    button.dataset.messageId = message.id;
    button.dataset.ownMessage = String(own);
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-controls", "readerPanel");
    updateButton(button, message, own);
    return button;
  };
  app.renderReceiptData = (roomId, receipts) => {
    const thread = $("#thread"), edge = thread.getBoundingClientRect();
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 2;
    const anchor = [...$("#msgList").querySelectorAll("[data-msg-id]")].find((node) => node.getBoundingClientRect().bottom > edge.top);
    const anchorId = anchor?.dataset.msgId, anchorTop = anchor ? anchor.getBoundingClientRect().top - edge.top : 0;
    for (const receipt of receipts) app.state.receipts.set(`${roomId}\0${receipt.messageID}`, receipt.readers);
    for (const button of $("#msgList").querySelectorAll(".message-readers")) {
      const message = app.state.room?.messages.find((item) => item.id === button.dataset.messageId);
      if (message) updateButton(button, message);
    }
    if (atBottom) thread.scrollTop = thread.scrollHeight;
    else if (anchorId) {
      const next = $("#msgList").querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      if (next) thread.scrollTop += next.getBoundingClientRect().top - thread.getBoundingClientRect().top - anchorTop;
    }
    if (selectedID) { renderPanel(); positionPanel(); }
  };
  $("#msgList").addEventListener("click", (event) => {
    const button = event.target.closest(".message-readers");
    if (!button) return;
    if (selectedID === button.dataset.messageId) close(true);
    else open(button.dataset.messageId, button);
  });
  $("#btnCloseReaders").addEventListener("click", () => close(true));
  document.addEventListener("click", (event) => {
    if (selectedID && !event.target.closest("#readerPanel, .message-readers")) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedID) { event.preventDefault(); close(true); }
  });
  window.addEventListener("resize", positionPanel);
  window.addEventListener("scroll", positionPanel, true);

  function open(id, button) {
    selectedID = id; trigger = button;
    button.setAttribute("aria-expanded", "true");
    panel.hidden = false; renderPanel(); positionPanel();
    requestAnimationFrame(() => $("#readerHeading").focus({ preventScroll: true }));
  }
  function close(restoreFocus) {
    if (!selectedID) return;
    const previous = trigger;
    selectedID = ""; trigger = null;
    previous?.setAttribute("aria-expanded", "false");
    panel.hidden = true;
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
  }
  function positionPanel() {
    if (!selectedID || panel.hidden) return;
    if (!trigger?.isConnected) return close(false);
    const anchor = trigger.getBoundingClientRect(), margin = 12;
    if (anchor.bottom <= 0 || anchor.top >= innerHeight) return close(false);
    const width = Math.min(320, innerWidth - margin * 2);
    panel.style.width = `${width}px`;
    const belowSpace = innerHeight - margin - anchor.bottom - 8;
    const aboveSpace = anchor.top - margin - 8;
    const placeBelow = belowSpace >= aboveSpace;
    panel.style.maxHeight = `${Math.max(0, placeBelow ? belowSpace : aboveSpace)}px`;
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(margin, Math.min(anchor.right - width, innerWidth - width - margin));
    const top = placeBelow ? anchor.bottom + 8 : anchor.top - height - 8;
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  function renderPanel() {
    const message = app.state.room?.messages.find((item) => item.id === selectedID);
    if (!message) return close(false);
    const readers = readersFor(message);
    $("#readerHeading").textContent = app.t("readerPanelTitle");
    $("#readerCount").textContent = readerStatus(message, readers);
    const list = $("#readerList"); list.textContent = "";
    const members = app.state.memberSessions.get(app.state.room.id) || [];
    for (const reader of readers) {
      const row = document.createElement("li"), name = document.createElement("span"), evidence = document.createElement("span");
      const duplicates = members.filter((member) => member.name === reader.name).length > 1 || readers.filter((item) => item.name === reader.name).length > 1;
      name.textContent = `${reader.name}${duplicates ? ` · ${reader.sessionID.slice(0, 8)}` : ""}${reader.currentMember === false ? ` · ${app.t("departedMember")}` : ""}`;
      evidence.textContent = app.t(`receiptEvidence_${reader.evidence}`);
      row.dataset.readerSessionId = reader.sessionID;
      row.append(name, evidence); list.append(row);
    }
  }
  function updateButton(button, message, own = button.dataset.ownMessage === "true") {
    const readers = readersFor(message), count = readers.length, known = hasReceiptData(message);
    const label = readerStatus(message, readers);
    button.hidden = !own && count === 0;
    button.textContent = String(count || (known ? 0 : "…"));
    button.dataset.readerState = count ? "read" : known ? "empty" : "unknown";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(selectedID === message.id));
    button.title = label;
  }
  function readersFor(message) {
    const key = receiptKey(message);
    const senderID = message.senderSessionID || (app.state.room?.kind === "direct" ? message.senderId : "");
    return (app.state.receipts.get(key) || []).filter((reader) => reader.sessionID !== senderID);
  }
  function hasReceiptData(message) { return app.state.receipts.has(receiptKey(message)); }
  function receiptKey(message) { return `${app.state.room?.id || message.roomId || ""}\0${message.id}`; }
  function readerStatus(message, readers) {
    if (readers.length) return app.t("receiptCount", { count: readers.length });
    return app.t(hasReceiptData(message) ? "receiptNone" : "receiptNotLoaded");
  }
}
