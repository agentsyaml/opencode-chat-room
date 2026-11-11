import { LS } from "./state.js";

export function initAdmin(app) {
  const $ = app.$, dialog = $("#adminDialog");
  let rooms = [], bindings = [], agents = [], viewGeneration = 0, designationGeneration = 0, tokenGeneration = 0;
  const status = (text, error = false) => { $("#adminStatus").textContent = text; $("#adminStatus").classList.toggle("danger-text", error); };
  const json = (body) => JSON.stringify(body);
  const select = (node, values, label, id = (item) => item.id) => {
    node.replaceChildren(new Option(label, ""), ...values.map((item) => new Option(item.name, id(item))));
  };
  app.state.adminRoomIds = new Set();
  const renderRoomOptions = app.renderRoomOptions;
  app.renderRoomOptions = (list, available) => {
    renderRoomOptions(list, available);
    for (const button of list?.querySelectorAll(".room-row[data-room-id]") || []) {
      if (!app.state.adminRoomIds.has(button.dataset.roomId)) continue;
      const badge = document.createElement("span"); badge.className = "room-admin-badge"; badge.textContent = app.t("adminRoomBadge");
      button.querySelector(".r-name")?.after(badge);
    }
  };
  const renderHead = app.renderHead;
  app.renderHead = () => {
    renderHead();
    const badge = $("#activeAdminBadge");
    if (badge) badge.hidden = !app.state.adminRoomIds.has(app.state.room?.id);
  };
  function setAdminRooms(items) {
    app.state.adminRoomIds = new Set(items.map((item) => item.roomId));
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    if (app.state.room) app.renderHead();
  }
  function renderAdminRooms() {
    $("#adminRoomSelect").replaceChildren(new Option(app.t("chooseAdminRoom"), ""), ...rooms.map((room) => new Option(`${room.name}${bindings.some((item) => item.roomId === room.id) ? ` · ${app.t("adminRoomBadge")}` : ""}`, room.id)));
  }
  const clearEnrollment = () => { $("#adminEnrollment").replaceChildren(); $("#adminEnrollment").hidden = true; };
  async function verifyToken() {
    const generation = ++tokenGeneration, token = LS.adminToken, error = $("#adminAccessError"), button = $("#btnOpenAdmin");
    error.hidden = true; button.hidden = true;
    if (!token) { setAdminRooms([]); return; }
    try {
      const result = await app.adminApi("/admin/rooms");
      if (generation !== tokenGeneration || token !== LS.adminToken) return;
      setAdminRooms(result.rooms || []); button.hidden = false;
    } catch (failure) {
      if (generation === tokenGeneration && token === LS.adminToken) { setAdminRooms([]); error.textContent = failure.message; error.hidden = false; }
    }
  }
  async function open() {
    const generation = ++viewGeneration;
    clearEnrollment();
    dialog.showModal(); status(app.t("adminLoading"));
    $("#adminRoomSelect").disabled = $("#adminTargetAgent").disabled = $("#btnDesignateAgent").disabled = true; $("#btnRevokeAdmin").hidden = true;
    try {
      const [adminResult, roomResult] = await Promise.all([app.adminApi("/admin/rooms"), app.api(`/rooms?sessionID=${encodeURIComponent(LS.sessionID)}`)]);
      if (generation !== viewGeneration || !dialog.open) return;
      bindings = adminResult.rooms || []; setAdminRooms(bindings); rooms = roomResult || [];
      renderAdminRooms();
      $("#adminRoomSelect").value = bindings[0]?.roomId || rooms[0]?.id || "";
      status(""); await loadBinding(generation);
    } catch (error) { if (generation === viewGeneration) { setAdminRooms([]); status(error.message, true); } }
    finally { if (generation === viewGeneration) { $("#adminRoomSelect").disabled = $("#adminTargetAgent").disabled = false; } }
  }
  async function registryAgents(roomId) {
    return roomId ? Object.entries(await app.api(`/rooms/${encodeURIComponent(roomId)}/registry`)).map(([sessionID, value]) => ({ sessionID, ...value })).filter((agent) => agent.membershipID && (agent.protocol === "v1" || agent.protocol === "v2" || agent.receiverOwnerID || agent.host)) : [];
  }
  async function loadDesignationAgents() {
    const generation = ++designationGeneration, roomId = $("#adminRoomSelect").value;
    agents = []; $("#adminTargetAgent").disabled = $("#btnDesignateAgent").disabled = true; select($("#adminTargetAgent"), [], app.t("chooseAgent"), (agent) => agent.sessionID);
    try {
      const found = await registryAgents(roomId);
      if (generation !== designationGeneration || roomId !== $("#adminRoomSelect").value) return;
      agents = found; select($("#adminTargetAgent"), agents, app.t("chooseAgent"), (agent) => agent.sessionID); $("#adminTargetAgent").disabled = false;
    } catch (error) { if (generation === designationGeneration) { status(error.message, true); $("#btnDesignateAgent").disabled = true; } }
  }
  async function loadBinding(generation = ++viewGeneration) {
    const id = $("#adminRoomSelect").value;
    const binding = bindings.find((item) => item.roomId === id);
    $("#btnRevokeAdmin").hidden = !binding;
    if (!id) { agents = []; $("#btnDesignateAgent").disabled = true; status(app.t("createAdminRoomFirst")); select($("#adminTargetAgent"), [], app.t("chooseAgent"), (agent) => agent.sessionID); return; }
    await loadDesignationAgents();
    if (generation !== viewGeneration || id !== $("#adminRoomSelect").value || !dialog.open) return;
    if (binding) $("#adminTargetAgent").value = binding.sessionID;
    $("#btnDesignateAgent").disabled = !agents.some((agent) => agent.sessionID === $("#adminTargetAgent").value);
    if (!agents.length) status(app.t("noAgents")); else status("");
  }
  $("#btnSaveAdminToken").addEventListener("click", async () => { ++viewGeneration; ++designationGeneration; clearEnrollment(); setAdminRooms([]); LS.adminToken = $("#inAdminToken").value.trim(); $("#inAdminToken").value = LS.adminToken; await verifyToken(); });
  app.verifyAdminToken = verifyToken;
  $("#btnOpenAdmin").addEventListener("click", () => { app.closePanels(); void open(); });
  $("#btnRefreshAdmin").addEventListener("click", async () => {
    const id = $("#adminRoomSelect").value;
    const generation = ++viewGeneration;
    try { const [result, roomResult] = await Promise.all([app.adminApi("/admin/rooms"), app.api(`/rooms?sessionID=${encodeURIComponent(LS.sessionID)}`)]); if (generation !== viewGeneration || !dialog.open) return; bindings = result.rooms || []; rooms = roomResult || []; setAdminRooms(bindings); renderAdminRooms(); $("#adminRoomSelect").value = id; await loadBinding(generation); }
    catch (error) { if (generation === viewGeneration) { setAdminRooms([]); status(error.message, true); } }
  });
  $("#btnCloseAdmin").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++viewGeneration; ++designationGeneration; clearEnrollment(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("#adminRoomSelect").addEventListener("change", () => { clearEnrollment(); void loadBinding(); });
  $("#adminTargetAgent").addEventListener("change", () => { clearEnrollment(); $("#btnDesignateAgent").disabled = !agents.some((agent) => agent.sessionID === $("#adminTargetAgent").value); });
  $("#btnDesignateAgent").addEventListener("click", async () => {
    const roomId = $("#adminRoomSelect").value, agent = agents.find((item) => item.sessionID === $("#adminTargetAgent").value);
    if (!roomId || !agent || !agent.membershipID) return status(app.t("selectAdminAgent"), true);
    const body = { targetRoomId: roomId, sessionID: agent.sessionID, receiverOwnerID: agent.receiverOwnerID || "", membershipID: agent.membershipID };
    const generation = viewGeneration, button = $("#btnDesignateAgent"); button.disabled = true;
    try {
      const existing = bindings.some((item) => item.roomId === roomId);
      const result = await app.adminApi(existing ? `/admin/rooms/${encodeURIComponent(roomId)}` : "/admin/rooms", { method: existing ? "PUT" : "POST", body: json(existing ? body : { roomId, ...body }) });
      if (generation !== viewGeneration || !dialog.open || roomId !== $("#adminRoomSelect").value || agent.sessionID !== $("#adminTargetAgent").value) return;
      if (!existing) bindings.push(result.adminRoom); else bindings = bindings.map((item) => item.roomId === roomId ? result.adminRoom : item);
      setAdminRooms(bindings); renderAdminRooms(); $("#adminRoomSelect").value = roomId;
      await loadBinding(generation);
      if (generation !== viewGeneration || roomId !== $("#adminRoomSelect").value) return;
      const box = $("#adminEnrollment"), note = document.createElement("p");
      note.textContent = app.t("adminDesignated");
      box.replaceChildren(note); box.hidden = false; $("#btnRevokeAdmin").hidden = false; status("");
    } catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#btnRevokeAdmin").addEventListener("click", async () => {
    const id = $("#adminRoomSelect").value;
    if (!id || !confirm(app.t("revokeConfirm"))) return;
    const generation = viewGeneration, button = $("#btnRevokeAdmin"); button.disabled = true;
    try { await app.adminApi(`/admin/rooms/${encodeURIComponent(id)}`, { method: "DELETE", body: json({}) }); if (generation !== viewGeneration || id !== $("#adminRoomSelect").value) return; bindings = bindings.filter((item) => item.roomId !== id); setAdminRooms(bindings); renderAdminRooms(); $("#adminRoomSelect").value = id; clearEnrollment(); await loadBinding(generation); }
    catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#inAdminToken").value = LS.adminToken;
  void verifyToken();
}
