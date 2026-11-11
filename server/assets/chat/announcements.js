import { LS } from "./state.js";

export function initAnnouncements(app) {
  const $ = app.$, drafts = new Map();
  const panel = $("#announcementPanel"), trigger = $("#btnAnnouncements"), list = $("#announcementList");
  let items = [], selected = "", generation = 0, roomGeneration = 0, editorRevision = 0, saveToken = 0;
  const key = (id, name = selected) => `${id}\0${name ? `item\0${name}` : "new"}`;
  const roomId = () => app.state.room?.id;
  const currentRoom = (id, request) => roomId() === id && roomGeneration === request;
  const draft = (id, name = selected) => drafts.get(key(id, name));
  function storeDraft(id = roomId(), name = selected) {
    if (id) drafts.set(key(id, name), { name: name || $("#announcementName").value, content: $("#announcementContent").value });
  }
  function editorSnapshot() {
    return { selected, revision: editorRevision, name: $("#announcementName").value, content: $("#announcementContent").value };
  }
  const editorMatches = (snapshot) => selected === snapshot.selected && editorRevision === snapshot.revision;
  function clearDraftIfUnchanged(id, name, snapshot) {
    const saved = draft(id, name);
    if (saved?.name === snapshot.name && saved.content === snapshot.content) drafts.delete(key(id, name));
  }
  function status(text) { $("#announcementStatus").textContent = text; }
  function count() { $("#announcementCount").textContent = app.t("announcementCount", { count: Array.from($("#announcementContent").value).length }); }
  function render() {
    list.textContent = "";
    for (const entry of items) {
      const li = document.createElement("li"), button = document.createElement("button");
      button.type = "button"; button.textContent = entry.name;
      if (entry.name === selected) button.setAttribute("aria-current", "true");
      button.addEventListener("click", (event) => { event.stopPropagation(); select(entry); });
      li.append(button); list.append(li);
    }
    if (!items.length) status(app.t("announcementEmpty"));
  }
  function select(entry) {
    const id = roomId(); if (!id) return;
    const next = entry?.name || "";
    if (next !== selected) editorRevision++;
    selected = next;
    const name = $("#announcementName"), content = $("#announcementContent");
    name.value = selected; name.readOnly = Boolean(selected);
    const saved = draft(id);
    name.value = selected || saved?.name || "";
    content.value = saved?.content ?? entry?.content ?? "";
    $("#btnDeleteAnnouncement").hidden = !selected;
    render(); count();
  }
  async function load(id = roomId()) {
    if (!id) return;
    const request = ++generation, context = roomGeneration; status(app.t("announcementLoading"));
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/announcements`);
      if (roomId() !== id || context !== roomGeneration || generation !== request) return;
      items = Array.isArray(result.announcements) ? result.announcements : [];
      status("");
      const chosen = items.find((item) => item.name === selected);
      if (!chosen) {
        const stale = selected && draft(id, selected);
        if (stale) {
          drafts.set(key(id, ""), { ...stale, name: $("#announcementName").value.trim() || stale.name });
          drafts.delete(key(id, selected));
        }
        select(null);
      } else select(chosen);
      render();
    } catch (error) {
      if (roomId() !== id || context !== roomGeneration || generation !== request) return;
      status(app.t("announcementLoadFailed"));
      if (error.status === 401) app.openChatSettings();
    }
  }
  $("#announcementContent").addEventListener("input", () => {
    editorRevision++; count(); storeDraft();
  });
  $("#announcementName").addEventListener("input", () => {
    editorRevision++; storeDraft();
  });
  $("#announcementForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = roomId(), name = $("#announcementName").value.trim(), content = $("#announcementContent").value;
    if (!id || !name || Array.from(name).length > 64 || Array.from(content).length > 5000) return status(app.t("announcementInvalid"));
    if (!selected && items.some((item) => item.name === name)) return status(app.t("announcementDuplicate"));
    const context = roomGeneration, captured = editorSnapshot(), draftName = selected, button = $("#btnSaveAnnouncement"), token = ++saveToken;
    storeDraft(id, draftName); button.disabled = true;
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, {
        method: "PUT", body: JSON.stringify({ sessionID: LS.sessionID, content }),
      });
      if (currentRoom(id, context)) {
        generation++; items = [...items.filter((item) => item.name !== name), result.announcement]; render();
        clearDraftIfUnchanged(id, draftName, captured);
        if (editorMatches(captured)) { select(result.announcement); status(app.t("announcementSaved")); }
        else if (!selected) {
          // Keep editing the newer draft under the name the create just reserved.
          drafts.delete(key(id, draftName));
          selected = result.announcement.name;
          $("#announcementName").value = selected; $("#announcementName").readOnly = true;
          $("#btnDeleteAnnouncement").hidden = false;
          drafts.set(key(id, selected), { name: selected, content: $("#announcementContent").value });
          render();
        }
      }
    } catch (error) {
      if (currentRoom(id, context) && editorMatches(captured)) status(error.status === 403 ? error.message : app.t("announcementLoadFailed"));
    }
    finally { if (token === saveToken) button.disabled = false; }
  });
  $("#btnNewAnnouncement").addEventListener("click", () => { select(null); $("#announcementName").focus(); });
  $("#btnDeleteAnnouncement").addEventListener("click", async () => {
    const id = roomId(), name = selected;
    if (!id || !name || !confirm(app.t("announcementDeleteConfirm", { name }))) return;
    const context = roomGeneration, captured = editorSnapshot();
    try {
      await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }) });
      if (currentRoom(id, context)) {
        generation++; items = items.filter((item) => item.name !== name); render();
        clearDraftIfUnchanged(id, name, captured);
        if (editorMatches(captured)) { select(null); status(app.t("announcementDeleted")); }
      }
    } catch (error) { if (currentRoom(id, context) && editorMatches(captured)) status(error.message); }
  });
  $("#btnRefreshAnnouncements").addEventListener("click", () => void load());
  trigger.addEventListener("click", () => {
    const open = panel.hidden; app.closePanels(); panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open)); if (open) { void load(); $("#announcementHeading").focus(); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { app.closePanels(); trigger.focus(); } });
  const close = app.closePanels;
  app.closePanels = () => { close(); panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  document.addEventListener("chat-room-activated", (event) => {
    const id = event.detail;
    roomGeneration++; generation++; saveToken++; $("#btnSaveAnnouncement").disabled = false;
    selected = ""; items = []; select(null); void load(id);
  });
}
