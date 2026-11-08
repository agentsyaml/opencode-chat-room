import { LS } from "./state.js";

export function initMembers(app) {
  const $ = app.$;

  app.mentionNames = () => {
    const room = app.state.room, members = room && app.state.memberSessions.get(room.id);
    return new Set((members || room?.participants || [])
      .filter((person) => members ? person.sessionID !== LS.sessionID : person.name !== app.state.myName)
      .map((person) => person.name));
  };

  app.renderMembers = () => {
    const people = app.state.room?.participants || [];
    app.setText($("#btnMembers"), "membersCount", { count: people.length });
    const list = $("#memberList");
    list.textContent = "";
    for (const person of people) {
      const row = document.createElement("li"), name = document.createElement("span"), time = document.createElement("span");
      name.textContent = person.name;
      time.className = "m-time";
      time.textContent = app.fmtTime(person.joinedAt);
      row.append(name, time);
      list.append(row);
    }
    $("#memberEmpty").hidden = people.length > 0;
    if (app.mentionActive) app.updateMentionList();
    void app.loadManageableMembers();
  };

  app.loadManageableMembers = async () => {
    const room = app.state.room;
    if (!room || app.state.memberApiUnavailable.has(room.id)) return;
    const generation = app.state.pollGeneration;
    clearTimeout(app.state.memberRefreshTimer);
    try {
      const members = await app.api(`/rooms/${encodeURIComponent(room.id)}/members`);
      if (!current(app, room.id, generation)) return;
      const previous = app.state.memberSessions.get(room.id) || [];
      const signature = (items) => items.map((member) => `${member.sessionID}\0${member.name}\0${member.type}`).sort().join("\u0001");
      const changed = signature(previous) !== signature(members);
      app.state.memberSessions.set(room.id, members);
      if (changed && app.mentionActive) app.updateMentionList();
      if (changed && room.kind !== "direct" && room.messages.some((message) => !message.senderSessionID && message.senderId === app.state.myName)) app.rerenderMessages();
      const list = $("#memberList");
      const rows = Array.from(list.querySelectorAll("li[data-member-session-id]"));
      if (signature(rows.map((row) => ({ sessionID: row.dataset.memberSessionId, name: row.dataset.memberName, type: row.dataset.memberType }))) !== signature(members)) {
        list.textContent = "";
        for (const member of members) {
          const row = document.createElement("li"), name = document.createElement("span"), actions = document.createElement("span");
          row.dataset.memberSessionId = member.sessionID; row.dataset.memberName = member.name; row.dataset.memberType = member.type;
          name.textContent = member.name; row.append(name);
          if (member.type === "agent") row.append(activityBadge(member, app));
          actions.className = "member-actions";
          if (member.sessionID !== LS.sessionID) {
            actions.append(actionButton(member, "messagePrivately", app.startDirect));
            if (room.kind !== "direct") actions.append(actionButton(member, "removeMember", app.kickMember));
          }
          row.append(actions); list.append(row);
        }
      } else for (const member of members) updateActivity(list.querySelector(`[data-member-session-id="${CSS.escape(member.sessionID)}"]`), member, app);
      $("#memberEmpty").hidden = members.length > 0;
      app.queueReceiptObservation();
      app.state.memberRefreshTimer = setTimeout(() => {
        if (current(app, room.id, generation) && !document.hidden) void app.loadManageableMembers();
      }, 5000);
    } catch (error) {
      if (error.status === 401) app.openChatSettings();
      else if (error.status === 404) app.state.memberApiUnavailable.add(room.id);
      else if (current(app, room.id, generation) && !document.hidden) app.state.memberRefreshTimer = setTimeout(() => void app.loadManageableMembers(), 5000);
    }
  };

  app.loadVisibleReceipts = async (roomId, generation = app.state.pollGeneration) => {
    if (app.state.receiptApiUnavailable.has(roomId) || !current(app, roomId, generation)) return;
    const ids = visibleMessageIDs(app);
    if (!ids.length) return;
    const query = new URLSearchParams({ messageIDs: ids.join(",") });
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/receipts?${query}`);
      if (!current(app, roomId, generation)) return;
      app.renderReceiptData(roomId, result.receipts || []);
    } catch (error) {
      if (error.status === 404) app.state.receiptApiUnavailable.add(roomId);
    }
  };
  app.queueReceiptRefresh = () => {
    clearTimeout(app.state.receiptRefreshTimer);
    const roomId = app.state.room?.id, generation = app.state.pollGeneration;
    app.state.receiptRefreshTimer = setTimeout(() => void app.loadVisibleReceipts(roomId, generation), 180);
  };
  app.queueReceiptObservation = () => {
    if ((app.state.resizeScrollAdjusting || app.state.layoutScrollAdjusting)
        && performance.now() > app.state.userScrollIntentUntil) return;
    app.state.receiptObservation = { roomId: app.state.room?.id, generation: app.state.pollGeneration };
    if (app.state.receiptObservationFrame) return;
    app.state.receiptObservationFrame = requestAnimationFrame(() => {
      app.state.receiptObservationFrame = 0;
      const target = app.state.receiptObservation;
      app.state.receiptObservation = null;
      if (!target || (app.state.resizeScrollAdjusting || app.state.layoutScrollAdjusting)
          && performance.now() > app.state.userScrollIntentUntil || document.hidden || !document.hasFocus() || !current(app, target.roomId, target.generation)) return;
      void app.loadVisibleReceipts(target.roomId, target.generation);
      void app.ackVisibleMessages(target.roomId, target.generation);
    });
  };
  app.ackVisibleMessages = async (roomId = app.state.room?.id, generation = app.state.pollGeneration) => {
    const room = app.state.room;
    if (!room || room.id !== roomId || app.state.pollGeneration !== generation || app.state.receiptApiUnavailable.has(room.id)) return;
    const self = app.state.memberSessions.get(room.id)?.find((member) => member.sessionID === LS.sessionID);
    if (self?.type !== "human" || !self.membershipID) return;
    const key = `${room.id}\0${self.membershipID}`;
    const acknowledged = app.state.acknowledgedMessages.get(key) || new Set();
    const pending = app.state.pendingAcknowledgements.get(key) || new Set();
    const ids = visibleMessageIDs(app).filter((id) => !acknowledged.has(id) && !pending.has(id));
    if (!ids.length) return;
    app.state.pendingAcknowledgements.set(key, pending);
    ids.forEach((id) => pending.add(id));
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(room.id)}/receipts`, { method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, membershipID: self.membershipID, messageIDs: ids, evidence: "displayed" }) });
      if (current(app, room.id, generation) && app.state.memberSessions.get(room.id)?.some((member) => member.sessionID === LS.sessionID && member.membershipID === self.membershipID)) {
        acknowledgedMessages(app, key, acknowledged, result.acceptedIDs || []);
      }
    } catch (error) { if (error.status === 404) app.state.receiptApiUnavailable.add(room.id); }
    finally { ids.forEach((id) => pending.delete(id)); }
  };

  app.startDirect = async (member) => {
    const source = app.state.room;
    if (!source) return;
    const name = app.state.myName, intent = ++app.state.navigationGeneration;
    try {
      const room = await app.api("/direct", {
        method: "POST",
        body: JSON.stringify({ roomId: source.id, sessionID: LS.sessionID, targetSessionID: member.sessionID }),
      });
      app.enterRoom(room, name, intent);
    } catch (error) { app.showSendError("sendFailed", { message: error.message }); }
  };

  app.kickMember = async (member) => {
    const id = member.sessionID.slice(0, 8);
    if (!confirm(app.t("kickConfirm", { name: member.name, id }))) return;
    try {
      await app.api(`/rooms/${encodeURIComponent(app.state.room.id)}/kick`, {
        method: "POST",
        body: JSON.stringify({ sessionID: LS.sessionID, targetSessionID: member.sessionID }),
      });
      await app.refreshRoomMeta();
    } catch (error) { app.showSendError("sendFailed", { message: error.message }); }
  };

  function actionButton(member, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "member-action";
    button.textContent = app.t(label);
    button.addEventListener("click", () => action(member));
    return button;
  }
}

