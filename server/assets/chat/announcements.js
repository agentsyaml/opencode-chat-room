import { LS } from "./state.js";

export function initAnnouncements(app) {
  const $ = app.$, drafts = new Map();
  const surface = $("#announcementsDialog"), trigger = $("#btnAnnouncements"), list = $("#announcementList");
  const dialog = $("#announcementDialog"), heading = $("#announcementDialogHeading");
  const panelHeading = $("#announcementHeading"), chatView = $("#chatView");
  let items = [], selected = "", generation = 0, roomGeneration = 0, editorRevision = 0, saveToken = 0;
  let opener = null, pendingReopen = false, restoreSurfaceFocus = true;
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
  function formStatus(text) { $("#announcementDialogStatus").textContent = text; }
  function count() { $("#announcementCount").textContent = app.t("announcementCount", { count: Array.from($("#announcementContent").value).length }); }
  const clearPane = () => {
    surface.classList.remove("is-pane");
    if (chatView.dataset.sidePane !== "announcements") return;
    delete chatView.dataset.sidePane;
    chatView.classList.remove("has-pane");
  };
  const showSurface = () => {
    if (app.panelPlacement("announcements") === "pane") {
      app.closeOtherPanelSurfaces?.("announcements");
      surface.classList.add("is-pane");
      chatView.classList.add("has-pane");
      chatView.dataset.sidePane = "announcements";
      if (!surface.open) surface.show();
    } else {
      clearPane();
      if (!surface.open) surface.showModal();
    }
  };
  const syncMode = () => {
    if (!surface.open || (app.panelPlacement("announcements") === "pane") === surface.classList.contains("is-pane")) return;
    pendingReopen = true;
    surface.close();
    showSurface();
    panelHeading.focus({ preventScroll: true });
  };
  const closeSurface = (focus = true) => {
    restoreSurfaceFocus = focus;
    if (surface.open) surface.close();
  };
  function openSurface() {
    const id = roomId();
    if (!id) return;
    if (app.panelPlacement("announcements") === "pane") app.closeDocPreview?.(false);
    if (surface.open) { panelHeading.focus(); return; }
    app.closePanels?.();
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body && !active.closest("dialog") && !$("#roomOptions")?.contains(active)
      ? active : $("#btnRoomOptions");
    showSurface();
    panelHeading.focus();
    void load(id);
  }
  function render() {
    list.textContent = "";
    for (const entry of items) {
      const li = document.createElement("li"), button = document.createElement("button");
      button.type = "button"; button.textContent = entry.name; button.setAttribute("aria-haspopup", "dialog");
      if (entry.name === selected) button.setAttribute("aria-current", "true");
      button.addEventListener("click", (event) => { event.stopPropagation(); openEditor(entry); });
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
  function openEditor(entry) {
    select(entry);
    if (entry) { delete heading.dataset.i18n; heading.textContent = entry.name; }
    else { heading.dataset.i18n = "announcementNew"; heading.textContent = app.t("announcementNew"); }
    formStatus("");
    if (!dialog.open) dialog.showModal();
    $(entry ? "#announcementContent" : "#announcementName").focus();
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
    if (!id || !name || Array.from(name).length > 64 || Array.from(content).length > 5000) return formStatus(app.t("announcementInvalid"));
    if (!selected && items.some((item) => item.name === name)) return formStatus(app.t("announcementDuplicate"));
    const context = roomGeneration, captured = editorSnapshot(), draftName = selected, button = $("#btnSaveAnnouncement"), token = ++saveToken;
    storeDraft(id, draftName); button.disabled = true;
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, {
        method: "PUT", body: JSON.stringify({ sessionID: LS.sessionID, content }),
      });
      if (currentRoom(id, context)) {
        generation++; items = [...items.filter((item) => item.name !== name), result.announcement]; render();
        clearDraftIfUnchanged(id, draftName, captured);
        if (editorMatches(captured)) { select(result.announcement); status(app.t("announcementSaved")); formStatus(""); dialog.close(); }
        else if (!selected) {
          // Keep editing the newer draft under the name the create just reserved.
          drafts.delete(key(id, draftName));
          selected = result.announcement.name;
          heading.textContent = selected; delete heading.dataset.i18n;
          $("#announcementName").value = selected; $("#announcementName").readOnly = true;
          $("#btnDeleteAnnouncement").hidden = false;
          drafts.set(key(id, selected), { name: selected, content: $("#announcementContent").value });
          render();
        }
      }
    } catch (error) {
      if (currentRoom(id, context) && editorMatches(captured)) formStatus(error.status === 403 ? error.message : app.t("announcementLoadFailed"));
    }
    finally { if (token === saveToken) button.disabled = false; }
  });
  $("#btnNewAnnouncement").addEventListener("click", () => openEditor(null));
  $("#btnDeleteAnnouncement").addEventListener("click", async () => {
    const id = roomId(), name = selected, button = $("#btnDeleteAnnouncement");
    if (!id || !name || button.disabled) return;
    button.disabled = true;
    const context = roomGeneration, captured = editorSnapshot();
    try {
      if (!(await app.confirmAction(app.t("announcementDeleteConfirm", { name })))) return;
      await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }) });
      if (currentRoom(id, context)) {
        generation++; items = items.filter((item) => item.name !== name); render();
        clearDraftIfUnchanged(id, name, captured);
        if (editorMatches(captured)) { select(null); status(app.t("announcementDeleted")); formStatus(""); dialog.close(); }
      }
    } catch (error) { if (currentRoom(id, context) && editorMatches(captured)) formStatus(error.message); }
    finally { button.disabled = false; }
  });
  $("#btnRefreshAnnouncements").addEventListener("click", () => void load());
  $("#btnCloseAnnouncement").addEventListener("click", () => dialog.close());
  $("#btnCancelAnnouncement").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  trigger.addEventListener("click", () => {
    // The entry lives in the Options menu, so choosing it closes that menu first.
    app.closePanels();
    openSurface();
  });
  $("#btnCloseAnnouncements").addEventListener("click", () => closeSurface());
  surface.addEventListener("click", (event) => { if (event.target === surface) closeSurface(); });
  surface.addEventListener("cancel", (event) => { event.preventDefault(); closeSurface(); });
  surface.addEventListener("close", () => {
    if (pendingReopen) { pendingReopen = false; return; }
    clearPane();
    const focus = restoreSurfaceFocus;
    restoreSurfaceFocus = true;
    const target = opener;
    opener = null;
    if (focus && target?.isConnected) target.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !surface.open || !surface.classList.contains("is-pane")) return;
    if (!surface.contains(document.activeElement)) return;
    event.preventDefault();
    closeSurface();
  });
  app.registerPanelSurface?.("announcements", { close: () => closeSurface(false) });
  app.watchPanel?.("announcements", syncMode);
  const closePanels = app.closePanels;
  app.closePanels = () => { closePanels(); if (dialog.open) dialog.close(); };
  document.addEventListener("chat-room-activated", (event) => {
    const id = event.detail;
    if (dialog.open) dialog.close();
    if (surface.open && !surface.classList.contains("is-pane")) closeSurface(false);
    formStatus("");
    roomGeneration++; generation++; saveToken++; $("#btnSaveAnnouncement").disabled = false;
    selected = ""; items = []; select(null); void load(id);
  });
}
