import { LS } from "./state.js";

export function initReminders(app) {
  const $ = app.$, panel = $("#reminderPanel"), trigger = $("#btnReminders"), list = $("#reminderList");
  app.setText($("#reminderTemplateHint"), "reminderTemplateHint", { time: "{time}", initiator: "{initiator}", room: "{room}" });
  let reminders = [], generation = 0, roomGeneration = 0, activeRoomId;
  const drafts = new Map();
  const roomId = () => app.state.room?.id;
  const status = (text) => { $("#reminderStatus").textContent = text; };
  const current = (id, context) => roomId() === id && roomGeneration === context;
  const invalidateLoads = () => { generation++; };
  const errorText = (error) => error?.message || app.t("requestFailed", { status: error?.status || "?" });
  function formDraft() {
    return { type: $("#reminderType").value, at: $("#reminderAt").value, cron: $("#reminderCron").value, timezone: $("#reminderTimezone").value, text: $("#reminderText").value };
  }
  function restoreDraft(draft) {
    $("#reminderType").value = draft?.type || "once"; $("#reminderAt").value = draft?.at || "";
    $("#reminderCron").value = draft?.cron || ""; $("#reminderTimezone").value = draft?.timezone || "";
    $("#reminderText").value = draft?.text || ""; $("#reminderType").dispatchEvent(new Event("change"));
  }
  function formatTime(value, timezone) {
    const effectiveZone = timezone || "UTC";
    const formatted = new Intl.DateTimeFormat(undefined, { timeZone: effectiveZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    return `${formatted} · ${effectiveZone}`;
  }
  function render() {
    list.textContent = "";
    if (!reminders.length) { status(app.t("reminderEmpty")); return; }
    status("");
    for (const reminder of reminders) {
      const row = document.createElement("li"), text = document.createElement("p"), detail = document.createElement("p");
      text.textContent = String(reminder.text).replace(/<at>([\s\S]*?)<\/at>/g, "$1"); detail.className = "hint";
      const timezone = reminder.schedule.timezone;
      const schedule = reminder.schedule.type === "once" ? formatTime(reminder.schedule.at, timezone) : `${reminder.schedule.expression} · ${timezone}`;
      const next = reminder.schedule.type === "cron" && reminder.nextRunAt ? ` · ${app.t("reminderNext", { time: formatTime(reminder.nextRunAt, timezone) })}` : "";
      detail.textContent = `${schedule}${reminder.paused ? ` · ${app.t("reminderPaused")}` : next}`;
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "btn ghost small"; toggle.textContent = app.t(reminder.paused ? "reminderResume" : "reminderPause");
      toggle.addEventListener("click", () => void update(reminder, !reminder.paused));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn ghost small danger-text"; remove.textContent = app.t("reminderDelete");
      remove.addEventListener("click", () => { if (confirm(app.t("reminderDeleteConfirm"))) void erase(reminder); });
      row.append(text, detail, toggle, remove); list.append(row);
    }
  }
  async function load(id = roomId()) {
    if (!id) return;
    const request = ++generation, context = roomGeneration; status(app.t("reminderLoading"));
    try {
      const query = new URLSearchParams({ sessionID: LS.sessionID });
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/reminders?${query}`);
      if (!current(id, context) || generation !== request) return;
      reminders = Array.isArray(result.reminders) ? result.reminders : []; render();
    } catch (error) { if (current(id, context) && generation === request) status(errorText(error)); }
  }
  function validCron(expression) {
    return expression.trim().split(/\s+/).length === 5;
  }
  async function update(reminder, paused) {
    const id = roomId(), context = roomGeneration;
    try {
      await app.api(`/rooms/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminder.id)}`, { method: "PATCH", body: JSON.stringify({ sessionID: LS.sessionID, paused }) });
      if (current(id, context)) { invalidateLoads(); reminders = reminders.map((item) => item.id === reminder.id ? { ...item, paused } : item); render(); status(app.t("reminderUpdated")); await load(id); }
    } catch (error) { if (current(id, context)) { invalidateLoads(); status(errorText(error)); } }
  }
  async function erase(reminder) {
    const id = roomId(), context = roomGeneration;
    try {
      await app.api(`/rooms/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminder.id)}`, { method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }) });
      if (current(id, context)) { invalidateLoads(); reminders = reminders.filter((entry) => entry.id !== reminder.id); render(); status(app.t("reminderDeleted")); }
    } catch (error) { if (current(id, context)) { invalidateLoads(); status(errorText(error)); } }
  }
  const type = $("#reminderType"), date = $("#reminderAt"), cron = $("#reminderCron");
  type.addEventListener("change", () => {
    const once = type.value === "once";
    $("#reminderOnceField").hidden = !once; $("#reminderCronFields").hidden = once;
    date.required = once; cron.required = !once;
  });
  $("#reminderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = roomId(), context = roomGeneration, zone = $("#reminderTimezone").value.trim(), text = $("#reminderText").value.trim();
    const schedule = type.value === "once"
      ? { type: "once", at: `${date.value}:00`, ...(zone ? { timezone: zone } : {}) }
      : { type: "cron", expression: cron.value.trim(), ...(zone ? { timezone: zone } : {}) };
    if (!id || !text || text.length > 1000 || type.value === "once" && !date.value || type.value === "cron" && !validCron(schedule.expression)) return status(app.t("reminderInvalid"));
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/reminders`, { method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, schedule, text }) });
      if (current(id, context)) { invalidateLoads(); reminders = [...reminders.filter((item) => item.id !== result.reminder.id), result.reminder]; render(); status(app.t("reminderCreated")); }
    } catch (error) { if (current(id, context)) { invalidateLoads(); status(errorText(error)); } }
  });
  $("#btnRefreshReminders").addEventListener("click", () => void load());
  trigger.addEventListener("click", () => {
    const open = panel.hidden; app.closePanels(); panel.hidden = !open; trigger.setAttribute("aria-expanded", String(open));
    if (open) { void load(); $("#reminderHeading").focus(); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { app.closePanels(); trigger.focus(); } });
  const close = app.closePanels;
  app.closePanels = () => { close(); panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  document.addEventListener("chat-room-activated", (event) => {
    if (activeRoomId) drafts.set(activeRoomId, formDraft());
    activeRoomId = event.detail; restoreDraft(drafts.get(activeRoomId));
    roomGeneration++; generation++; reminders = []; render(); void load(activeRoomId);
  });
}
