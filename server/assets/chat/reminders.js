import { LS } from "./state.js";

export function initReminders(app) {
  const $ = app.$, panel = $("#reminderPanel"), trigger = $("#btnReminders"), list = $("#reminderList"), dialog = $("#reminderDialog"), newButton = $("#btnNewReminder");
  const heading = $("#reminderDialogHeading"), submit = $("#btnSubmitReminder");
  app.setText($("#reminderTemplateHint"), "reminderTemplateHint", { time: "{time}", initiator: "{initiator}", room: "{room}" });
  let reminders = [], generation = 0, roomGeneration = 0, activeRoomId, editing = null, createDraft = null, saving = false, saveToken = 0;
  const drafts = new Map();
  const roomId = () => app.state.room?.id;
  const status = (text) => { $("#reminderStatus").textContent = text; };
  const formStatus = (text) => { $("#reminderDialogStatus").textContent = text; };
  function openDialog(reminder = null) {
    // Opening an edit parks the create draft; the next New puts it back.
    if (reminder && createDraft === null) createDraft = formDraft();
    if (!reminder && createDraft !== null) { restoreDraft(createDraft); createDraft = null; }
    editing = reminder;
    heading.textContent = app.t(reminder ? "reminderEditHeading" : "reminderCreate");
    submit.textContent = app.t(reminder ? "reminderSave" : "reminderCreate");
    if (reminder) { delete heading.dataset.i18n; delete submit.dataset.i18n; }
    else { heading.dataset.i18n = "reminderCreate"; submit.dataset.i18n = "reminderCreate"; }
    if (reminder) restoreDraft(editDraft(reminder));
    formStatus("");
    if (!dialog.open) dialog.showModal();
    $("#reminderText").focus();
  }
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
  // datetime-local has no zone; format the stored instant in its own zone so saving reproduces it.
  function inputValue(iso, timezone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  function editDraft(reminder) {
    const timezone = reminder.schedule.timezone || "UTC";
    return reminder.schedule.type === "once"
      ? { type: "once", at: inputValue(reminder.schedule.at, timezone), timezone, text: reminder.text }
      : { type: "cron", cron: reminder.schedule.expression, timezone, text: reminder.text };
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
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "btn ghost small"; edit.textContent = app.t("reminderEdit");
      edit.setAttribute("aria-label", `${edit.textContent}: ${text.textContent.slice(0, 80)}`);
      edit.addEventListener("click", () => openDialog(reminder));
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "btn ghost small"; toggle.textContent = app.t(reminder.paused ? "reminderResume" : "reminderPause");
      toggle.setAttribute("aria-label", `${toggle.textContent}: ${text.textContent.slice(0, 80)}`);
      toggle.addEventListener("click", () => void update(reminder, !reminder.paused));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn ghost small danger-text"; remove.textContent = app.t("reminderDelete");
      remove.setAttribute("aria-label", `${remove.textContent}: ${text.textContent.slice(0, 80)}`);
      remove.addEventListener("click", async () => { if (await app.confirmAction(app.t("reminderDeleteConfirm"))) void erase(reminder); });
      row.append(text, detail, edit, toggle, remove); list.append(row);
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
  function validZone(value) {
    if (!value) return true;
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
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
    if (!id || !text || text.length > 2000 || !validZone(zone) || type.value === "once" && !date.value || type.value === "cron" && !validCron(schedule.expression)) return formStatus(app.t("reminderInvalid"));
    if (saving) return;
    saving = true; submit.disabled = true;
    const token = ++saveToken;
    // Keep the stored schedule when only the text changed, so a fired one-time reminder stays editable.
    try {
      const editingId = editing?.id;
      const sameSchedule = Boolean(editing?.schedule) && editing.schedule.type === type.value
        && (type.value === "once" ? inputValue(editing.schedule.at, zone || "UTC") === date.value : editing.schedule.expression === schedule.expression)
        && (editing.schedule.timezone || "UTC") === (zone || "UTC");
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/reminders${editingId ? `/${encodeURIComponent(editingId)}` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify({ sessionID: LS.sessionID, text, ...(sameSchedule ? {} : { schedule }) }) });
      if (current(id, context)) {
        invalidateLoads();
        reminders = editingId ? reminders.map((item) => item.id === editingId ? result.reminder : item) : [...reminders.filter((item) => item.id !== result.reminder.id), result.reminder];
        render(); status(app.t(editingId ? "reminderUpdated" : "reminderCreated")); editing = null; dialog.close();
      }
    } catch (error) { if (current(id, context)) { invalidateLoads(); formStatus(errorText(error)); } }
    finally { if (token === saveToken) { saving = false; submit.disabled = false; } }
  });
  $("#btnRefreshReminders").addEventListener("click", () => void load());
  newButton.addEventListener("click", () => openDialog());
  $("#btnCloseReminder").addEventListener("click", () => dialog.close());
  $("#btnCancelReminder").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { editing = null; });
  trigger.addEventListener("click", () => {
    const open = panel.hidden; app.closePanels(); panel.hidden = !open; trigger.setAttribute("aria-expanded", String(open));
    if (open) { void load(); $("#reminderHeading").focus(); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !dialog.open && !panel.hidden) { app.closePanels(); trigger.focus(); } });
  const close = app.closePanels;
  app.closePanels = () => { close(); panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  document.addEventListener("chat-room-activated", (event) => {
    if (activeRoomId) drafts.set(activeRoomId, createDraft ?? formDraft());
    if (dialog.open) dialog.close();
    formStatus("");
    editing = null; createDraft = null; saving = false; saveToken++; submit.disabled = false;
    activeRoomId = event.detail; restoreDraft(drafts.get(activeRoomId));
    roomGeneration++; generation++; reminders = []; render(); void load(activeRoomId);
  });
}
