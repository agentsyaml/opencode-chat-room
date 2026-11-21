import { LS, LOADED_MESSAGE_LIMIT } from "./state.js";
import { setRoomPreview } from "./system-messages.js";

// Inbox polling, room-meta refresh, and reconciliation live apart from rendering.
export function initMessagePolling(app, isUnreadMessage) {
  const $ = app.$;
  let pollDelay = 2000;
  let recoveryTimer = null;
  let recoveryRoom = null;
  let recoveryGeneration = 0;

  // A hung long-poll cannot notice that the network came back. Probe separately
  // so the connection bar clears as soon as any authenticated request succeeds.
  function stopRecovery() {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recoveryRoom = null;
    recoveryGeneration = 0;
  }
  function scheduleRecovery(immediate = false) {
    const roomId = app.state.room?.id;
    if (!app.state.polling || !roomId) return;
    if (recoveryTimer && recoveryRoom === roomId) {
      if (!immediate) return;
      clearTimeout(recoveryTimer);
    } else stopRecovery();
    recoveryRoom = roomId;
    recoveryGeneration = app.state.pollGeneration;
    recoveryTimer = setTimeout(() => { void probeRecovery(roomId, recoveryGeneration); }, immediate ? 0 : 2000);
  }
  async function probeRecovery(roomId, generation) {
    recoveryTimer = null;
    if (!app.state.polling || app.state.room?.id !== roomId || app.state.pollGeneration !== generation) { stopRecovery(); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await app.api(`/rooms/${encodeURIComponent(roomId)}`, { signal: controller.signal });
      if (!app.state.polling || app.state.room?.id !== roomId || app.state.pollGeneration !== generation) { stopRecovery(); return; }
      app.setOnline(true);
      stopRecovery();
      pollDelay = 2000;
      app.startPolling();
    } catch (error) {
      if (!app.state.polling || app.state.room?.id !== roomId || app.state.pollGeneration !== generation) { stopRecovery(); return; }
      if (error.status === 404) {
        stopRecovery();
        void app.removeJoinedRoom(roomId, { reason: true });
        return;
      }
      if (error.status === 401) {
        stopRecovery();
        app.setOnline(false);
        if (!app.settingsOpen()) app.openChatSettings();
        return;
      }
      recoveryTimer = setTimeout(() => { void probeRecovery(roomId, generation); }, 2000);
    } finally {
      clearTimeout(timer);
    }
  }

  // A restarted network can leave the browser's old request hanging. Probe at
  // once instead of waiting for the long-poll timeout.
  window.addEventListener("online", () => scheduleRecovery(true));

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
    stopRecovery();
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
      // Lets the server answer at once when a recall changed the room since our
      // last rendered snapshot instead of holding the long-poll.
      if (entry && Number.isFinite(entry.recallVersion)) query.set("recallVersion", String(entry.recallVersion));
      // The server long-polls for 25s; abort a dead request so the retry loop
      // can run and the connection bar can recover.
      const request = new AbortController();
      const abort = () => request.abort();
      const timer = setTimeout(abort, 35000);
      signal.addEventListener("abort", abort, { once: true });
      let data;
      try {
        data = await app.api(`/inbox?${query}`, { signal: request.signal });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
      if (!isCurrentPoll(roomId, generation)) return;
      if (data.member === false) {
        void app.removeJoinedRoom(roomId, { reason: true });
        return;
      }
      if (data.member !== true || !Array.isArray(data.items)) return;
       const items = data.items, previousReceivedTs = entry?.receivedTs || 0, messages = app.state.room.messages;
       const known = new Set(messages.map((message) => message.id));
       const previousUnreadOverflow = Boolean(entry?.unreadOverflow);
       let sawSystem = false, sawQuestion = false, added = 0, unreadChanged = false;
       for (const item of items) {
         if (item.senderId === "system") sawSystem = true;
         if (item.isQuestion || item.answerToMessageID) sawQuestion = true;
         const wasKnown = known.has(item.id);
         if (!wasKnown) {
           messages.push({ ...item, roomId }); known.add(item.id);
           if (entry && item.createdAt >= entry.previewAt) setRoomPreview(entry, item);
           added++;
         }
         if (entry && item.createdAt > entry.readTs && isUnreadMessage(item, app) && !entry.unreadIds.has(item.id)) {
           entry.unreadIds.set(item.id, item); unreadChanged = true;
         }
         // An answer to a question clears that question even before the room is read.
         if (entry && item.answerToMessageID && entry.unreadIds.get(item.answerToMessageID)?.isQuestion) {
           entry.unreadIds.delete(item.answerToMessageID); unreadChanged = true;
         }
       }
      // A changed recall version means rows were hidden since the last look; refetch
      // the newest page and patch the rows already on screen.
      const recallVersion = Number(data.recallVersion);
      if (entry && Number.isFinite(recallVersion) && recallVersion !== (entry.recallVersion ?? 0) && !entry.recallSync) {
        entry.recallSync = true;
        app.lastReconcileAt = Date.now();
        void app.reconcileRoom?.(roomId, generation, true);
      }
      if (entry) entry.receivedTs = items.reduce((latest, item) => Number.isSafeInteger(item.createdAt) ? Math.max(latest, item.createdAt) : latest, previousReceivedTs);
      if (entry) entry.unreadOverflow = Boolean(data.hasMore);
       if (messages.length > LOADED_MESSAGE_LIMIT) { const anchorId = app.state.positions.get(roomId)?.messageId, anchor = anchorId && messages.find((item) => item.id === anchorId); messages.splice(0, messages.length - LOADED_MESSAGE_LIMIT); if (anchor && !messages.includes(anchor)) messages.unshift(anchor); }
       app.cacheRoomSoon?.(roomId);
      const rendered = app.renderMessages(true);
      if (sawSystem || sawQuestion) {
        await app.refreshRoomMeta(roomId, generation);
        if (!isCurrentPoll(roomId, generation)) return;
      }
       if (added || unreadChanged || entry && previousUnreadOverflow !== entry.unreadOverflow) {
        app.state.unread = entry ? entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0) : app.state.unread + added;
        app.updateBadge();
        app.updateJump();
      }
      if (rendered.skipped === 0) void app.markActiveRoomRead();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      if (!app.lastReconcileAt || Date.now() - app.lastReconcileAt > 120000) {
        app.lastReconcileAt = Date.now();
        void app.reconcileRoom(roomId, generation);
      }
      app.setOnline(true);
      stopRecovery();
      pollDelay = data.hasMore && (entry?.receivedTs || 0) > previousReceivedTs ? 0 : 2000;
    } catch (error) {
      if (!isCurrentPoll(roomId, generation)) return;
      if (error.status === 401) {
        stopRecovery();
        app.setOnline(false);
        if (!app.settingsOpen()) app.openChatSettings();
        pollDelay = Math.min(pollDelay * 2, 30000);
      } else if (error.status === 404) {
        void app.removeJoinedRoom(roomId, { reason: true });
      } else {
        app.setOnline(false);
        pollDelay = 2000;
        if (error.network || error.name === "AbortError" || error.name === "TimeoutError") scheduleRecovery();
      }
    }
  }

  app.refreshRoomMeta = async (roomId = app.state.room?.id, generation = app.state.pollGeneration) => {
    if (!roomId) return;
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (!isCurrentPoll(roomId, generation)) return;
      app.setOnline(true);
      const before = JSON.stringify([app.state.room.ownerId, app.state.room.adminIds ?? [], app.state.room.successorId ?? null, app.state.room.adminSessionID ?? null]);
      const openQuestions = Number(room.openQuestions);
      Object.assign(app.state.room, { participants: room.participants, ownerId: room.ownerId ?? app.state.room.ownerId, adminIds: room.adminIds ?? [], successorId: room.successorId ?? null, adminSessionID: room.adminSessionID ?? null, openQuestions: Number.isFinite(openQuestions) ? Math.max(0, openQuestions) : app.state.room.openQuestions });
      if (Number.isFinite(openQuestions)) app.updateQuestionBadge?.(openQuestions);
      if (JSON.stringify([app.state.room.ownerId, app.state.room.adminIds ?? [], app.state.room.successorId ?? null, app.state.room.adminSessionID ?? null]) !== before) { app.renderHead(); app.rerenderMessages(); }
      app.renderMembers();
    } catch { /* The next room event will retry. */ }
  };

  app.reconcileRoom = async (roomId, generation = app.state.pollGeneration, syncHistory = false) => {
    const entry = app.state.rooms.get(roomId);
    try {
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (!isCurrentPoll(roomId, generation)) return;
      app.setOnline(true);
      if (entry && Number.isFinite(Number(room.recallVersion))) entry.recallVersion = Number(room.recallVersion);
      const current = app.state.room.messages;
      const ids = new Set(current.map((message) => message.id));
      const missing = room.messages.filter((message) => !ids.has(message.id));
      // History carries recall state; patch rows whose live recall event was missed.
      let recalled = false;
      for (const message of room.messages) {
        if (message.recalledAt && app.applyRecall?.(roomId, { messageID: message.id, recalledAt: message.recalledAt, recalledBy: message.recalledBy })) recalled = true;
      }
      // Older loaded pages sit below this payload; hide their recalled text too.
      if (syncHistory) void app.syncLoadedHistory?.(roomId, generation);
      if (!missing.length && !recalled && !app.failedRenderIds.size) return;
      for (const message of missing) {
        const index = current.findIndex((item) => item.createdAt > message.createdAt);
        current.splice(index < 0 ? current.length : index, 0, message);
      }
      if (current.length > LOADED_MESSAGE_LIMIT) current.splice(0, current.length - LOADED_MESSAGE_LIMIT);
      const result = app.rerenderMessages();
      if (result.skipped === 0) void app.markActiveRoomRead();
    } catch { /* Try again during the next reconciliation. */ }
    finally { if (entry) entry.recallSync = false; }
  };
}
