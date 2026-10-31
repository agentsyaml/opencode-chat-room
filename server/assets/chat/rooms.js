import { LS } from "./state.js";

export function initRooms(app) {
  const $ = app.$;

  app.showJoin = () => {
    $("#chatView").hidden = true;
    $("#joinView").hidden = false;
    app.updateTitle();
    void app.refreshRoomList();
    $("#inRoomId").focus();
  };
  app.showChat = () => {
    $("#joinView").hidden = true;
    $("#chatView").hidden = false;
  };
  app.renderHead = () => {
    $("#roomName").textContent = app.state.room.name;
    $("#roomIdShort").textContent = app.state.room.id.slice(0, 8);
    $("#btnCopyId").title = app.t("copyRoomIdTitle", { id: app.state.room.id });
    $("#btnCopyId").setAttribute("aria-label", app.t("copyRoomId"));
    app.setText($("#railIdentity"), "identityLabel", { name: app.state.myName });
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
    const entry = app.state.rooms.get(room.id) || { unreadIds: new Map(), unreadOverflow: false, preview: "", previewAt: 0, position: 0, readTs: 0 };
    entry.unreadIds ||= new Map();
    entry.unreadOverflow ||= false;
    entry.room = room;
    entry.name = name;
    entry.preview ||= room.messages.at(-1)?.text || "";
    entry.previewAt ||= room.messages.at(-1)?.createdAt || 0;
    app.state.rooms.set(room.id, entry);
    app.state.roomNames.set(room.id, name);
    app.state.joinedIds.add(room.id);
    app.saveJoinedIds();
    app.saveRoomNames();
    app.startRoomWatcher();
  };

  app.activateRoom = (roomId) => {
    app.state.navigationGeneration++;
    const entry = app.state.rooms.get(roomId);
    if (!entry) return;
    if (app.state.room?.id === roomId) return;
    if (app.state.room) {
      app.saveDraft(app.state.room.id, $("#msgInput").value);
      app.savePosition(app.state.room.id, $("#thread").scrollTop);
    }
    app.stopPolling();
    app.state.room = entry.room;
    app.state.myName = entry.name;
    const hasSavedPosition = app.state.positions.has(roomId);
    entry.position = app.state.positions.get(roomId) ?? entry.position;
    app.state.unread = entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
    app.rendered = 0;
    app.firstMessageId = null;
    app.state.pendingAction = null;
    LS.roomId = roomId;
    LS.name = entry.name;
    app.showChat();
    app.renderHead();
    $("#msgList").textContent = "";
    app.renderMessages(false);
    app.startPolling();
    app.renderMembers();
    $("#thread").scrollTop = hasSavedPosition ? entry.position : entry.position || $("#thread").scrollHeight;
    $("#msgInput").disabled = false;
    $("#msgInput").value = app.state.drafts.get(roomId) || "";
    app.renderFailedMessages();
    app.autoGrow($("#msgInput"));
    app.updateDraftCount();
    app.updateSendState();
    app.hideSendError();
    app.updateBadge();
    app.updateJump();
    app.markActiveRoomRead();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    void app.refreshRoomList();
  };

  app.joinRoom = async (roomId, name) => {
    if (app.state.rooms.has(roomId)) return app.activateRoom(roomId);
    const intent = ++app.state.navigationGeneration;
    app.state.pendingAction = null;
    app.setJoinBusy(true);
    app.hideJoinError();
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}/join`, {
        method: "POST",
        body: JSON.stringify({ sessionID: LS.sessionID, participantId: name, participantName: name }),
      });
      app.enterRoom(room, name, intent);
    } catch (error) {
      if (error.status === 401) {
        app.state.pendingAction = { type: "join", roomId, name };
        if (app.state.room) { app.openChatSettings(); app.showSendError("sendAuth"); }
        else { app.openTokenBox(); app.showJoinError("authRetry"); }
      } else app.showJoinError(error.network ? "networkRetry" : "joinFailed", { message: error.message });
    } finally { app.setJoinBusy(false); }
  };

  app.createRoom = async (pending) => {
    const fromChat = pending?.fromChat ?? Boolean(app.state.room);
    const name = pending?.name || (fromChat ? app.state.myName : $("#inName").value.trim()) || app.t("guest");
    const roomName = pending?.roomName || $(fromChat ? "#inRoomNameChat" : "#inRoomName").value.trim();
    if (!roomName) return fromChat ? app.showSendError("roomNameRequired") : app.showJoinError("roomNameRequired");
    const intent = ++app.state.navigationGeneration;
    app.setJoinBusy(true);
    app.hideJoinError();
    app.state.pendingAction = null;
    if (fromChat) $("#btnCreateChatRoom").disabled = true;
    try {
      const room = await app.api("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName, ownerId: name, sessionID: LS.sessionID }),
      });
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
      } else if (fromChat) app.showSendError("sendFailed", { message: error.message });
      else app.showJoinError("createFailed", { message: error.message });
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
  app.removeJoinedRoom = async (roomId, { leaveServer = false, reason = false } = {}) => {
    const active = app.state.room?.id === roomId;
    const entry = app.state.rooms.get(roomId);
    if (active) {
      app.state.navigationGeneration++;
      app.saveDraft(roomId, $("#msgInput").value);
      app.savePosition(roomId, $("#thread").scrollTop);
      app.stopPolling();
      app.closeMention();
      app.state.room = null;
      app.state.myName = "";
      app.state.unread = 0;
      app.rendered = 0;
      app.firstMessageId = null;
      $("#msgList").textContent = "";
      $("#msgInput").disabled = true;
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
      if (next) app.activateRoom(next);
      else {
        LS.roomId = "";
        LS.name = "";
        app.showJoin();
        if (reason) app.showJoinError("roomNotFound");
      }
    }
    app.startRoomWatcher();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
  };

  app.startRoomWatcher = () => {
    clearTimeout(app.state.watcherTimer);
    if (!app.state.rooms.size) return;
    app.state.watcherTimer = setTimeout(async () => {
      const inactive = [...app.state.rooms.keys()].filter((id) => id !== app.state.room?.id);
      await bounded(inactive, 3, (roomId) => watchRoom(roomId, app));
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      app.startRoomWatcher();
    }, 5000);
  };

  app.refreshRoomList = async () => {
    const empty = $("#roomListEmpty"), chatEmpty = $("#roomListChatEmpty");
    try {
      const rooms = await app.api(`/rooms?sessionID=${encodeURIComponent(LS.sessionID)}`);
      app.state.availableRooms = rooms;
      if (!app.state.restored) await app.restoreJoinedRooms(rooms);
      else {
        syncCachedRooms(rooms, app);
        await app.discoverDirectRooms(rooms);
      }
      app.renderRoomOptions($("#roomList"), rooms);
      app.renderRoomOptions($("#roomListChat"), rooms);
      empty.hidden = rooms.length > 0;
      chatEmpty.hidden = rooms.length > 0;
    } catch (error) {
      if (error.status === 401) app.state.room ? app.openChatSettings() : app.openTokenBox();
      else {
        app.setText(empty, "roomListError");
        app.setText(chatEmpty, "roomListError");
        empty.hidden = false;
        chatEmpty.hidden = false;
      }
    }
  };

  app.restoreJoinedRooms = async (rooms) => {
    if (app.state.restoring) {
      while (app.state.restoring) await new Promise((resolve) => setTimeout(resolve, 10));
      return;
    }
    app.state.restoring = true;
    try {
    const activeId = LS.roomId;
    const directIds = rooms.filter((room) => room.kind === "direct" && room.directSessionIDs?.includes(LS.sessionID)).map((room) => room.id);
    const candidates = [...new Set([...app.state.joinedIds, ...directIds])];
    const valid = new Set();
    await bounded(candidates, 3, async (roomId) => {
      try {
        const room = rooms.find((item) => item.id === roomId) || await app.api(`/rooms/${encodeURIComponent(roomId)}`);
        const members = await app.api(`/rooms/${encodeURIComponent(roomId)}/members`);
        const me = members.find((member) => member.sessionID === LS.sessionID);
        if (!me) return;
        valid.add(roomId);
        app.ensureJoinedRoom(room, me.name);
      } catch { /* Missing or inaccessible rooms are removed without rejoining them. */ }
    });
    app.state.joinedIds = valid;
    app.saveJoinedIds();
    app.state.restored = true;
    if (activeId && valid.has(activeId)) app.activateRoom(activeId);
    else {
      LS.roomId = "";
      LS.name = "";
      const fallback = valid.values().next().value;
      if (fallback) app.activateRoom(fallback);
      else app.showJoin();
    }
    app.startRoomWatcher();
    } finally { app.state.restoring = false; }
  };

  app.discoverDirectRooms = async (rooms) => {
    const candidates = rooms.filter((room) => room.kind === "direct" && !app.state.rooms.has(room.id));
    await bounded(candidates, 3, async (room) => {
      try {
        const members = await app.api(`/rooms/${encodeURIComponent(room.id)}/members`);
        const me = members.find((member) => member.sessionID === LS.sessionID);
        if (me) app.ensureJoinedRoom(room, me.name);
      } catch { /* A direct room can be deleted while the sidebar refreshes. */ }
    });
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
      const lastMessage = entry?.preview || room.messages.at(-1)?.text || "";
      preview.textContent = entry ? lastMessage : "";
      const status = document.createElement("span");
      status.className = "r-status";
      app.setText(status, entry ? "joined" : "joinAction");
      button.append(name, kind, meta, preview, status);
      const unread = entry?.unreadIds.size || (entry?.unreadOverflow ? 100 : 0);
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
  };

  app.closePanels = () => {
    document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = true; });
    $("#btnMembers").setAttribute("aria-expanded", "false");
    $("#btnSettings").setAttribute("aria-expanded", "false");
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
      });
      await app.removeJoinedRoom(room.id);
      app.clearDraft(room.id);
      app.clearPosition(room.id);
      app.saveFailedMessages(room.id, []);
    } catch (error) { app.showSendError("sendFailed", { message: error.message }); }
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
    if (!fresh) { void app.removeJoinedRoom(roomId, { reason: app.state.room?.id === roomId }); continue; }
    if (app.state.room?.id === roomId) continue;
    const messages = new Map([...entry.room.messages, ...fresh.messages].map((message) => [message.id, message]));
    entry.room = { ...fresh, messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500) };
    const latest = entry.room.messages.at(-1);
    if (latest) { entry.preview = latest.text; entry.previewAt = latest.createdAt; }
  }
}

async function watchRoom(roomId, app) {
  const entry = app.state.rooms.get(roomId);
  if (!entry || app.state.room?.id === roomId) return;
  try {
    const query = new URLSearchParams({ sessionID: app.LS.sessionID, roomId, excludeSelf: "0", timeout: "0" });
    const result = await app.api(`/inbox?${query}`);
    if (app.state.rooms.get(roomId) !== entry) return;
    if (!result.member) { await app.removeJoinedRoom(roomId, { reason: false }); return; }
    if (app.state.room?.id === roomId) return;
    const sawSystem = (result.items || []).some((message) => message.senderId === "system");
    for (const message of result.items || []) {
      if (!entry.unreadIds.has(message.id)) entry.unreadIds.set(message.id, message);
      if (!entry.room.messages.some((item) => item.id === message.id)) entry.room.messages.push({ ...message, roomId });
      if (message.createdAt >= entry.previewAt) {
        entry.preview = message.text;
        entry.previewAt = message.createdAt;
      }
    }
    if (sawSystem || result.hasMore) {
      const latest = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (app.state.rooms.get(roomId) !== entry || app.state.room?.id === roomId) return;
      entry.room.participants = latest.participants;
      const messages = new Map([...entry.room.messages, ...latest.messages].map((message) => [message.id, message]));
      entry.room.messages = [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500);
      const newest = latest.messages.at(-1);
      if (newest && newest.createdAt >= entry.previewAt) { entry.preview = newest.text; entry.previewAt = newest.createdAt; }
    }
    entry.unreadOverflow = Boolean(result.hasMore);
    if (entry.room.messages.length > 500) entry.room.messages.splice(0, entry.room.messages.length - 500);
  } catch (error) {
    if (error.status === 401) app.openChatSettings();
    else if (error.status === 404) await app.removeJoinedRoom(roomId, { reason: false });
  }
}
