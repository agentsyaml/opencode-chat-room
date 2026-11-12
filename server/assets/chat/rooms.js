import { LS } from "./state.js";
import { isOwnMessage } from "./messages.js";
import { formatRoomPreview, setRoomPreview } from "./system-messages.js";
import { watchRoom } from "./room-watcher.js";

export function initRooms(app) {
  const $ = app.$;
  let roomListGeneration = 0;
  let autoRefresh;
  const invalidateRoomList = () => { autoRefresh = undefined; return ++roomListGeneration; };

  app.showJoin = (refresh = true, preserveRoomListGeneration = false) => {
    if (!preserveRoomListGeneration) invalidateRoomList();
    document.documentElement.classList.remove("session-restore");
    if (!$("#inName").value) $("#inName").value = LS.name;
    $("#chatView").hidden = true;
    $("#restoreView").hidden = true;
    $("#joinView").hidden = false;
    app.updateTitle();
    if (refresh) void app.refreshRoomList();
    $("#inRoomId").focus();
  };
  app.showChat = () => {
    document.documentElement.classList.remove("session-restore");
    $("#joinView").hidden = true;
    $("#restoreView").hidden = true;
    $("#chatView").hidden = false;
  };
  app.renderHead = () => {
    $("#roomName").textContent = app.state.room.name;
    $("#roomIdShort").textContent = app.state.room.id.slice(0, 8);
    $("#btnCopyId").title = app.t("copyRoomIdTitle", { id: app.state.room.id });
    $("#btnCopyId").setAttribute("aria-label", app.t("copyRoomId"));
    $("#railIdentity").textContent = app.state.myName;
    $("#profileAvatar").textContent = Array.from(app.state.myName.trim())[0]?.toLocaleUpperCase() || "?";
    app.updateTitle();
  };

  app.enterRoom = (room, name, intent = app.state.navigationGeneration) => {
    app.ensureJoinedRoom(room, name);
    if (intent === app.state.navigationGeneration) app.activateRoom(room.id);
    else {
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      void app.refreshRoomList();
    }
  };

  app.ensureJoinedRoom = (room, name) => {
    const existing = app.state.rooms.get(room.id);
    const entry = existing || { unreadIds: new Map(), unreadOverflow: false, preview: "", previewAt: 0, position: 0, readTs: 0, receivedTs: room.messages.at(-1)?.createdAt ?? 0 };
    entry.unreadIds ||= new Map();
    entry.unreadOverflow ||= false;
    const latest = room.messages.at(-1), savedReadTs = app.state.lastReadTs.get(room.id);
    entry.readTs ||= savedReadTs || 0;
    entry.room = room;
    entry.name = name;
    // Only rebuild unread history when this browser already has a read watermark;
    // a never-opened room is not a burst of unread messages.
    if (!existing && savedReadTs !== undefined) for (const message of room.messages) {
      const unread = message.createdAt > entry.readTs || (message.isQuestion && !message.answeredByMessageID);
      if (unread && !isOwnMessage(message, app, room, name)) entry.unreadIds.set(message.id, message);
    }
    entry.receivedTs ??= latest?.createdAt ?? 0;
    if (latest && (!existing || latest.createdAt >= entry.previewAt)) setRoomPreview(entry, latest);
    app.state.rooms.set(room.id, entry);
    app.state.roomNames.set(room.id, name);
    app.state.joinedIds.add(room.id);
    app.saveJoinedIds();
    app.saveRoomNames();
    app.startRoomWatcher();
  };

  app.activateRoom = (roomId, preserveRoomListGeneration = false) => {
    app.state.navigationGeneration++;
    const entry = app.state.rooms.get(roomId);
    if (!entry) return;
    if (app.state.room?.id === roomId) return;
    if (!preserveRoomListGeneration) invalidateRoomList();
    if (app.state.room) {
      app.saveDraft(app.state.room.id, $("#msgInput").draftValue);
      app.captureReadingPosition?.();
    }
    app.stopPolling();
    app.state.room = entry.room;
    app.state.myName = entry.name;
    const savedPosition = app.state.positions.get(roomId);
    app.state.unread = entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
    app.rendered = 0;
    app.firstMessageId = null;
    app.state.pendingAction = null;
    LS.roomId = roomId;
    app.showChat();
    app.renderHead();
    $("#msgList").textContent = "";
    app.renderMessages(false);
    const restoredPosition = app.restoreReadingPosition?.(roomId);
    // A restore above the bottom needs a scroll before it counts as read.
    app.state.readAnchorGuard = restoredPosition && !restoredPosition.atBottom ? { roomId, ...restoredPosition } : null;
    app.startPolling();
    app.renderMembers();
    if (!restoredPosition) $("#thread").scrollTop = typeof savedPosition === "number" ? savedPosition : entry.position || $("#thread").scrollHeight;
    $("#msgInput").contentEditable = "true";
    $("#msgInput").setAttribute("aria-disabled", "false"); $("#msgInput").tabIndex = 0;
    $("#msgInput").draftValue = app.state.drafts.get(roomId) || ""; app.renderReplyPreview?.();
    app.renderFailedMessages();
    app.autoGrow($("#msgInput"));
    app.updateDraftCount();
    app.updateSendState();
    app.hideSendError();
    app.updateBadge();
    app.updateJump();
    if (!restoredPosition || restoredPosition.atBottom) app.markActiveRoomRead();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    void app.refreshRoomList();
    document.dispatchEvent(new CustomEvent("chat-room-activated", { detail: roomId }));
  };

  app.joinRoom = async (roomId, name) => {
    if (app.state.rooms.has(roomId)) return app.activateRoom(roomId);
    const intent = ++app.state.navigationGeneration; invalidateRoomList();
    app.state.pendingAction = null;
    app.setJoinBusy(true);
    app.hideJoinError();
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}/join`, {
        method: "POST",
        body: JSON.stringify({ sessionID: LS.sessionID, participantId: name, participantName: name }),
      });
      invalidateRoomList();
      LS.name = name;
      app.enterRoom(room, name, intent);
    } catch (error) {
      if (error.status === 401) {
        app.state.pendingAction = { type: "join", roomId, name };
        if (app.state.room) { app.openChatSettings(); app.showSendError("sendAuth"); }
        else { app.openTokenBox(); app.showJoinError("authRetry"); }
      } else { app.showJoinError(error.network ? "networkRetry" : "joinFailed", { message: error.message }); void app.refreshRoomList(); }
    } finally { app.setJoinBusy(false); }
  };

  app.createRoom = async (pending) => {
    const fromChat = pending?.fromChat ?? Boolean(app.state.room);
    const name = pending?.name || (fromChat ? app.state.myName : $("#inName").value.trim()) || LS.name || app.t("guest");
    const roomName = pending?.roomName || $(fromChat ? "#inRoomNameChat" : "#inRoomName").value.trim();
    if (!roomName) return fromChat ? app.showSendError("roomNameRequired") : app.showJoinError("roomNameRequired");
    const intent = ++app.state.navigationGeneration; invalidateRoomList();
    app.setJoinBusy(true);
    app.hideJoinError();
    app.state.pendingAction = null;
    if (fromChat) $("#btnCreateChatRoom").disabled = true;
    try {
      const room = await app.api("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName, ownerId: name, sessionID: LS.sessionID }),
      });
      invalidateRoomList();
      LS.name = name;
      if (fromChat) {
        $("#inRoomNameChat").value = "";
        $("#railRoomForm").hidden = true;
      }
      app.enterRoom(room, name, intent);
    } catch (error) {
      if (error.status === 401) {
        app.state.pendingAction = { type: "create", name, roomName, fromChat };
        if (fromChat) { app.openChatSettings(); app.showSendError("sendAuth"); }
        else { app.openTokenBox(); app.showJoinError("authRetry"); }
      } else if (fromChat) { app.showSendError("sendFailed", { message: error.message }); void app.refreshRoomList(); }
      else { app.showJoinError("createFailed", { message: error.message }); void app.refreshRoomList(); }
    } finally {
      app.setJoinBusy(false);
      $("#btnCreateChatRoom").disabled = false;
    }
  };

  app.setJoinBusy = (busy) => {
    $("#btnJoin").disabled = busy;
    $("#btnCreate").disabled = busy;
  };

  app.leaveRoom = (silent = false) => {
    const roomId = app.state.room?.id;
    if (roomId) void app.removeJoinedRoom(roomId, { leaveServer: !silent });
  };
  app.removeJoinedRoom = async (roomId, { leaveServer = false, reason = false, reconcile = false } = {}) => {
    if (!reconcile) invalidateRoomList();
    const active = app.state.room?.id === roomId;
    const entry = app.state.rooms.get(roomId);
    app.disposeRoomAttachments?.(roomId);
    if (active) {
      app.state.navigationGeneration++;
      app.saveDraft(roomId, $("#msgInput").draftValue);
      app.captureReadingPosition?.();
      app.stopPolling();
      app.closeMention();
      app.state.room = null; app.renderReplyPreview?.();
      app.state.myName = "";
      app.state.unread = 0;
      app.rendered = 0;
      app.firstMessageId = null;
      $("#msgList").textContent = "";
      $("#msgInput").contentEditable = "false";
      $("#msgInput").setAttribute("aria-disabled", "true"); $("#msgInput").tabIndex = -1;
      $("#btnSend").disabled = true;
    }
    app.state.rooms.delete(roomId);
    app.state.memberSessions.delete(roomId);
    app.state.joinedIds.delete(roomId);
    app.state.roomNames.delete(roomId);
    app.saveJoinedIds();
    app.saveRoomNames();
    if (leaveServer && entry) {
      void app.api(`/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID }),
      }).catch(() => {});
    }
    if (active) {
      const next = app.state.rooms.keys().next().value;
      if (next) app.activateRoom(next, true);
      else {
        LS.roomId = "";
        app.showJoin(false, true);
        if (reason) app.showJoinError("roomNotFound");
      }
    }
    app.startRoomWatcher();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
  };

  app.startRoomWatcher = () => {
    clearTimeout(app.state.watcherTimer);
    if (!app.state.rooms.size && !app.state.restorePending?.size && !app.state.restoreRetry) return;
    app.state.watcherTimer = setTimeout(async () => {
      const inactive = [...app.state.rooms.keys()].filter((id) => id !== app.state.room?.id);
      await bounded(inactive, 3, (roomId) => watchRoom(roomId, app));
      if (app.state.restorePending?.size || app.state.restoreRetry) void app.refreshRoomList(true);
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      app.startRoomWatcher();
    }, 5000);
  };

  app.refreshRoomList = (automatic = false) => {
    if (automatic && autoRefresh?.generation === roomListGeneration) return autoRefresh.promise;
    const generation = invalidateRoomList(), promise = loadRoomList(generation);
    if (automatic) { autoRefresh = { generation, promise }; const clear = () => { if (autoRefresh?.promise === promise) autoRefresh = undefined; }; void promise.then(clear, clear); }
    return promise;
  };

  async function loadRoomList(generation) {
    const empty = $("#roomListEmpty"), chatEmpty = $("#roomListChatEmpty");
    try {
      const rooms = await app.api(`/rooms?sessionID=${encodeURIComponent(LS.sessionID)}`);
      if (generation !== roomListGeneration) return;
      app.state.restoreRetry = false;
      app.state.availableRooms = rooms;
      if (!app.state.restored || app.state.restorePending?.size) await app.restoreJoinedRooms(rooms, generation);
      else {
        syncCachedRooms(rooms, app);
        await app.discoverDirectRooms(rooms, generation);
      }
      if (generation !== roomListGeneration) return;
      app.renderRoomOptions($("#roomList"), rooms);
      app.renderRoomOptions($("#roomListChat"), rooms);
      empty.hidden = rooms.length > 0;
      chatEmpty.hidden = rooms.length > 0;
    } catch (error) {
      if (generation !== roomListGeneration) return;
      if (error.status === 401) {
        if (!app.state.room && !app.state.restored) { app.showJoin(false); app.openTokenBox(); app.showJoinError("authRetry"); }
        else app.state.room ? app.openChatSettings() : app.openTokenBox();
      }
      else if (!app.state.restored && !app.state.room) app.showRestoreFailure(app.t("networkRetry"));
      else {
        app.setText(empty, "roomListError");
        app.setText(chatEmpty, "roomListError");
        empty.hidden = false;
        chatEmpty.hidden = false;
      }
      if (!app.state.restored) {
        app.state.restoreRetry = true;
        app.state.restorePending = new Set([...app.state.joinedIds, LS.roomId].filter(Boolean));
        app.startRoomWatcher();
      }
    }
  }

  app.restoreJoinedRooms = async (rooms, generation = roomListGeneration) => {
    while (app.state.restoring) { await new Promise((resolve) => setTimeout(resolve, 10)); if (generation !== roomListGeneration) return; }
    if (generation !== roomListGeneration) return;
    app.state.restoring = true;
    try {
    const activeId = LS.roomId;
    const directIds = rooms.filter((room) => room.kind === "direct" && room.directSessionIDs?.includes(LS.sessionID)).map((room) => room.id);
    const candidates = [...new Set([activeId, ...rooms.filter((room) => room.joined).map((room) => room.id), ...app.state.joinedIds, ...directIds].filter(Boolean))];
    const valid = new Set();
    const unresolved = new Set();
    let authFailed = false;
    await bounded(candidates, 3, async (roomId) => {
      if (generation !== roomListGeneration) return;
      try {
        const room = rooms.find((item) => item.id === roomId) || await app.api(`/rooms/${encodeURIComponent(roomId)}`);
        if (generation !== roomListGeneration) return;
        const members = await app.api(`/rooms/${encodeURIComponent(roomId)}/members`);
        if (generation !== roomListGeneration) return;
        const me = members.find((member) => member.sessionID === LS.sessionID);
        if (!me) return;
        valid.add(roomId);
        app.ensureJoinedRoom(room, me.name);
      } catch (error) {
        if (generation !== roomListGeneration) return;
        if (error.status !== 404) {
          unresolved.add(roomId);
          if (error.status === 401) authFailed = true;
          if (error.status === 401) app.state.room ? app.openChatSettings() : app.openTokenBox();
        }
      }
    });
    if (generation !== roomListGeneration) return;
    app.state.joinedIds = new Set([...valid, ...unresolved]);
    app.state.restorePending = unresolved;
    app.saveJoinedIds();
    app.state.restored = unresolved.size === 0;
    if (authFailed) { app.showJoin(false, true); app.openTokenBox(); app.showJoinError("authRetry"); return; }
    if (activeId && valid.has(activeId)) app.activateRoom(activeId, true);
    else if (activeId && unresolved.has(activeId)) {
      app.showRestoreFailure(app.t("networkRetry"));
    }
    else {
      LS.roomId = "";
      const fallback = valid.values().next().value;
      if (fallback) app.activateRoom(fallback, true);
      else if (unresolved.size) app.showRestoreFailure(app.t("networkRetry"));
      else app.showJoin(false, true);
    }
    app.startRoomWatcher();
    } finally { app.state.restoring = false; }
  };

  app.discoverDirectRooms = async (rooms, generation = roomListGeneration) => {
    const candidates = rooms.filter((room) => room.kind === "direct" && !app.state.rooms.has(room.id));
    await bounded(candidates, 3, async (room) => {
      if (generation !== roomListGeneration) return;
      try {
        const members = await app.api(`/rooms/${encodeURIComponent(room.id)}/members`);
        if (generation !== roomListGeneration) return;
        const me = members.find((member) => member.sessionID === LS.sessionID);
        if (me) app.ensureJoinedRoom(room, me.name);
      } catch (error) {
        if (generation !== roomListGeneration) return;
        if (error.status !== 404) {
          app.state.restorePending ||= new Set();
          app.state.restorePending.add(room.id);
          app.state.joinedIds.add(room.id);
          app.saveJoinedIds();
          app.state.restored = false;
          if (error.status === 401) app.state.room ? app.openChatSettings() : app.openTokenBox();
        }
      }
    });
    if (generation !== roomListGeneration) return;
    if (app.state.restorePending?.size) app.startRoomWatcher();
  };

  app.renderRoomOptions = (list, rooms) => {
    if (!list) return;
    list.textContent = "";
    const ordered = [...rooms].sort((left, right) => Number(app.state.rooms.has(right.id)) - Number(app.state.rooms.has(left.id)));
    for (const room of ordered) {
      const row = document.createElement("li"), button = document.createElement("button");
      button.type = "button";
      button.dataset.roomId = room.id;
      const entry = app.state.rooms.get(room.id);
      button.className = `room-row${app.state.room?.id === room.id ? " selected" : ""}${entry ? " joined" : ""}`;
      if (app.state.room?.id === room.id) button.setAttribute("aria-current", "page");
      button.title = app.t(entry ? "joined" : "joinAction");
      const name = document.createElement("span");
      name.className = "r-name";
      name.textContent = room.name;
      const kind = document.createElement("span");
      kind.className = "r-kind";
      if (room.kind === "direct") app.setText(kind, "direct");
      const meta = document.createElement("span");
      meta.className = "r-meta";
      const shownRoom = entry?.room || room;
      meta.textContent = app.t("roomMeta", { members: shownRoom.participants.length, count: shownRoom.messages.length });
      const preview = document.createElement("span");
      preview.className = "r-preview";
      preview.textContent = entry ? formatRoomPreview(entry, room.messages.at(-1), app) : "";
      const status = document.createElement("span");
      status.className = "r-status";
      app.setText(status, entry ? "joined" : "joinAction");
      button.append(name, kind, meta, preview, status);
      const unread = entry && app.state.room?.id !== room.id ? (entry.unreadOverflow ? 100 : entry.unreadIds.size) : 0;
      if (unread) {
        const badge = document.createElement("span");
        badge.className = "r-badge";
        badge.textContent = unread > 99 ? "99+" : String(unread);
        badge.setAttribute("aria-label", app.t("unreadMessages", { count: unread }));
        button.append(badge);
      }
      button.addEventListener("click", () => app.joinRoom(room.id, app.state.myName || $("#inName").value.trim() || app.t("guest")));
      row.append(button);
      list.append(row);
    }
    // Other rooms' unread changes only reach the title through this rerender.
    app.updateTitle();
  };

  app.closePanels = () => {
    document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = true; });
    $("#btnMembers").setAttribute("aria-expanded", "false");
    $("#btnSettings").setAttribute("aria-expanded", "false");
    $("#btnRoomOptions").setAttribute("aria-expanded", "false");
  };
  app.togglePanel = (selector) => {
    const panel = $(selector), wasHidden = panel.hidden;
    app.closePanels();
    panel.hidden = !wasHidden;
    const trigger = $(selector === "#memberPanel" ? "#btnMembers" : "#btnSettings");
    trigger.setAttribute("aria-expanded", String(wasHidden));
    if (wasHidden) {
      app.lastFocus = trigger;
      if (selector === "#memberPanel") void app.loadManageableMembers();
      const heading = panel.querySelector("h3");
      heading.tabIndex = -1;
      heading.focus();
    }
  };
  app.openTokenBox = () => { $("#tokenBox").open = true; };
  app.openChatSettings = () => {
    app.closePanels();
    app.lastFocus = $("#btnSettings");
    $("#chatSettings").hidden = false;
    $("#btnSettings").setAttribute("aria-expanded", "true");
    $("#tokenHint").hidden = false;
    $("#inTokenChat").focus();
  };

  app.deleteRoom = async () => {
    const room = app.state.room;
    if (!room || !confirm(app.t("deleteConfirm", { name: room.name }))) return;
    try {
      await app.api(`/rooms/${encodeURIComponent(room.id)}`, {
        method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }),
        headers: LS.adminToken ? { "X-Chat-Admin-Token": LS.adminToken } : {},
      });
      await app.removeJoinedRoom(room.id);
      app.clearDraft(room.id);
      app.clearPosition(room.id);
      app.saveFailedMessages(room.id, []);
    } catch (error) { app.showSendError(error.status === 403 && error.message.includes("operator token required") ? "adminRoomDeleteDenied" : "sendFailed", { message: error.message }); }
  };

  app.copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(app.state.room.id);
      app.flash($("#btnCopyId"), "copied");
    } catch { app.showSendError("copyFailed", { id: app.state.room.id }); }
  };

  app.autoJoin = async () => {
    await app.refreshRoomList();
  };

  app.retryPendingAction = () => {
    const action = app.state.pendingAction;
    if (action?.type === "join") void app.joinRoom(action.roomId, action.name);
    else if (action?.type === "create") void app.createRoom(action);
    else if (!app.state.room) void app.autoJoin();
  };
}

async function bounded(items, limit, action) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await action(items[cursor++]);
  }));
}

function syncCachedRooms(rooms, app) {
  const remote = new Map(rooms.map((room) => [room.id, room]));
  for (const [roomId, entry] of app.state.rooms) {
    const fresh = remote.get(roomId);
    if (!fresh || fresh.joined === false) { void app.removeJoinedRoom(roomId, { reason: app.state.room?.id === roomId, reconcile: true }); continue; }
    if (app.state.room?.id === roomId) continue;
    const messages = new Map([...entry.room.messages, ...fresh.messages].map((message) => [message.id, message]));
    entry.room = { ...fresh, messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500) };
    const latest = entry.room.messages.at(-1);
    if (latest) setRoomPreview(entry, latest);
  }
}
