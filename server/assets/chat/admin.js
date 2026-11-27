import { LS } from "./state.js";
import { isRoomAdmin } from "./admin-badge.js";

// Owners and delegated humans manage settings; the agent designation comes from
// the room payload and room owners manage it here instead of an operator token.
export function initAdmin(app) {
  const $ = app.$, dialog = $("#editRoomDialog");
  let agents = [], people = [], generation = 0, agentsReady = false, rosterReady = false, opener = null;
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];

  // One tab stop for the visible tabs; arrow keys move selection like a native tab widget.
  const activateTab = (name, { focus = false } = {}) => {
    for (const tab of tabs) {
      const selected = tab.dataset.editRoomTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
      if (selected && focus) tab.focus();
    }
  };
  const onTabKey = (event) => {
    const items = tabs.filter((tab) => !tab.hidden), index = items.indexOf(event.target);
    if (index < 0) return;
    const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : step ? (index + step + items.length) % items.length : -1;
    if (target < 0) return;
    event.preventDefault();
    activateTab(items[target].dataset.editRoomTab, { focus: true });
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.editRoomTab));
    tab.addEventListener("keydown", onTabKey);
  }

  // Only people can own a room: agents carry a protocol, a host, or a receiver binding.
  const isPerson = (entry) => Boolean(entry?.name) && !entry.protocol && !entry.host && !entry.receiverOwnerID;
  function renderOwnerOptions(room) {
    const select = $("#editRoomOwner");
    const names = [...new Set(people.map((person) => person.name))];
    if (room.ownerId && !names.includes(room.ownerId)) names.unshift(room.ownerId);
    select.replaceChildren(...names.map((name) => new Option(name, name)));
    select.value = room.ownerId || names[0] || "";
  }

  function renderAdminIds(room) {
    const list = $("#editRoomAdminIds"), chosen = new Set(room.adminIds ?? []);
    const names = [...new Set(people.map((person) => person.name))].filter((name) => name !== room.ownerId);
    list.replaceChildren();
    for (const name of names) {
      const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
      label.className = "admin-check"; input.type = "checkbox"; input.value = name; input.checked = chosen.has(name); text.textContent = name;
      label.append(input, text); list.append(label);
    }
    $("#editRoomAdminIdsEmpty").hidden = names.length > 0;
  }

  function renderSuccessorOptions(room) {
    const select = $("#editRoomSuccessor");
    const names = [...new Set(people.map((person) => person.name))].filter((name) => name !== room.ownerId);
    select.replaceChildren(new Option(app.t("successorNone"), ""), ...names.map((name) => new Option(name, name)));
    select.value = names.includes(room.successorId) ? room.successorId : "";
  }

  async function loadAgents(gen) {
    const room = app.state.room; if (!room) return;
    const select = $("#editRoomAdmin");
    select.replaceChildren(new Option(app.t("noAdminAgent"), ""));
    agentsReady = false;
    try {
      const registry = await app.api(`/rooms/${encodeURIComponent(room.id)}/registry`);
      if (gen !== generation || !dialog.open) return;
      agents = Object.entries(registry).map(([sessionID, value]) => ({ sessionID, ...value }))
        .filter((agent) => agent.membershipID && (agent.protocol === "v1" || agent.protocol === "v2" || agent.receiverOwnerID || agent.host));
      for (const agent of agents) select.append(new Option(agent.name, agent.sessionID));
      select.value = agents.some((agent) => agent.sessionID === room.adminSessionID) ? room.adminSessionID : "";
      people = Object.values(registry).filter(isPerson);
      renderOwnerOptions(room);
      renderAdminIds(room);
      renderSuccessorOptions(room);
      agentsReady = true; rosterReady = true;
    } catch (error) { if (gen === generation) $("#editRoomStatus").textContent = error.message; }
  }

  function open() {
    const room = app.state.room; if (!room) return;
    $("#editRoomName").value = room.name;
    $("#editRoomDescription").value = room.description || "";
    $("#editRoomJoinPolicy").checked = room.joinPolicy === "approval";
    $("#editRoomStatus").textContent = "";
    people = []; agentsReady = false; rosterReady = false;
    renderOwnerOptions(room);
    renderAdminIds(room);
    $("#editRoomAdminIdsEmpty").hidden = true;
    renderSuccessorOptions(room);
    const owner = isOwner();
    // The Ownership tab only exists for the owner; its fields stay in the form for everyone.
    dialog.dataset.owner = owner ? "true" : "false";
    $("#editRoomTabOwnership").hidden = !owner;
    $("#editRoomOwnerOnly").hidden = !owner;
    $("#editRoomOwnerOnlyNote").hidden = owner;
    activateTab("details");
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active.getClientRects().length ? active : $("#btnRoomOptions");
    dialog.showModal();
    $("#editRoomName").focus();
    void loadAgents(++generation);
  }

  const isOwner = () => Boolean(app.state.room) && app.state.myName === app.state.room.ownerId;

  const ownerDialog = $("#ownerOnlyDialog");
  // The entry never disappears: a member who is neither owner nor admin gets a plain explanation.
  function showOwnerOnly() {
    app.setText($("#ownerOnlyNote"), "roomOwnerOnlyNote", { owner: app.state.room?.ownerId || "" });
    ownerDialog.showModal();
  }
  $("#btnEditRoom").addEventListener("click", () => {
    app.closePanels();
    if (isRoomAdmin(app)) open();
    else showOwnerOnly();
  });
  $("#btnCloseOwnerOnly").addEventListener("click", () => ownerDialog.close());
  $("#btnOwnerOnlyOk").addEventListener("click", () => ownerDialog.close());
  $("#btnCloseEditRoom").addEventListener("click", () => dialog.close());
  $("#btnCancelEditRoom").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const target = opener;
    opener = null;
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
  });
  $("#editRoomForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const room = app.state.room; if (!room) return;
    const name = $("#editRoomName").value.trim();
    if (!name) { $("#editRoomStatus").textContent = app.t("roomNameRequired"); return; }
    // Until the registry loads, empty rosters are placeholders, not revocations.
    const owner = isOwner(), nextOwner = $("#editRoomOwner").value;
    const checkedAdmins = [...$("#editRoomAdminIds").querySelectorAll("input:checked")].map((input) => input.value);
    const joinPolicy = $("#editRoomJoinPolicy").checked ? "approval" : "open";
    if (joinPolicy !== (room.joinPolicy ?? "open") && joinPolicy === "open" && !(await app.confirmAction(app.t("joinPolicyOpenConfirm")))) return;
    const body = {
      sessionID: LS.sessionID, name, description: $("#editRoomDescription").value.trim(),
      ...(joinPolicy !== (room.joinPolicy ?? "open") ? { joinPolicy } : {}),
      ...(owner && agentsReady ? { adminSessionID: $("#editRoomAdmin").value || null } : {}),
      ...(owner && nextOwner && nextOwner !== room.ownerId ? { ownerId: nextOwner } : {}),
      ...(rosterReady ? { adminIds: checkedAdmins, successorId: $("#editRoomSuccessor").value || null } : {}),
    };
    const button = event.submitter; if (button) button.disabled = true;
    try {
      const updated = await app.api(`/rooms/${encodeURIComponent(room.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      const meta = { name: updated.name, description: updated.description, joinPolicy: updated.joinPolicy ?? "open", adminSessionID: updated.adminSessionID, ownerId: updated.ownerId, adminIds: updated.adminIds ?? [], successorId: updated.successorId ?? null, openQuestions: updated.openQuestions };
      const entry = app.state.rooms.get(room.id);
      if (entry) { Object.assign(entry.room, meta); app.state.room = entry.room; }
      const listed = app.state.availableRooms?.find((item) => item.id === room.id);
      if (listed) Object.assign(listed, meta);
      app.renderHead();
      app.renderMembers();
      app.rerenderMessages();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      if ((updated.joinPolicy ?? "open") === "approval") void app.refreshJoinRequests?.();
      else app.clearJoinRequests?.();
      app.cacheRoomSoon?.(room.id);
      dialog.close();
    } catch (error) { $("#editRoomStatus").textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
}