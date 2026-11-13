import { LS } from "./state.js";

// Admin badges come from the room payload (adminSessionID); room owners manage
// the designation through the edit-room dialog instead of an operator token.
export function initAdmin(app) {
  const $ = app.$, dialog = $("#editRoomDialog");
  let agents = [], generation = 0, agentsReady = false;

  const renderRoomOptions = app.renderRoomOptions;
  app.renderRoomOptions = (list, available) => {
    renderRoomOptions(list, available);
    const byId = new Map((available || []).map((room) => [room.id, room]));
    for (const button of list?.querySelectorAll(".room-row[data-room-id]") || []) {
      const room = app.state.rooms.get(button.dataset.roomId)?.room || byId.get(button.dataset.roomId);
      if (!room?.adminSessionID) continue;
      const badge = document.createElement("span"); badge.className = "room-admin-badge"; badge.textContent = app.t("adminRoomBadge");
      button.querySelector(".r-name")?.after(badge);
    }
  };
  const renderHead = app.renderHead;
  app.renderHead = () => {
    renderHead();
    const badge = $("#activeAdminBadge");
    if (badge) badge.hidden = !app.state.room?.adminSessionID;
  };

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
      agentsReady = true;
    } catch (error) { if (gen === generation) $("#editRoomStatus").textContent = error.message; }
  }

  function open() {
    const room = app.state.room; if (!room) return;
    $("#editRoomName").value = room.name;
    $("#editRoomDescription").value = room.description || "";
    $("#editRoomStatus").textContent = "";
    dialog.showModal();
    void loadAgents(++generation);
  }

  $("#btnEditRoom").addEventListener("click", () => { app.closePanels(); open(); });
  $("#btnCloseEditRoom").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("#editRoomForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const room = app.state.room; if (!room) return;
    const name = $("#editRoomName").value.trim();
    if (!name) { $("#editRoomStatus").textContent = app.t("roomNameRequired"); return; }
    // Until the agent list loads, "None" is a placeholder, not a revocation.
    const body = { sessionID: LS.sessionID, name, description: $("#editRoomDescription").value.trim(), ...(agentsReady ? { adminSessionID: $("#editRoomAdmin").value || null } : {}) };
    const button = event.submitter; if (button) button.disabled = true;
    try {
      const updated = await app.api(`/rooms/${encodeURIComponent(room.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      const meta = { name: updated.name, description: updated.description, adminSessionID: updated.adminSessionID, openQuestions: updated.openQuestions };
      const entry = app.state.rooms.get(room.id);
      if (entry) { Object.assign(entry.room, meta); app.state.room = entry.room; }
      const listed = app.state.availableRooms?.find((item) => item.id === room.id);
      if (listed) Object.assign(listed, meta);
      app.renderHead();
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
      app.cacheRoomSoon?.(room.id);
      dialog.close();
    } catch (error) { $("#editRoomStatus").textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
}