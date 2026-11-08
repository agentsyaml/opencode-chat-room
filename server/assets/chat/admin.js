import { LS } from "./state.js";

export function initAdmin(app) {
  const $ = app.$, dialog = $("#adminDialog");
  let rooms = [], bindings = [], agents = [], taskAgents = [], viewGeneration = 0, designationGeneration = 0, taskGeneration = 0, tokenGeneration = 0;
  const status = (text, error = false) => { $("#adminStatus").textContent = text; $("#adminStatus").classList.toggle("danger-text", error); };
  const json = (body) => JSON.stringify(body);
  const select = (node, values, label, id = (item) => item.id) => {
    node.replaceChildren(new Option(label, ""), ...values.map((item) => new Option(item.name, id(item))));
  };
  function renderAdminRooms() {
    $("#adminRoomSelect").replaceChildren(new Option(app.t("chooseAdminRoom"), ""), ...rooms.map((room) => new Option(`${room.name}${bindings.some((item) => item.roomId === room.id) ? ` · ${app.t("adminRoomBadge")}` : ""}`, room.id)));
  }
  const clearEnrollment = () => { $("#adminEnrollment").replaceChildren(); $("#adminEnrollment").hidden = true; };
  async function verifyToken() {
    const generation = ++tokenGeneration, token = LS.adminToken, error = $("#adminAccessError"), button = $("#btnOpenAdmin");
    error.hidden = true; button.hidden = true;
    if (!token) return;
    try { await app.adminApi("/admin/rooms"); if (generation === tokenGeneration && token === LS.adminToken) button.hidden = false; }
    catch (failure) { if (generation === tokenGeneration) { error.textContent = failure.message; error.hidden = false; } }
  }
  async function open() {
    const generation = ++viewGeneration;
    clearEnrollment(); $("#adminOverview").replaceChildren(); $("#adminTaskList").replaceChildren(); $("#adminPlanList").replaceChildren();
    dialog.showModal(); status(app.t("adminLoading"));
    $("#adminRoomSelect").disabled = $("#adminTargetRoom").disabled = $("#adminTargetAgent").disabled = true;
    $("#adminTaskRoom").disabled = $("#adminTaskAgent").disabled = true;
    $("#btnRevokeAdmin").hidden = $("#adminTaskForm").hidden = $("#adminPlanForm").hidden = true;
    try {
      const [adminResult, roomResult] = await Promise.all([app.adminApi("/admin/rooms"), app.api(`/rooms?sessionID=${encodeURIComponent(LS.sessionID)}`)]);
      if (generation !== viewGeneration || !dialog.open) return;
      bindings = adminResult.rooms || []; rooms = roomResult || [];
      renderAdminRooms();
      $("#adminRoomSelect").value = bindings[0]?.roomId || rooms[0]?.id || "";
      select($("#adminTargetRoom"), rooms, app.t("chooseTargetRoom"), (room) => room.id);
      select($("#adminTaskRoom"), rooms, app.t("chooseTargetRoom"), (room) => room.id);
      if (rooms.length) $("#adminTargetRoom").value = rooms[0].id;
      if (rooms.length) $("#adminTaskRoom").value = rooms[0].id;
      status(rooms.length ? "" : app.t("createAdminRoomFirst"));
      await Promise.all([loadDesignationAgents(), loadTaskAgents()]); await loadBinding(generation);
    } catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { if (generation === viewGeneration) { $("#adminRoomSelect").disabled = $("#adminTargetRoom").disabled = $("#adminTargetAgent").disabled = false; $("#adminTaskRoom").disabled = $("#adminTaskAgent").disabled = false; } }
  }
  async function registryAgents(roomId) {
    return roomId ? Object.entries(await app.api(`/rooms/${encodeURIComponent(roomId)}/registry`)).map(([sessionID, value]) => ({ sessionID, ...value })).filter((agent) => agent.membershipID) : [];
  }
  async function loadDesignationAgents() {
    const generation = ++designationGeneration, roomId = $("#adminTargetRoom").value;
    agents = []; $("#adminTargetAgent").disabled = true; select($("#adminTargetAgent"), [], app.t("chooseAgent"), (agent) => agent.sessionID);
    try {
      const found = await registryAgents(roomId);
      if (generation !== designationGeneration || roomId !== $("#adminTargetRoom").value) return;
      agents = found; select($("#adminTargetAgent"), agents.map((agent) => ({ ...agent, name: `${agent.name} · ${agent.sessionID.slice(0, 8)}` })), app.t("chooseAgent"), (agent) => agent.sessionID); $("#adminTargetAgent").disabled = false;
    } catch (error) { if (generation === designationGeneration) status(error.message, true); }
  }
  async function loadTaskAgents() {
    const generation = ++taskGeneration, roomId = $("#adminTaskRoom").value;
    taskAgents = []; $("#adminTaskAgent").disabled = true; select($("#adminTaskAgent"), [], app.t("chooseAgent"), (agent) => agent.sessionID);
    try {
      const found = await registryAgents(roomId);
      if (generation !== taskGeneration || roomId !== $("#adminTaskRoom").value) return;
      taskAgents = found; select($("#adminTaskAgent"), taskAgents.map((agent) => ({ ...agent, name: `${agent.name} · ${agent.sessionID.slice(0, 8)}` })), app.t("chooseAgent"), (agent) => agent.sessionID); $("#adminTaskAgent").disabled = false;
    } catch (error) { if (generation === taskGeneration) status(error.message, true); }
  }
  async function loadBinding(generation = ++viewGeneration) {
    const id = $("#adminRoomSelect").value;
    const binding = bindings.find((item) => item.roomId === id);
    $("#adminOverview").replaceChildren(); $("#adminTaskList").replaceChildren(); $("#adminPlanList").replaceChildren();
    $("#adminTaskForm").hidden = $("#adminPlanForm").hidden = true;
    $("#btnRevokeAdmin").hidden = !binding;
    if (!id || !binding) return renderData({}, id);
    $("#adminTargetRoom").value = binding.targetRoomId;
    const targetRoomId = binding.targetRoomId;
    await loadDesignationAgents();
    if (generation !== viewGeneration || id !== $("#adminRoomSelect").value || targetRoomId !== $("#adminTargetRoom").value || !dialog.open) return;
    $("#adminTargetAgent").value = binding.sessionID;
    try {
      const base = `/admin/rooms/${encodeURIComponent(id)}`;
      const [overview, tasks, plans] = await Promise.all([app.adminApi(`${base}/overview`), app.adminApi(`${base}/tasks`), app.adminApi(`${base}/plans`)]);
      if (generation !== viewGeneration || id !== $("#adminRoomSelect").value || !dialog.open) return;
      renderData({ overview, tasks: tasks.tasks, plans: plans.plans }, id);
    } catch (error) { if (generation === viewGeneration) status(error.message, true); }
  }
  function renderData(data, id) {
    const overview = $("#adminOverview"); overview.replaceChildren();
    for (const room of data.overview?.rooms || []) {
      const item = document.createElement("p");
      item.textContent = `${room.name}: ${(room.members || []).map((member) => `${member.name} (${member.workState || "unknown"})`).join(", ") || app.t("noAgents")}`;
      overview.append(item);
    }
    const binding = bindings.find((item) => item.roomId === id);
    $("#adminTaskForm").hidden = !binding; $("#adminPlanForm").hidden = !binding;
    renderTasks(data.tasks || [], id); renderPlans(data.plans || [], id);
  }
  function renderTasks(tasks, roomId) {
    const list = $("#adminTaskList"); list.replaceChildren();
    for (const task of tasks) {
      const row = document.createElement("li"), title = document.createElement("p"), state = document.createElement("select"), progress = document.createElement("textarea"), save = document.createElement("button");
      title.textContent = task.text; state.className = "admin-select";
      for (const value of ["pending", "working", "blocked", "completed", "cancelled"]) state.add(new Option(app.t(`task_${value}`), value));
      state.value = task.status; progress.className = "input"; progress.rows = 2; progress.value = task.progress || "";
      save.className = "btn ghost small"; save.type = "button"; save.textContent = app.t("updateTask");
      save.addEventListener("click", async () => {
        const generation = viewGeneration, nextStatus = state.value, nextProgress = progress.value; save.disabled = true;
        try { await app.adminApi(`/admin/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: json({ status: nextStatus, progress: nextProgress }) }); if (generation === viewGeneration && roomId === $("#adminRoomSelect").value && state.value === nextStatus && progress.value === nextProgress) await loadBinding(); }
        catch (error) { if (generation === viewGeneration) status(error.message, true); }
        finally { save.disabled = false; }
      });
      row.append(title, state, progress, save); list.append(row);
    }
  }
  function renderPlans(plans, roomId) {
    const list = $("#adminPlanList"); list.replaceChildren();
    for (const plan of plans) {
      const row = document.createElement("li"), text = document.createElement("p"), toggle = document.createElement("button"), remove = document.createElement("button");
      text.textContent = `${plan.name} · ${app.t(plan.paused ? "paused" : "nextRun", { time: new Date(plan.nextRunAt).toLocaleString(), minutes: Math.round(plan.intervalSeconds / 60) })}`;
      toggle.className = remove.className = "btn ghost small"; toggle.type = remove.type = "button";
      toggle.textContent = app.t(plan.paused ? "resumeTimer" : "pauseTimer"); remove.textContent = app.t("deleteTimer");
      toggle.addEventListener("click", () => changePlan(roomId, plan.id, { paused: !plan.paused }, toggle));
      remove.addEventListener("click", async () => { if (confirm(app.t("deleteTimerConfirm", { name: plan.name }))) await changePlan(roomId, plan.id, null, remove); });
      row.append(text, toggle, remove); list.append(row);
    }
  }
  async function changePlan(roomId, planId, update, button) {
    const generation = viewGeneration; button.disabled = true;
    try { await app.adminApi(`/admin/rooms/${encodeURIComponent(roomId)}/plans/${encodeURIComponent(planId)}`, update ? { method: "PATCH", body: json(update) } : { method: "DELETE", body: json({}) }); if (generation === viewGeneration && roomId === $("#adminRoomSelect").value) await loadBinding(); }
    catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  }
  $("#btnSaveAdminToken").addEventListener("click", async () => { ++viewGeneration; ++designationGeneration; ++taskGeneration; clearEnrollment(); LS.adminToken = $("#inAdminToken").value.trim(); $("#inAdminToken").value = LS.adminToken; await verifyToken(); });
  $("#btnOpenAdmin").addEventListener("click", () => { app.closePanels(); void open(); });
  $("#btnRefreshAdmin").addEventListener("click", async () => {
    const id = $("#adminRoomSelect").value;
    const generation = ++viewGeneration;
    try { const result = await app.adminApi("/admin/rooms"); if (generation !== viewGeneration || !dialog.open) return; bindings = result.rooms || []; renderAdminRooms(); $("#adminRoomSelect").value = id; await loadBinding(generation); }
    catch (error) { if (generation === viewGeneration) status(error.message, true); }
  });
  $("#btnCloseAdmin").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++viewGeneration; ++designationGeneration; ++taskGeneration; clearEnrollment(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("#adminRoomSelect").addEventListener("change", () => { clearEnrollment(); void loadBinding(); });
  $("#adminTargetRoom").addEventListener("change", () => { clearEnrollment(); void loadDesignationAgents(); });
  $("#adminTargetAgent").addEventListener("change", clearEnrollment);
  $("#adminTaskRoom").addEventListener("change", () => void loadTaskAgents());
  $("#btnDesignateAgent").addEventListener("click", async () => {
    const roomId = $("#adminRoomSelect").value, agent = agents.find((item) => item.sessionID === $("#adminTargetAgent").value);
    if (!roomId || !agent || !agent.membershipID) return status(app.t("selectAdminAgent"), true);
    const body = { targetRoomId: $("#adminTargetRoom").value, sessionID: agent.sessionID, receiverOwnerID: agent.receiverOwnerID || "", membershipID: agent.membershipID };
    const generation = viewGeneration, button = $("#btnDesignateAgent"); button.disabled = true;
    try {
      const existing = bindings.some((item) => item.roomId === roomId);
      const result = await app.adminApi(existing ? `/admin/rooms/${encodeURIComponent(roomId)}` : "/admin/rooms", { method: existing ? "PUT" : "POST", body: json(existing ? body : { roomId, ...body }) });
      if (generation !== viewGeneration || !dialog.open || roomId !== $("#adminRoomSelect").value || body.targetRoomId !== $("#adminTargetRoom").value || agent.sessionID !== $("#adminTargetAgent").value) return;
       if (!existing) bindings.push(result.adminRoom); else bindings = bindings.map((item) => item.roomId === roomId ? result.adminRoom : item);
       renderAdminRooms(); $("#adminRoomSelect").value = roomId;
       await loadBinding(generation);
       if (generation !== viewGeneration || roomId !== $("#adminRoomSelect").value || body.targetRoomId !== $("#adminTargetRoom").value) return;
       const box = $("#adminEnrollment"), instruction = document.createElement("code"), copy = document.createElement("button"), warning = document.createElement("p");
      instruction.textContent = `admin(action='admin_claim',roomId='${roomId}',enrollmentKey='${result.enrollmentKey}')`;
      warning.textContent = app.t("privateEnrollment", { expires: new Date(result.expiresAt).toLocaleString() });
      copy.className = "btn ghost small"; copy.type = "button"; copy.textContent = app.t("copyEnrollment");
       copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(instruction.textContent); status(app.t("enrollmentCopied")); } catch (error) { status(error.message, true); } });
       box.replaceChildren(warning, instruction, copy); box.hidden = false; $("#btnRevokeAdmin").hidden = false; status("");
    } catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#btnRevokeAdmin").addEventListener("click", async () => {
    const id = $("#adminRoomSelect").value;
    if (!id || !confirm(app.t("revokeConfirm"))) return;
    const generation = viewGeneration, button = $("#btnRevokeAdmin"); button.disabled = true;
    try { await app.adminApi(`/admin/rooms/${encodeURIComponent(id)}`, { method: "DELETE", body: json({}) }); if (generation !== viewGeneration || id !== $("#adminRoomSelect").value) return; bindings = bindings.filter((item) => item.roomId !== id); renderAdminRooms(); $("#adminRoomSelect").value = id; clearEnrollment(); await loadBinding(generation); }
    catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#adminTaskForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const roomId = $("#adminRoomSelect").value, binding = bindings.find((item) => item.roomId === roomId), targetRoomId = $("#adminTaskRoom").value, targetSessionID = $("#adminTaskAgent").value, target = taskAgents.find((item) => item.sessionID === targetSessionID && item.membershipID), input = $("#adminTaskText"), text = input.value, button = $("#adminTaskForm button[type=submit]");
    if (!binding) return status(app.t("selectAdminAgent"), true);
    if (!target || !text.trim()) return status(app.t("chooseAgent"), true);
    const generation = viewGeneration; button.disabled = true;
    try {
      await app.adminApi(`/admin/rooms/${encodeURIComponent(roomId)}/tasks`, { method: "POST", body: json({ targetRoomId, targetSessionID, text }) });
      if (generation !== viewGeneration || !dialog.open || roomId !== $("#adminRoomSelect").value) return;
      if (input.value === text && targetRoomId === $("#adminTaskRoom").value && targetSessionID === $("#adminTaskAgent").value) input.value = "";
      await loadBinding(generation);
    } catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#adminPlanForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const roomId = $("#adminRoomSelect").value, generation = viewGeneration, form = $("#adminPlanForm"), button = form.querySelector("button[type=submit]"), name = $("#adminPlanName").value, interval = $("#adminPlanInterval").value, text = $("#adminPlanText").value; button.disabled = true;
    try { await app.adminApi(`/admin/rooms/${encodeURIComponent(roomId)}/plans`, { method: "POST", body: json({ name, intervalSeconds: Number(interval), text }) }); if (generation !== viewGeneration || roomId !== $("#adminRoomSelect").value || !dialog.open) return; if ($("#adminPlanName").value === name && $("#adminPlanInterval").value === interval && $("#adminPlanText").value === text) { form.reset(); $("#adminPlanInterval").value = "3600"; } await loadBinding(generation); }
    catch (error) { if (generation === viewGeneration) status(error.message, true); }
    finally { button.disabled = false; }
  });
  $("#inAdminToken").value = LS.adminToken;
  void verifyToken();
}
