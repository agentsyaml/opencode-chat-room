import { createRandomId, LS } from "./state.js";
import { renderMarkdown } from "./markdown.js";
import { hasMessageSelection, pruneMessageRows, trimMessages } from "./message-window.js";
import { formatSystemMessage, setRoomPreview } from "./system-messages.js";
import { installEditor } from "./editor.js";

export function initMessages(app) {
  const $ = app.$;
  installEditor($("#msgInput"));
  let pollDelay = 2000;

  app.autoGrow = (textarea) => {
    const thread = $("#thread"), atBottom = Boolean(app.state.room && Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) < 1);
    textarea.style.overflowY = "hidden";
    const style = getComputedStyle(textarea), line = parseFloat(style.lineHeight);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    if (!textarea.value) {
      textarea.style.height = `${Math.max(line + padding + border, parseFloat(style.minHeight) || 0)}px`;
      if (atBottom) thread.scrollTop = thread.scrollHeight;
      return;
    }
    textarea.style.height = "auto";
    const limit = line * 5 + padding;
    const overflow = textarea.scrollHeight > limit + 1;
    textarea.style.height = `${Math.min(textarea.scrollHeight, limit) + border}px`;
    textarea.style.overflowY = overflow ? "auto" : "hidden";
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  };
  app.updateSendState = () => { $("#btnSend").disabled = !$("#msgInput").value.trim(); };
  app.updateDraftCount = () => app.setText($("#draftCount"), "messageCount", { count: $("#msgInput").value.length });
  app.renderFailedMessages = () => {
    const composer = $("#msgInput").closest(".composer");
    let panel = composer.querySelector(".failed-messages");
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "failed-messages";
      panel.setAttribute("aria-live", "polite");
      composer.insertBefore(panel, $(".composer-row"));
    }
    const roomId = app.state.room?.id, items = roomId && app.state.failedMessages.get(roomId) || [];
    panel.textContent = "";
    panel.hidden = !items.length;
    if (!items.length) return;
    const heading = document.createElement("h3");
    heading.textContent = app.t("failedMessages");
    panel.append(heading);
    for (const item of items) {
      const row = document.createElement("article"), text = document.createElement("p");
      row.className = "failed-message";
      if (item.replyTarget) {
        const context = document.createElement("small"); context.className = "failed-reply-context";
        context.textContent = `${item.replyTarget.senderId}: ${String(item.replyTarget.text).slice(0, 120)}`;
        row.dataset.replyTargetId = item.replyToMessageID; row.append(context);
      }
      text.textContent = item.text;
      row.append(text, failedAction("retryFailed", roomId, item.id, app), failedAction("discardFailed", roomId, item.id, app));
      panel.append(row);
    }
  };
  app.discardFailedMessage = (roomId, failedId) => {
    app.saveFailedMessages(roomId, (app.state.failedMessages.get(roomId) || []).filter((item) => item.id !== failedId));
    app.renderFailedMessages();
  };
  app.retryFailedMessage = async (roomId, failedId) => {
    const item = app.state.failedMessages.get(roomId)?.find((message) => message.id === failedId);
    if (!item || app.state.retryingFailedIds.has(failedId)) return;
    app.state.retryingFailedIds.add(failedId);
    app.renderFailedMessages();
    try {
      const questionTarget = item.replyTarget?.isQuestion, entry = app.state.rooms.get(roomId);
      const updated = questionTarget ? (await app.answerQuestionFromReply(roomId, item.replyToMessageID, item.text), entry?.room)
        : await app.api(`/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, text: item.text, isQuestion: Boolean(item.isQuestion), ...(item.replyToMessageID ? { replyToMessageID: item.replyToMessageID } : {}) }) });
      app.completeAttachmentsFromText?.(roomId, item.text);
      if (entry) {
        if (!questionTarget) entry.room = mergeRoom(entry.room, updated);
        const latest = entry.room.messages.at(-1);
        if (latest && latest.createdAt >= entry.previewAt) setRoomPreview(entry, latest);
      }
      app.discardFailedMessage(roomId, failedId);
      if (app.state.room?.id === roomId && entry) {
        app.state.room = entry.room;
        app.renderMessages(true);
        app.renderMembers();
        app.markActiveRoomRead();
        app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
        app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      }
    } catch (error) {
      if (app.state.room?.id === roomId) app.showSendError(error.status === 401 ? "sendAuth" : error.network ? "sendNetwork" : "sendFailed", { message: error.message });
    } finally {
      app.state.retryingFailedIds.delete(failedId);
      app.renderFailedMessages();
    }
  };
  app.jumpToBottom = () => {
    app.state.readAnchorGuard = null;
    $("#thread").scrollTop = $("#thread").scrollHeight;
    const entry = app.state.room && app.state.rooms.get(app.state.room.id);
    app.state.unread = entry ? entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0) : 0;
    app.updateBadge();
    app.updateJump();
    void app.markActiveRoomRead();
  };
  app.updateJump = () => {
    const thread = $("#thread");
    const away = thread.scrollHeight - thread.scrollTop - thread.clientHeight > 160;
    $("#btnJump").hidden = !away;
  };
  app.updateBadge = () => {
    const badge = $("#jumpBadge");
    badge.textContent = app.state.unread > 99 ? "99+" : String(app.state.unread);
    badge.hidden = app.state.unread === 0;
    app.updateTitle();
  };
  app.markActiveRoomRead = async () => {
    const room = app.state.room, entry = room && app.state.rooms.get(room.id);
    const generation = app.state.pollGeneration;
    const thread = $("#thread");
    if (!room || !entry || document.hidden || !document.hasFocus()
        || thread.scrollHeight - thread.scrollTop - thread.clientHeight >= 80) return;
    if (app.state.readAnchorGuard?.roomId === room.id) {
      if (performance.now() > app.state.userScrollIntentUntil) return;
      app.state.readAnchorGuard = null;
    }
    const timestamp = room.messages.reduce((latest, message) => Math.max(latest, message.createdAt), entry.readTs);
    if (!timestamp || timestamp <= entry.readTs) return;
    try {
      await app.api("/read", {
        method: "POST", body: JSON.stringify({ roomId: room.id, sessionID: LS.sessionID, ts: timestamp }),
      });
      if (app.state.room?.id !== room.id || app.state.pollGeneration !== generation) return;
      entry.readTs = timestamp;
      app.saveReadTs(room.id, timestamp);
      entry.unreadOverflow = false;
      for (const [id, message] of entry.unreadIds) if (message.createdAt <= timestamp) entry.unreadIds.delete(id);
      app.state.unread = entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
      app.updateBadge();
      app.updateJump();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    } catch { /* The next active poll will retry the read watermark. */ }
  };

  app.renderMessage = (message, live) => {
    const row = document.createElement("li");
    row.dataset.sender = message.senderId;
    row.dataset.ts = message.createdAt;
    row.dataset.msgId = message.id;
    if (message.senderId === "system") {
      row.className = "sys";
      const text = document.createElement("span");
      text.textContent = formatSystemMessage(message, app);
      row.append(text);
    } else {
      const direct = app.state.room.kind === "direct";
      const own = isOwnMessage(message, app);
      const sender = direct
        ? app.state.room.participants.find((person) => person.id === message.senderId)?.name || app.t("guest")
        : message.senderId;
      row.className = `msg${own ? " own" : ""}`;
      const meta = document.createElement("div"), name = document.createElement("span"), time = document.createElement("span");
      meta.className = "msg-meta";
      name.className = "msg-name";
      name.textContent = own ? app.t("you") : sender;
      time.className = "msg-time";
      time.textContent = app.timeHM(message.createdAt);
      meta.append(name, time);
      const body = document.createElement("div");
      body.className = "msg-text";
      renderMarkdown(body, message.text, app);
      const content = document.createElement("div");
      content.className = "msg-content";
      content.append(body, app.createReceiptButton(message, own));
      row.append(meta, content);
    }
    if (message.senderId !== "system") {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "message-copy";
      copy.dataset.copyMessage = "";
      copy.setAttribute("aria-label", app.t("copyMessage"));
      copy.dataset.i18nAriaLabel = "copyMessage";
      copy.dataset.i18nTitle = "copyMessage";
      copy.title = app.t("copyMessage");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("message-copy-icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
      const back = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      back.setAttribute("x", "4"); back.setAttribute("y", "3"); back.setAttribute("width", "13"); back.setAttribute("height", "15"); back.setAttribute("rx", "2");
      const front = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      front.setAttribute("x", "8"); front.setAttribute("y", "7"); front.setAttribute("width", "12"); front.setAttribute("height", "14"); front.setAttribute("rx", "2");
      icon.append(back, front);
      const feedback = document.createElement("span");
      feedback.className = "message-copy-feedback"; feedback.dataset.flashOutput = ""; feedback.dataset.i18n = "copyMessage";
      feedback.hidden = true; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite"); feedback.textContent = app.t("copyMessage");
      copy.append(icon, feedback);
      copy._copyText = String(message.text ?? "");
      row.append(copy);
    }
    if (live) row.classList.add("in");
    return row;
  };

  app.renderMessages = (live = false) => {
    const thread = $("#thread"), list = $("#msgList"), messages = app.state.room.messages;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 2;
    let skipped = 0;
    let anchorId = null, anchorOffset = 0, oldTop = thread.scrollTop;
    const viewport = thread.getBoundingClientRect();
    const firstVisible = [...list.children].find((node) => node.dataset.msgId && node.getBoundingClientRect().bottom > viewport.top);
    anchorId = firstVisible?.dataset.msgId || null;
    anchorOffset = firstVisible ? firstVisible.getBoundingClientRect().top - viewport.top : 0;
    pruneMessageRows(list, messages);
    let last = list.lastElementChild;
    const renderedIds = new Set([...list.querySelectorAll("[data-msg-id]")].map((node) => node.dataset.msgId));
    let startIndex = 0;
    const lastId = [...list.querySelectorAll("[data-msg-id]")].at(-1)?.dataset.msgId;
    if (lastId) for (let index = messages.length - 1; index >= 0; index--) if (messages[index].id === lastId) { startIndex = index + 1; break; }
    for (let index = startIndex; index < messages.length; index++) {
      const message = messages[index];
      if (renderedIds.has(message.id) || app.failedRenderIds.has(message.id)) continue;
      try {
        const day = new Date(message.createdAt).toDateString();
        if (!last || last.dataset.day !== day) {
          const separator = document.createElement("li");
          separator.className = "day-sep";
          separator.dataset.day = day;
          separator.textContent = app.dayText(message.createdAt);
          list.append(separator);
          last = separator;
        }
        const row = app.renderMessage(message, live);
        row.dataset.day = day;
        if (last.classList.contains("msg") && last.dataset.sender === message.senderId
            && message.createdAt - Number(last.dataset.ts) < 8 * 60 * 1000) row.classList.add("repeat");
        list.append(row);
        last = row;
        renderedIds.add(message.id);
      } catch (error) {
        console.error("[chat] Message could not render", error);
        skipped++;
        app.failedRenderIds.add(message.id);
      }
    }
    app.rendered = messages.length;
    app.firstMessageId = messages[0]?.id || app.firstMessageId;
    $("#msgEmpty").hidden = messages.length > 0;
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
    else if (anchorId) {
      const anchor = list.querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      if (anchor) thread.scrollTop += anchor.getBoundingClientRect().top - viewport.top - anchorOffset;
      else thread.scrollTop = oldTop;
    } else if (!live || nearBottom) thread.scrollTop = thread.scrollHeight;
    app.updateJump();
    trimMessages(list, app);
    if (nearBottom) {
      thread.scrollTop = thread.scrollHeight;
      const roomId = app.state.room?.id, generation = app.state.pollGeneration;
      requestAnimationFrame(() => {
        if (app.state.room?.id === roomId && app.state.pollGeneration === generation
            && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) thread.scrollTop = thread.scrollHeight;
      });
    }
    else if (anchorId) {
      const anchor = list.querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      if (anchor) thread.scrollTop += anchor.getBoundingClientRect().top - thread.getBoundingClientRect().top - anchorOffset;
      else thread.scrollTop = oldTop;
    }
    app.queueReceiptRefresh?.();
    app.queueReceiptObservation?.();
    return { skipped };
  };

  app.rerenderMessages = () => {
    if (!app.state.room) return { skipped: 0 };
    const thread = $("#thread"), list = $("#msgList"), oldTop = thread.scrollTop;
    const atBottom = thread.scrollHeight - oldTop - thread.clientHeight < 80;
    const edge = thread.getBoundingClientRect();
    const anchor = [...list.querySelectorAll("[data-msg-id]")].find((node) => node.getBoundingClientRect().bottom > edge.top);
    const anchorId = anchor?.dataset.msgId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - edge.top : 0;
    $("#msgList").textContent = "";
    app.rendered = 0;
    app.firstMessageId = null;
    app.failedRenderIds.clear();
    const result = app.renderMessages(false);
    const nextAnchor = anchorId && list.querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
    if (atBottom) thread.scrollTop = thread.scrollHeight;
    else if (nextAnchor) thread.scrollTop += nextAnchor.getBoundingClientRect().top - edge.top - anchorOffset;
    else thread.scrollTop = oldTop;
    return result;
  };

  app.send = async () => {
    const input = $("#msgInput"), room = app.state.room, replyTarget = room && app.replyTargetFor?.(room.id);
    const isQuestion = !replyTarget && Boolean(app.isQuestionSending?.());
    if (!room || app.state.sendingRooms?.has(room.id)) return;
    const message = app.prepareMessage?.(room.id, input.value) || { text: input.value.trim(), ids: [], ready: Boolean(input.value.trim()) };
    if (!message.ready) return;
    const text = message.text;
    const revision = app.state.draftRevision.get(room.id) || 0;
    app.state.sendingRooms ||= new Set(); app.state.sendingRooms.add(room.id);
    app.closeMention();
    app.clearReplyTarget?.(room.id);
    input.value = "";
    app.clearDraft(room.id);
    app.autoGrow(input);
    app.updateDraftCount();
    app.updateSendState();
    app.hideSendError();
    try {
      let updated;
      if (replyTarget?.isQuestion) { await app.answerQuestionFromReply(room.id, replyTarget.id, text); updated = app.state.rooms.get(room.id)?.room || room; }
      else updated = await app.api(`/rooms/${encodeURIComponent(room.id)}/messages`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, text, isQuestion, ...(!isQuestion && replyTarget ? { replyToMessageID: replyTarget.id } : {}) }),
      });
      app.completeAttachments?.(room.id, message.ids);
      if (app.state.room?.id !== room.id) return;
      app.state.room = updated;
      const entry = app.state.rooms.get(room.id);
      if (entry) {
        entry.room = updated;
        const latest = updated.messages.at(-1);
        if (latest) setRoomPreview(entry, latest);
      }
      app.renderMessages(true);
      $("#thread").scrollTop = $("#thread").scrollHeight;
      app.renderMembers();
      app.state.unread = entry ? entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0) : 0;
      app.updateBadge();
      void app.markActiveRoomRead();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    } catch (error) {
      const unchanged = (app.state.draftRevision.get(room.id) || 0) === revision;
      const failures = app.state.failedMessages.get(room.id) || [];
      app.saveFailedMessages(room.id, [...failures, { id: createRandomId(), text, isQuestion, ...(!isQuestion && replyTarget ? { replyToMessageID: replyTarget.id, replyTarget } : {}) }]);
      app.completeAttachments?.(room.id, message.ids);
      app.renderFailedMessages();
      if (app.state.room?.id !== room.id) return;
      if (unchanged) app.clearDraft(room.id);
      app.autoGrow(input);
      app.updateSendState();
      app.updateDraftCount();
      if (error.status === 401) { app.openChatSettings(); app.showSendError("sendAuth"); }
      else app.showSendError(error.network ? "sendNetwork" : "sendFailed", { message: error.message });
    } finally {
      app.state.sendingRooms.delete(room.id);
      if (app.state.room?.id === room.id) app.updateSendState();
    }
  };

  function isCurrentPoll(roomId, generation) {
    return app.state.polling && app.state.pollGeneration === generation && app.state.room?.id === roomId;
  }

  app.startPolling = () => {
    app.stopPolling();
    const generation = ++app.state.pollGeneration;
    const controller = new AbortController();
    app.state.pollController = controller;
    app.state.polling = true;
    pollDelay = 2000;
    void pollLoop(generation, controller.signal);
  };
  app.stopPolling = () => {
    app.state.polling = false;
    app.state.pollGeneration++;
    app.state.pollController?.abort();
    app.state.pollController = null;
  };

  async function pollLoop(generation, signal) {
    while (app.state.polling && app.state.room && generation === app.state.pollGeneration) {
      await poll(generation, signal).catch(() => {});
      if (!app.state.polling || generation !== app.state.pollGeneration) break;
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
    }
  }

  async function poll(generation, signal) {
    const roomId = app.state.room?.id;
    if (!roomId || !isCurrentPoll(roomId, generation)) return;
    try {
      const entry = app.state.rooms.get(roomId);
      const query = new URLSearchParams({ sessionID: LS.sessionID, roomId, excludeSelf: "0", timeout: "25000", afterTs: String(entry?.receivedTs || 0) });
      const data = await app.api(`/inbox?${query}`, { signal });
      if (!isCurrentPoll(roomId, generation)) return;
      if (data.member === false) {
        void app.removeJoinedRoom(roomId, { reason: true });
        return;
      }
      if (data.member !== true || !Array.isArray(data.items)) return;
       const items = data.items, previousReceivedTs = entry?.receivedTs || 0, messages = app.state.room.messages;
       const known = new Set(messages.map((message) => message.id));
       const previousUnreadOverflow = Boolean(entry?.unreadOverflow);
       let sawSystem = false, added = 0, unreadChanged = false;
       for (const item of items) {
         if (item.senderId === "system") sawSystem = true;
         const wasKnown = known.has(item.id);
         if (!wasKnown) {
           messages.push({ ...item, roomId }); known.add(item.id);
           if (entry && item.createdAt >= entry.previewAt) setRoomPreview(entry, item);
           added++;
         }
         if (entry && item.createdAt > entry.readTs && !isOwnMessage(item, app) && !entry.unreadIds.has(item.id)) {
           entry.unreadIds.set(item.id, item); unreadChanged = true;
         }
       }
      if (entry) entry.receivedTs = items.reduce((latest, item) => Number.isSafeInteger(item.createdAt) ? Math.max(latest, item.createdAt) : latest, previousReceivedTs);
      if (entry) entry.unreadOverflow = Boolean(data.hasMore);
       if (messages.length > 500) { const anchorId = app.state.positions.get(roomId)?.messageId, anchor = anchorId && messages.find((item) => item.id === anchorId); messages.splice(0, messages.length - 500); if (anchor && !messages.includes(anchor)) messages.unshift(anchor); }
      const rendered = app.renderMessages(true);
      if (sawSystem) {
        await app.refreshRoomMeta(roomId, generation);
        if (!isCurrentPoll(roomId, generation)) return;
      }
       if (added || unreadChanged || entry && previousUnreadOverflow !== entry.unreadOverflow) {
        app.state.unread = entry ? entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0) : app.state.unread + added;
        app.updateBadge();
      }
      if (rendered.skipped === 0) void app.markActiveRoomRead();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      if (!app.lastReconcileAt || Date.now() - app.lastReconcileAt > 120000) {
        app.lastReconcileAt = Date.now();
        void app.reconcileRoom(roomId, generation);
      }
      app.setOnline(true);
      pollDelay = data.hasMore && (entry?.receivedTs || 0) > previousReceivedTs ? 0 : 2000;
    } catch (error) {
      if (!isCurrentPoll(roomId, generation)) return;
      if (error.status === 401) {
        app.setOnline(false);
        if ($("#chatSettings").hidden) app.openChatSettings();
        pollDelay = Math.min(pollDelay * 2, 30000);
      } else if (error.status === 404) {
        void app.removeJoinedRoom(roomId, { reason: true });
      } else {
        app.setOnline(false);
        pollDelay = 2000;
      }
    }
  }

  app.refreshRoomMeta = async (roomId = app.state.room?.id, generation = app.state.pollGeneration) => {
    if (!roomId) return;
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (!isCurrentPoll(roomId, generation)) return;
      app.state.room.participants = room.participants;
      app.renderMembers();
    } catch { /* The next room event will retry. */ }
  };

  app.reconcileRoom = async (roomId, generation = app.state.pollGeneration) => {
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (!isCurrentPoll(roomId, generation)) return;
      const current = app.state.room.messages;
      const ids = new Set(current.map((message) => message.id));
      const missing = room.messages.filter((message) => !ids.has(message.id));
      if (!missing.length && !app.failedRenderIds.size) return;
      for (const message of missing) {
        const index = current.findIndex((item) => item.createdAt > message.createdAt);
        current.splice(index < 0 ? current.length : index, 0, message);
      }
      if (current.length > 500) current.splice(0, current.length - 500);
      const result = app.rerenderMessages();
      if (result.skipped === 0) void app.markActiveRoomRead();
    } catch { /* Try again during the next reconciliation. */ }
  };

  function failedAction(key, roomId, failedId, app) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = app.t(key);
    button.dataset.failedAction = key === "retryFailed" ? "retry" : "discard";
    button.dataset.failedRoom = roomId;
    button.dataset.failedId = failedId;
    button.disabled = app.state.retryingFailedIds.has(failedId);
    return button;
  }

  function mergeRoom(current, updated) {
    const messages = new Map([...(current?.messages || []), ...updated.messages].map((message) => [message.id, message]));
    return { ...updated, messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500) };
  }

}

export function isOwnMessage(message, app, room = app.state.room, myName = app.state.myName) {
  const direct = room.kind === "direct";
  const sameName = app.state.memberSessions.get(room.id)?.filter((member) => member.name === message.senderId);
  return direct ? message.senderId === LS.sessionID
    : message.senderSessionID ? message.senderSessionID === LS.sessionID
      : message.senderId === myName && sameName?.length === 1 && sameName[0].sessionID === LS.sessionID;
}
