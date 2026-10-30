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
    if (!room) return;
    try {
      const members = await app.api(`/rooms/${encodeURIComponent(room.id)}/members`);
      if (app.state.room?.id !== room.id) return;
      const previous = app.state.memberSessions.get(room.id) || [];
      const signature = (items) => items.map((member) => `${member.sessionID}\0${member.name}`).sort().join("\u0001");
      const changed = signature(previous) !== signature(members);
      app.state.memberSessions.set(room.id, members);
      if (changed && app.mentionActive) app.updateMentionList();
      if (changed && room.kind !== "direct" && room.messages.some((message) => !message.senderSessionID && message.senderId === app.state.myName)) app.rerenderMessages();
      const list = $("#memberList");
      list.textContent = "";
      for (const member of members) {
        const row = document.createElement("li"), name = document.createElement("span"), actions = document.createElement("span");
        name.textContent = member.name;
        actions.className = "member-actions";
        if (member.sessionID !== LS.sessionID) {
          actions.append(actionButton(member, "messagePrivately", app.startDirect));
          if (room.kind !== "direct") actions.append(actionButton(member, "removeMember", app.kickMember));
        }
        row.append(name, actions);
        list.append(row);
      }
      $("#memberEmpty").hidden = members.length > 0;
    } catch (error) {
      if (error.status === 401) app.openChatSettings();
    }
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
