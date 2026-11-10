import { LS } from "./state.js";

const MAX_PARALLEL_UPLOADS = 2;
const TEXT_LIMIT = 2000;
const previewTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

export function initAttachments(app) {
  const $ = app.$, input = $("#msgInput"), list = $("#attachmentList"), tray = $("#attachmentTray"), picker = $("#attachmentPicker");
  const drafts = new Map();
  const statuses = new Map();
  app.state.sendingRooms ||= new Set();
  let limit = null, configRequest = null, activeUploads = 0;
  const roomId = () => app.state.room?.id || "";
  const filesFor = (id) => drafts.get(id) || [];
  const markers = (items) => items.filter((item) => item.resource).map((item) => `[[resource:${item.resource.id}]]`);
  const textFor = (id, caption) => {
    const parts = [String(caption || "").trim(), ...markers(filesFor(id))].filter(Boolean);
    return { text: parts.join("\n\n"), ids: filesFor(id).filter((item) => item.resource).map((item) => item.resource.id) };
  };
  function formatSize(size) {
    if (size < 1024) return `${size} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = size / 1024, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
  }
  function preserveLayout(change) {
    const thread = $("#thread"), atBottom = Boolean(roomId() && Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) < 1);
    if (atBottom) { change(); thread.scrollTop = thread.scrollHeight; }
    else if (roomId() && app.preserveReadingLayout) void app.preserveReadingLayout(change).catch(() => {});
    else change();
  }
  function setStatus(key = "", error = false, id = roomId(), values = {}) {
    if (id) statuses.set(id, { key, error, values });
    if (id === roomId()) preserveLayout(() => {
      const node = $("#attachmentStatus"); node.textContent = key ? app.t(key, values) : ""; node.classList.toggle("danger-text", error); if (key) tray.hidden = false;
    });
  }
  function prepareMessage(id, caption) {
    const items = filesFor(id), composed = textFor(id, caption);
    return { ...composed, ready: Boolean(composed.text) && composed.text.length <= TEXT_LIMIT && items.every((item) => item.status === "uploaded") };
  }
  app.prepareMessage = prepareMessage;
  const baseDraftCount = app.updateDraftCount;
  app.updateDraftCount = () => {
    if (!roomId()) { $("#draftCount").classList.remove("over-limit"); return baseDraftCount(); }
    const count = textFor(roomId(), input.value).text.length;
    app.setText($("#draftCount"), "messageCount", { count });
    $("#draftCount").classList.toggle("over-limit", count > TEXT_LIMIT);
  };
  app.updateSendState = () => {
    const id = roomId(), message = id && prepareMessage(id, input.value);
    $("#btnSend").disabled = !id || !message?.ready || app.state.sendingRooms.has(id);
  };
  app.completeAttachments = (id, resourceIDs) => {
    const used = new Set(resourceIDs), items = filesFor(id), removed = items.filter((item) => used.has(item.resource?.id));
    for (const item of removed) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    const remaining = items.filter((item) => !used.has(item.resource?.id));
    if (remaining.length) drafts.set(id, remaining); else { drafts.delete(id); statuses.delete(id); }
    if (roomId() === id) render();
  };
  app.completeAttachmentsFromText = (id, text) => app.completeAttachments(id, [...String(text).matchAll(/\[\[resource:([\da-f-]{36})\]\]/gi)].map((match) => match[1]));
  const applyLocale = app.applyLocale;
  app.applyLocale = () => { applyLocale(); updateLocale(); };
  function updateLocale() {
    const id = roomId(), items = filesFor(id);
    items.forEach((item, index) => {
      const row = list.children[index]; if (!row) return;
      const detail = row.querySelector(".attachment-detail"), progress = row.querySelector("progress");
      detail.textContent = `${formatSize(item.file.size)} · ${item.status === "failed" ? app.t(item.errorKey, item.errorValues || {}) : item.status === "uploaded" ? app.t("uploadReady") : item.status === "uploading" ? app.t("uploadPercent", { percent: item.percent || 0 }) : app.t("uploadQueued")}`;
      const retry = row.querySelector('[data-upload-action="retry"]'); if (retry) { retry.textContent = app.t("retryUpload"); retry.setAttribute("aria-label", retry.textContent); }
      const remove = row.querySelector('[data-upload-action="remove"]'); if (remove) { remove.textContent = app.t("removeFile"); remove.setAttribute("aria-label", remove.textContent); }
      progress.setAttribute("aria-label", app.t("uploadPercent", { percent: item.percent || 0 }));
      progress.setAttribute("aria-valuetext", app.t("uploadPercent", { percent: item.percent || 0 }));
    });
    const status = statuses.get(id); $("#attachmentStatus").textContent = status?.key ? app.t(status.key, status.values) : "";
    if (status?.key) tray.hidden = false;
  }
  function render() {
    preserveLayout(() => {
      const id = roomId(), items = filesFor(id), savedStatus = statuses.get(id);
      tray.hidden = !items.length && !savedStatus?.key; $("#attachmentVolatile").hidden = !items.length;
      $("#attachmentStatus").textContent = savedStatus?.key ? app.t(savedStatus.key, savedStatus.values) : ""; $("#attachmentStatus").classList.toggle("danger-text", Boolean(savedStatus?.error));
      list.replaceChildren();
      items.forEach((item, index) => { const row = renderItem(item); row.dataset.index = String(index); list.append(row); });
      app.updateDraftCount(); app.updateSendState();
    });
  }
  app.renderAttachments = render;
  function renderItem(item) {
    const row = document.createElement("li"), preview = document.createElement("span"), info = document.createElement("div"), name = document.createElement("p"), detail = document.createElement("p"), progress = document.createElement("progress"), actions = document.createElement("div");
    row.className = "attachment-item"; preview.className = "attachment-preview";
    if (previewTypes.has(item.file.type)) {
      item.previewUrl ||= URL.createObjectURL(item.file);
      const image = document.createElement("img"); image.src = item.previewUrl; image.alt = ""; preview.append(image);
    } else preview.textContent = item.file.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
    info.className = "attachment-file"; name.className = "attachment-name"; name.textContent = item.file.name;
    detail.className = `attachment-detail${item.status === "failed" ? " attachment-over-limit" : ""}`;
    detail.textContent = `${formatSize(item.file.size)} · ${item.status === "failed" ? app.t(item.errorKey, item.errorValues || {}) : item.status === "uploaded" ? app.t("uploadReady") : item.status === "uploading" ? app.t("uploadPercent", { percent: item.percent || 0 }) : app.t("uploadQueued")}`;
    progress.max = item.file.size || 1; progress.value = item.loaded || 0; progress.hidden = item.status !== "uploading";
    progress.setAttribute("aria-label", app.t("uploadPercent", { percent: item.percent || 0 }));
    item.progressNode = progress; item.detailNode = detail;
    info.append(name, detail, progress); actions.className = "attachment-actions";
    if (item.status === "failed") actions.append(action("retry", app.t("retryUpload")));
    actions.append(action("remove", app.t("removeFile"))); row.append(preview, info, actions);
    return row;
  }
  function action(kind, label) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.uploadAction = kind; button.textContent = label; button.setAttribute("aria-label", label); return button;
  }
  function removeItem(id, item) {
    item.cancelled = true; item.xhr?.abort();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    const remaining = filesFor(id).filter((entry) => entry !== item);
    if (remaining.length) drafts.set(id, remaining); else { drafts.delete(id); statuses.delete(id); }
    if (roomId() === id) render();
  }
  function clearRoom(id) {
    for (const item of [...filesFor(id)]) removeItem(id, item);
    drafts.delete(id); statuses.delete(id);
  }
  app.disposeRoomAttachments = clearRoom;
  function getLimit(refresh = false) {
    if (refresh) limit = null;
    if (limit !== null) return Promise.resolve(limit);
    if (!configRequest || refresh) {
      const request = app.api("/resources/config").then((data) => {
        if (!Number.isSafeInteger(data.maxFileSizeBytes) || data.maxFileSizeBytes < 1) throw new Error("Invalid upload limit");
        if (configRequest === request) limit = data.maxFileSizeBytes;
        return data.maxFileSizeBytes;
      }).finally(() => { if (configRequest === request) configRequest = null; });
      configRequest = request;
    }
    return configRequest;
  }
  function pump() {
    while (activeUploads < MAX_PARALLEL_UPLOADS) {
      const next = [...drafts].flatMap(([id, items]) => items.map((item) => ({ id, item }))).find(({ item }) => item.status === "queued");
      if (!next) return;
      activeUploads++; next.item.status = "uploading"; next.item.percent = 0;
      if (roomId() === next.id) render();
      void uploadItem(next.id, next.item);
    }
  }
  async function uploadItem(id, item) {
    try {
      let max = null;
      try { max = await getLimit(item.refreshLimit); } catch {}
      item.refreshLimit = false;
      if (item.cancelled) return;
      if (max !== null && item.file.size > max) { item.errorKey = "fileTooLarge"; item.status = "failed"; if (roomId() === id) setStatus(item.errorKey, true, id); return; }
      item.resource = await upload(id, item);
      if (item.cancelled) return;
      item.status = "uploaded"; item.loaded = item.file.size; item.percent = 100;
      if (roomId() === id && filesFor(id).every((entry) => entry.status === "uploaded")) setStatus("uploadReady");
    } catch (error) {
      if (item.cancelled) return;
      if (error.status === 413) { limit = null; item.errorKey = "fileTooLarge"; }
      else item.errorKey = "uploadFailed";
      item.status = "failed";
      if (roomId() === id) setStatus(item.errorKey, true, id, item.errorValues || {});
    } finally {
      activeUploads--;
      if (roomId() === id) render();
      pump();
    }
  }
  function upload(id, item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); item.xhr = xhr;
      xhr.open("POST", `/rooms/${encodeURIComponent(id)}/resources`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Session-ID", LS.sessionID);
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(item.file.name));
      if (LS.token) xhr.setRequestHeader("Authorization", `Bearer ${LS.token}`);
      xhr.timeout = 1800000;
      xhr.upload.onprogress = (event) => {
        item.loaded = event.loaded; item.percent = Math.min(100, event.lengthComputable ? Math.floor(event.loaded / event.total * 100) : item.file.size ? Math.floor(event.loaded / item.file.size * 100) : 100);
        if (roomId() === id) {
          if (item.progressNode) { item.progressNode.value = item.loaded; item.progressNode.max = item.file.size || 1; item.progressNode.setAttribute("aria-valuetext", app.t("uploadPercent", { percent: item.percent })); }
          if (item.detailNode) item.detailNode.textContent = `${formatSize(item.file.size)} · ${app.t("uploadPercent", { percent: item.percent })}`;
        }
      };
      xhr.onload = () => {
        item.xhr = null;
        if (xhr.status !== 201) return reject(Object.assign(new Error("Upload failed"), { status: xhr.status }));
        try {
          const resource = JSON.parse(xhr.responseText).resource;
          if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(resource?.id) || resource.roomID !== id) throw new Error("Invalid resource response");
          resolve(resource);
        } catch { reject(new Error("Invalid resource response")); }
      };
      xhr.onerror = () => { item.xhr = null; reject(Object.assign(new Error("Upload failed"), { network: true })); };
      xhr.ontimeout = () => { item.xhr = null; reject(Object.assign(new Error("Upload timed out"), { timeout: true })); };
      xhr.onabort = () => { item.xhr = null; reject(Object.assign(new Error("Upload cancelled"), { aborted: true })); };
      xhr.send(item.file);
    });
  }
  function addFiles(files) {
    const id = roomId(); if (!id) return;
    const accepted = [...files].filter((file) => file instanceof File);
    if (!accepted.length) return;
    const items = filesFor(id);
    for (const file of accepted) items.push({ file, status: "queued", loaded: 0, percent: 0, cancelled: false });
    drafts.set(id, items); setStatus(""); render(); pump();
  }
  function retryItem(item) {
    if (item.status !== "failed") return;
    item.refreshLimit = item.errorKey === "fileTooLarge"; item.status = "queued"; item.errorKey = ""; item.errorValues = null; item.loaded = 0; item.percent = 0;
    if (roomId()) setStatus(""); render(); pump();
  }
  $("#btnAddAttachments").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { addFiles(picker.files || []); picker.value = ""; });
  list.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-upload-action]"); if (!button) return;
    const id = roomId(), index = Number(button.closest(".attachment-item")?.dataset.index), item = filesFor(id)[index];
    if (!item) return;
    if (button.dataset.uploadAction === "retry") { retryItem(item); $("#btnAddAttachments").focus(); }
    else { removeItem(id, item); (list.querySelector(`[data-index="${Math.min(index, filesFor(id).length - 1)}"] [data-upload-action=remove]`) || $("#btnAddAttachments")).focus(); }
  });
  const chatView = $("#chatView"), overlay = $("#attachmentDropOverlay");
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const showDrop = () => { chatView.classList.add("drag-over"); overlay.hidden = false; };
  const clearDrop = () => { chatView.classList.remove("drag-over"); overlay.hidden = true; };
  chatView.addEventListener("dragenter", (event) => { if (!hasFiles(event)) return; event.preventDefault(); showDrop(); });
  chatView.addEventListener("dragover", (event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; showDrop(); });
  chatView.addEventListener("dragleave", (event) => { if (hasFiles(event) && !chatView.contains(event.relatedTarget)) clearDrop(); });
  chatView.addEventListener("drop", (event) => { if (!hasFiles(event)) return; event.preventDefault(); clearDrop(); addFiles(event.dataTransfer.files); });
  input.addEventListener("paste", (event) => {
    const images = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (!images.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(images);
  });
  document.addEventListener("chat-room-activated", (event) => {
    render(); const id = event.detail; $("#btnAddAttachments").disabled = !id;
    void getLimit().catch(() => {});
  });
  render();
}