function current(app, roomId, generation) {
  return app.state.room?.id === roomId && app.state.pollGeneration === generation && !app.$("#chatView").hidden;
}

function visibleMessageIDs(app) {
  const thread = app.$("#thread");
  if (document.hidden || !document.hasFocus() || app.$("#chatView").hidden) return [];
  const top = thread.getBoundingClientRect().top + thread.clientTop, bottom = top + thread.clientHeight;
  const overlays = Array.from(document.querySelectorAll(".panel:not([hidden]), #mentionPicker:not([hidden]), #railRoomForm:not([hidden])"))
    .map((node) => node.getBoundingClientRect());
  return Array.from(thread.querySelectorAll("[data-msg-id]")).filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > top && rect.top < bottom && !overlays.some((overlay) => rect.left < overlay.right && rect.right > overlay.left && rect.top < overlay.bottom && rect.bottom > overlay.top);
  }).map((row) => row.dataset.msgId).filter(Boolean);
}

function acknowledgedMessages(app, key, set, ids) {
  ids.forEach((id) => set.add(id));
  app.state.acknowledgedMessages.set(key, set);
}

function activityBadge(member, app) {
  const badge = document.createElement("span");
  updateActivityBadge(badge, member, app);
  return badge;
}

function updateActivity(row, member, app) {
  if (!row) return;
  let badge = row.querySelector(".member-activity");
  if (member.type !== "agent") { badge?.remove(); return; }
  if (!badge) { badge = activityBadge(member, app); row.insertBefore(badge, row.querySelector(".member-actions")); }
  updateActivityBadge(badge, member, app);
}

function updateActivityBadge(badge, member, app) {
  const state = member.activity?.state || "unknown";
  badge.className = `member-activity ${state}`;
  badge.textContent = app.t(`activity_${state}`);
  badge.title = app.t(`activityHint_${state}`);
  badge.setAttribute("aria-label", `${badge.textContent}. ${badge.title}`);
}
