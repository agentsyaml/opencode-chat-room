import { LS, LOADED_MESSAGE_LIMIT } from "./state.js";
import { isUnreadMessage } from "./messages.js";
import { formatRoomPreview, setRoomPreview } from "./system-messages.js";
import { watchRoom } from "./room-watcher.js";
import { cacheRoomSoon, deleteCachedRoom, loadCachedRooms } from "./message-cache.js";
import { renderRoomOptions } from "./room-list.js";
import { initPanels } from "./panels.js";

export function initRooms(app) {
  const $ = app.$;
  initPanels(app);
  let roomListGeneration = 0;
  let autoRefresh;
  const invalidateRoomList = () => { autoRefresh = undefined; return ++roomListGeneration; };

  app.cacheRoomSoon = (roomId) => cacheRoomSoon(app, roomId);
  // Render joined rooms from the local snapshot before the network round trip;
  // the normal restore then validates membership and merges the server delta.
  app.seedFromCache = async () => {
    for (const record of await loadCachedRooms()) {
      const room = record?.room;
      if (!room?.id || app.state.rooms.has(room.id)) continue;
      if (!app.state.joinedIds.has(room.id) && room.id !== LS.roomId) continue;
      app.ensureJoinedRoom(room, record.name || app.state.roomNames.get(room.id) || LS.name || app.t("guest"));
    }
    if (!app.state.room && LS.roomId && app.state.rooms.has(LS.roomId)) app.activateRoom(LS.roomId);
  };

  app.showJoin = (refresh = true, preserveRoomListGeneration = false) => {
    if (!preserveRoomListGeneration) invalidateRoomList();
    document.documentElement.classList.remove("session-restore");
    if (!$("#inName").value) $("#inName").value = LS.name;
    $("#chatView").hidden = true;
    $("#restoreView").hidden = true;
    $("#joinView").hidden = false;
    app.updateTitle();
    if (refresh) void app.refreshRoomList();
    // A late restore must not steal the caret from someone already typing in the join form.
    const active = document.activeElement;
    if (!active || active === document.body || !active.closest?.("#joinView, dialog")) $("#inRoomId").focus();
    // First visit without a stored key: prompt once per tab instead of a dead page.
    if (!LS.token && !keyPromptDismissed()) app.openTokenBox();
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
    const description = app.state.room.description || "";
    $("#roomDescription").textContent = description;
    $("#roomDescription").hidden = !description;
    $("#roomPolicy").hidden = app.state.room.joinPolicy !== "approval";
    // Everyone sees the settings entry; people who cannot manage the room get a
    // secondary style and an explanation. Dissolving the room stays the owner's call.
    const owner = app.state.myName === app.state.room.ownerId;
    const admin = owner || (app.state.room.adminIds ?? []).includes(app.state.myName);
    $("#btnEditRoom").classList.toggle("menu-secondary", !admin);
    $("#btnDeleteRoom").hidden = !owner;
    app.updateTitle();
  };

  app.enterRoom = (room, name, intent = app.state.navigationGeneration) => {
    app.ensureJoinedRoom(room, name);
    if (intent === app.state.navigationGeneration) {
      app.activateRoom(room.id);
      // Membership changed, so the rail needs one refresh. Plain room switches
      // stay cache-only and do not reach the network here.
      void app.refreshRoomList();
    } else {
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      void app.refreshRoomList();
    }
  };

  app.ensureJoinedRoom = (room, name) => {
    const existing = app.state.rooms.get(room.id);
    const entry = existing || { unreadIds: new Map(), unreadOverflow: false, preview: "", previewAt: 0, position: 0, readTs: 0, receivedTs: room.messages.at(-1)?.createdAt ?? 0, recallVersion: 0 };
    entry.unreadIds ||= new Map();
    entry.unreadOverflow ||= false;
    const latest = room.messages.at(-1), savedReadTs = app.state.lastReadTs.get(room.id) ?? (typeof room.lastReadTs === "number" ? room.lastReadTs : undefined);
    if (savedReadTs !== undefined && !app.state.lastReadTs.has(room.id)) app.saveReadTs(room.id, savedReadTs);
    entry.readTs ||= savedReadTs || 0;
    // A server page only carries the newest window; keep older history already
    // loaded or restored from the local cache instead of dropping it.
    if (existing) {
      const merged = new Map([...existing.room.messages, ...room.messages].map((message) => [message.id, message]));
      room = { ...room, messages: [...merged.values()].sort((left, right) => left.createdAt - right.createdAt).slice(-LOADED_MESSAGE_LIMIT) };
    }
    entry.historyComplete = Boolean(existing?.historyComplete) || room.hasMore === false;
    entry.historyBeforeSeq = entry.historyComplete ? null : existing?.historyBeforeSeq ?? (typeof room.messages[0]?.seq === "number" ? room.messages[0].seq : null);
    entry.room = room;
    entry.name = name;
    // Only rebuild unread history when this browser already has a read watermark;
    // a never-opened room is not a burst of unread messages.
    if (!existing && savedReadTs !== undefined) {
      for (const message of room.messages) {
        const unread = message.createdAt > entry.readTs;
        if (unread && isUnreadMessage(message, app, room, name)) entry.unreadIds.set(message.id, message);
      }
      entry.unreadOverflow ||= Boolean(room.hasMore && entry.readTs < (room.messages[0]?.createdAt ?? Infinity));
    }
    entry.receivedTs ??= latest?.createdAt ?? 0;
    entry.recallStale = Boolean(existing && (Number(room.recallVersion) || 0) > (existing.recallVersion || 0));
    entry.recallVersion = Number(room.recallVersion) || entry.recallVersion || 0;
    if (latest && (!existing || latest.createdAt >= entry.previewAt)) setRoomPreview(entry, latest);
    app.state.rooms.set(room.id, entry);
    app.state.roomNames.set(room.id, name);
    app.state.joinedIds.add(room.id);
    app.saveJoinedIds();
    app.saveRoomNames();
    app.startRoomWatcher();
    cacheRoomSoon(app, room.id);
  };

  app.activateRoom = (roomId, preserveRoomListGeneration = false) => {
    app.state.navigationGeneration++;
    const entry = app.state.rooms.get(roomId);
    if (!entry) return;
    if (app.state.room?.id === roomId) return;
    app.cancelThreadScrollAnimation?.();
    if (!preserveRoomListGeneration) invalidateRoomList();
    if (app.state.room) {
      app.saveDraft(app.state.room.id, $("#msgInput").draftValue);
      app.captureReadingPosition?.();
    }
    app.stopPolling();
    app.state.room = entry.room;
    app.state.myName = entry.name;
    app.state.unread = entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
    app.rendered = 0;
    app.firstMessageId = null;
    app.state.pendingAction = null;
    app.state.focusMessageId = null;
    LS.roomId = roomId;
    app.showChat();
    app.renderHead();
    $("#msgList").textContent = "";
    app.state.listMetrics = { height: 0, top: 0, client: 0 };
    // Cached history can hold thousands of messages. Render the newest window
    // first so switching stays immediate; older rows are prepended on demand.
    app.renderMessages(false, 300);
    app.restoreReadingPosition?.(roomId);
    app.state.readAnchorGuard = null;
    app.startPolling();
    if (entry.recallStale) {
      entry.recallStale = false;
      void app.syncLoadedHistory?.(roomId, app.state.pollGeneration);
    }
    app.renderMembers();
    $("#msgInput").contentEditable = "true";
    $("#msgInput").setAttribute("aria-disabled", "false"); $("#msgInput").tabIndex = 0;
    $("#msgInput").draftValue = app.state.drafts.get(roomId) || ""; app.renderReplyPreview?.();
    app.renderFailedMessages();
    app.autoGrow($("#msgInput"));
    // A restored draft and late layout can resize the composer after the initial bottom
    // pin. Keep following for a few frames instead of sampling one fragile moment.
    let settleFrames = 0;
    const settleBottom = () => {
      if (app.state.room?.id !== roomId || !app.state.followBottom) return;
      const thread = $("#thread");
      if (thread.scrollHeight - thread.scrollTop - thread.clientHeight > 1) thread.scrollTop = thread.scrollHeight;
      if (++settleFrames < 30) requestAnimationFrame(settleBottom);
    };
    requestAnimationFrame(settleBottom);
    app.updateDraftCount();
    app.updateSendState();
    app.hideSendError();
    app.updateBadge();
    app.updateJump();
    app.markActiveRoomRead();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    // Switching must render from the local cache. The room watcher refreshes
    // membership metadata in the background; do not start a room-list request here.
    // Switching rooms replaces the clicked row; keep the composer ready to type.
    app.focusComposer?.();
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
      if (room?.status === "pending") { app.showJoinPending(roomId, name); return; }
      app.enterRoom(room, name, intent);
    } catch (error) {
      if (error.status === 401) {
        app.state.pendingAction = { type: "join", roomId, name };
        if (app.state.room) { app.openChatSettings(); app.showSendError("sendAuth"); }
        else { app.openTokenBox(); app.showJoinError("authRetry"); }
      } else if (error.status === 409) { app.showJoinError("joinNameTaken"); void app.refreshRoomList(); }
      else { app.showJoinError(error.network ? "networkRetry" : "joinFailed", { message: error.message }); void app.refreshRoomList(); }
    } finally { app.setJoinBusy(false); }
  };

  app.createRoom = async (pending) => {
    const fromChat = pending?.fromChat ?? Boolean(app.state.room);
    const name = pending?.name || (fromChat ? app.state.myName : $("#inName").value.trim()) || LS.name || app.t("guest");
    const roomName = pending?.roomName || $(fromChat ? "#inRoomNameChat" : "#inRoomName").value.trim();
    const joinPolicy = pending?.joinPolicy ?? ((fromChat ? $("#inApprovalRequiredChat").checked : $("#inApprovalRequired").checked) ? "approval" : "open");
    if (!roomName) {
      if (!fromChat) return app.showJoinError("roomNameRequired");
      app.showCreateRoomError("roomNameRequired"); $("#inRoomNameChat").focus(); return;
    }
    const intent = ++app.state.navigationGeneration; invalidateRoomList();
    app.setJoinBusy(true);
    app.hideJoinError();
    app.state.pendingAction = null;
    if (fromChat) { app.hideCreateRoomError(); $("#btnCreateChatRoom").disabled = true; }
    try {
      const room = await app.api("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName, ownerId: name, sessionID: LS.sessionID, joinPolicy }),
      });
      invalidateRoomList();
      LS.name = name;
      $("#inApprovalRequired").checked = false;
      $("#inApprovalRequiredChat").checked = false;
      if (fromChat) { $("#inRoomNameChat").value = ""; app.closeCreateRoomDialog(false); }
      app.enterRoom(room, name, intent);
    } catch (error) {
      if (error.status === 401) {
        app.state.pendingAction = { type: "create", name, roomName, fromChat, joinPolicy };
        if (fromChat) { app.closeCreateRoomDialog(false); app.openChatSettings(); app.showSendError("sendAuth"); }
        else { app.openTokenBox(); app.showJoinError("authRetry"); }
      } else if (fromChat) {
        if ($("#createRoomDialog")?.open) app.showCreateRoomError("createFailed", { message: error.message });
        else app.showSendError("createFailed", { message: error.message });
        void app.refreshRoomList();
      } else { app.showJoinError("createFailed", { message: error.message }); void app.refreshRoomList(); }
    } finally {
      app.setJoinBusy(false);
      $("#btnCreateChatRoom").disabled = false;
    }
  };

  app.setJoinBusy = (busy) => {
    $("#btnJoin").disabled = busy;
    $("#btnCreate").disabled = busy;
  };

  app.leaveRoom = async (silent = false) => {
    const room = app.state.room;
    if (!room) return;
    if (!silent && !(await app.confirmAction(app.t("leaveRoomConfirm", { name: room.name })))) return;
    app.closePanels?.();
    void app.removeJoinedRoom(room.id, { leaveServer: !silent });
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
      app.state.focusMessageId = null;
      $("#msgList").textContent = "";
      $("#msgInput").contentEditable = "false";
      $("#msgInput").setAttribute("aria-disabled", "true"); $("#msgInput").tabIndex = -1;
      $("#btnSend").disabled = true;
    }
    app.state.rooms.delete(roomId);
    app.state.availableRooms = (app.state.availableRooms || []).filter((room) => room.id !== roomId);
    void deleteCachedRoom(roomId);
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

  app.renderRoomOptions = (list, rooms) => renderRoomOptions(app, list, rooms);

  app.deleteRoom = async () => {
    const room = app.state.room;
    if (!room || !(await app.confirmAction(app.t("deleteConfirm", { name: room.name })))) return;
    try {
      await app.api(`/rooms/${encodeURIComponent(room.id)}`, {
        method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }),
      });
      await app.removeJoinedRoom(room.id);
      app.clearDraft(room.id);
      app.clearPosition(room.id);
      app.saveFailedMessages(room.id, []);
    } catch (error) { app.showSendError("sendFailed", { message: error.message }); }
  };

  app.copyRoomId = async () => {
    const button = $("#btnCopyId");
    try {
      await navigator.clipboard.writeText(app.state.room.id);
      // Swap a class so the ID span survives; flash() would overwrite the whole
      // button and then restore it to "undefined" (the button has no data-i18n).
      clearTimeout(button._copiedTimer);
      button.classList.add("copied");
      button._copiedTimer = setTimeout(() => button.classList.remove("copied"), 1200);
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

// A closed key prompt stays closed for this tab; a server refusal reopens it anyway.
function keyPromptDismissed() {
  try { return sessionStorage.getItem("chat.keyPromptDismissed") === "1"; } catch { return false; }
}

function syncCachedRooms(rooms, app) {
  const remote = new Map(rooms.map((room) => [room.id, room]));
  for (const [roomId, entry] of app.state.rooms) {
    const fresh = remote.get(roomId);
    if (!fresh || fresh.joined === false) { void app.removeJoinedRoom(roomId, { reason: app.state.room?.id === roomId, reconcile: true }); continue; }
    if (app.state.room?.id === roomId) continue;
    const messages = new Map([...entry.room.messages, ...fresh.messages].map((message) => [message.id, message]));
    entry.room = { ...fresh, messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-LOADED_MESSAGE_LIMIT) };
    const latest = entry.room.messages.at(-1);
    if (latest) setRoomPreview(entry, latest);
  }
}
