// Room files: a file-browser dialog over the room's uploaded resources.
import { LS } from "./state.js";
import { isRoomAdmin } from "./admin-badge.js";

const PAGE_SIZE = 500;
const UNKNOWN_UPLOADER = "__unknown_uploader__";
const ICONS = {
  image: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 4 4 2-2 3 3"/></svg>',
  audio: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
  video: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
  preview: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11M8 11l4 4 4-4M5 20h14"/></svg>',
  trash: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg>',
};

export function initFiles(app) {
  const dialog = app.$("#filesDialog");
  if (!dialog) return;
  const $ = app.$;
  const list = $("#fileList"), select = $("#filesUploader"), summary = $("#filesSummary");
  const empty = $("#filesEmpty"), error = $("#filesError"), more = $("#btnFilesMore");
  const roomName = $("#filesRoomName"), heading = $("#filesHeading"), trigger = $("#btnFiles");
  let items = [], total = 0, loading = false, generation = 0, opener = null, preview = null, previewToken = 0;

  const mediaKind = (mime) => /^image\//.test(mime || "") ? "image"
    : /^audio\//.test(mime || "") ? "audio"
      : /^video\//.test(mime || "") ? "video" : "";
  const fileKind = (resource) => mediaKind(resource.mimeType) || "file";

  const sizeText = (bytes) => {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toLocaleString(app.intlLocale(), { maximumFractionDigits: size >= 10 ? 0 : 1 })} ${units[unit]}`;
  };

  const selfIsHuman = () => {
    const self = app.state.memberSessions.get(app.state.room?.id)?.find((member) => member.sessionID === LS.sessionID);
    return !self || self.type === "human";
  };
  const canDelete = (resource) => {
    if (selfIsHuman()) return isRoomAdmin(app);
    return resource.uploaderSessionID === LS.sessionID;
  };

  const contentURL = (resource) => `/rooms/${encodeURIComponent(resource.roomID)}/resources/${encodeURIComponent(resource.id)}/content`;

  const showError = (key) => {
    app.setText(error, key);
    error.hidden = false;
  };
  const hideError = () => { error.hidden = true; };

  const closePreview = () => {
    if (!preview) return;
    if (preview.url) URL.revokeObjectURL(preview.url);
    preview.box.textContent = "";
    preview.box.hidden = true;
    preview.box.classList.remove("is-error");
    preview.row.classList.remove("is-previewing");
    preview.button.setAttribute("aria-expanded", "false");
    preview = null;
  };

  const togglePreview = async (resource, row, button) => {
    if (preview?.id === resource.id) { closePreview(); return; }
    closePreview();
    const kind = mediaKind(resource.mimeType);
    if (!kind) return;
    const box = row.querySelector(".file-preview");
    box.hidden = false;
    box.classList.remove("is-error");
    box.textContent = app.t("resourceLoading");
    row.classList.add("is-previewing");
    button.setAttribute("aria-expanded", "true");
    const token = ++previewToken;
    try {
      const blob = await app.apiBlob(contentURL(resource), { headers: { "x-session-id": LS.sessionID } });
      if (token !== previewToken || !dialog.open || app.state.room?.id !== resource.roomID || !row.isConnected) return;
      const url = URL.createObjectURL(blob);
      const media = kind === "image" ? new Image() : document.createElement(kind);
      media.className = `file-preview-media file-preview-${kind}`;
      media.src = url;
      if (kind === "image") media.alt = resource.name;
      else { media.controls = true; media.setAttribute("aria-label", resource.name); }
      box.textContent = "";
      box.append(media);
      preview = { id: resource.id, url, box, row, button };
    } catch {
      if (token !== previewToken) return;
      box.textContent = app.t("filesPreviewFailed");
      box.classList.add("is-error");
    }
  };

  const download = async (resource) => {
    try {
      const blob = await app.apiBlob(contentURL(resource), { headers: { "x-session-id": LS.sessionID } });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = resource.name;
      link.rel = "noopener";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { showError("filesDownloadFailed"); }
  };

  const removeResource = async (resource) => {
    if (!(await app.confirmAction(app.t("resourceDeleteConfirm", { name: resource.name })))) return;
    try {
      await app.api(`/rooms/${encodeURIComponent(resource.roomID)}/resources/${encodeURIComponent(resource.id)}`, {
        method: "DELETE", headers: { "x-session-id": LS.sessionID }, body: "{}",
      });
      if (preview?.id === resource.id) closePreview();
      items = items.filter((item) => item.id !== resource.id);
      total = Math.max(0, total - 1);
      hideError();
      render();
    } catch { showError("resourceDeleteFailed"); }
  };

  const actionButton = (action, label, icon, extra = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-action file-action-${action}`;
    button.dataset.fileAction = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = icon;
    for (const [name, value] of Object.entries(extra)) button.setAttribute(name, value);
    return button;
  };

  const buildRow = (resource) => {
    const row = document.createElement("li");
    row.className = "file-row";
    row.dataset.resourceId = resource.id;
    const kind = fileKind(resource);
    const badge = document.createElement("span");
    badge.className = "file-kind";
    badge.dataset.kind = kind;
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = ICONS[kind] || ICONS.file;

    const main = document.createElement("div");
    main.className = "file-main";
    const name = document.createElement("p");
    name.className = "file-name";
    name.textContent = resource.name;
    name.title = resource.name;
    const meta = document.createElement("p");
    meta.className = "file-meta";
    const uploader = document.createElement("span");
    uploader.className = "file-uploader";
    uploader.textContent = resource.uploaderName || app.t("filesUnknownUploader");
    const date = document.createElement("time");
    date.className = "file-date";
    if (resource.createdAt) date.dateTime = new Date(resource.createdAt).toISOString();
    date.textContent = resource.createdAt ? app.fmtTime(resource.createdAt) : "";
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = sizeText(resource.size);
    const dot = () => {
      const node = document.createElement("span");
      node.className = "file-dot";
      node.setAttribute("aria-hidden", "true");
      node.textContent = "·";
      return node;
    };
    meta.append(uploader, dot(), date, dot(), size);
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "file-actions";
    const previewID = `file-preview-${resource.id}`;
    if (mediaKind(resource.mimeType)) {
      actions.append(actionButton("preview", app.t("filesPreviewLabel", { name: resource.name }), ICONS.preview, {
        "aria-expanded": "false", "aria-controls": previewID,
      }));
    }
    actions.append(actionButton("download", app.t("filesDownloadLabel", { name: resource.name }), ICONS.download));
    if (canDelete(resource)) actions.append(actionButton("delete", app.t("filesDeleteLabel", { name: resource.name }), ICONS.trash));

    const box = document.createElement("div");
    box.className = "file-preview";
    box.id = previewID;
    box.hidden = true;
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", app.t("filesPreviewLabel", { name: resource.name }));

    row.append(badge, main, actions, box);
    return row;
  };

  const rebuildUploaders = () => {
    const current = select.value || "all";
    const names = [...new Set(items.map((item) => item.uploaderName).filter(Boolean))]
      .sort((left, right) => String(left).localeCompare(String(right), app.intlLocale()));
    select.textContent = "";
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    };
    add("all", app.t("filesEveryone"));
    for (const name of names) add(String(name), String(name));
    if (items.some((item) => !item.uploaderName)) add(UNKNOWN_UPLOADER, app.t("filesUnknownUploader"));
    select.value = [...select.options].some((option) => option.value === current) ? current : "all";
  };

  const visibleItems = () => {
    const filter = select.value || "all";
    if (filter === "all") return items;
    if (filter === UNKNOWN_UPLOADER) return items.filter((item) => !item.uploaderName);
    return items.filter((item) => item.uploaderName === filter);
  };

  const render = () => {
    closePreview();
    rebuildUploaders();
    const visible = visibleItems();
    list.textContent = "";
    visible.forEach((resource, index) => {
      const row = buildRow(resource);
      row.style.setProperty("--file-i", String(Math.min(index, 9)));
      list.append(row);
    });
    empty.hidden = visible.length > 0;
    if (!visible.length) app.setText(empty, items.length ? "filesEmptyFiltered" : "filesEmpty");
    more.hidden = items.length >= total;
    const bytes = visible.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    summary.textContent = app.t("filesSummary", { count: visible.length, size: sizeText(bytes) });
  };

  const setBusy = (busy) => {
    loading = busy;
    dialog.setAttribute("aria-busy", String(busy));
    const refresh = $("#btnRefreshFiles");
    if (refresh) refresh.disabled = busy;
    more.disabled = busy;
  };

  const load = async (reset) => {
    const room = app.state.room;
    if (!room || loading) return;
    if (reset) {
      generation++;
      items = [];
      total = 0;
      hiddenState();
      closePreview();
      list.textContent = "";
      hideError();
    }
    const request = generation;
    setBusy(true);
    if (!items.length) summary.textContent = app.t("filesLoading");
    try {
      const offset = reset ? 0 : items.length;
      const page = await app.api(`/rooms/${encodeURIComponent(room.id)}/resources?limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: { "x-session-id": LS.sessionID },
      });
      if (request !== generation || app.state.room?.id !== room.id) return;
      const seen = new Set(items.map((item) => item.id));
      for (const resource of Array.isArray(page.resources) ? page.resources : []) {
        if (!resource || typeof resource.id !== "string" || seen.has(resource.id)) continue;
        seen.add(resource.id);
        items.push(resource);
      }
      total = Number(page.total) || items.length;
      render();
    } catch {
      if (request !== generation) return;
      showError("filesLoadFailed");
      summary.textContent = "";
      empty.hidden = true;
    } finally {
      if (request === generation) setBusy(false);
    }
  };

  const hiddenState = () => {
    empty.hidden = true;
    more.hidden = true;
    hideError();
  };

  const open = () => {
    if (!app.state.room) return;
    if (dialog.open) { heading.focus(); return; }
    app.closePanels?.();
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body && !$("#roomOptions")?.contains(active)
      ? active : $("#btnRoomOptions");
    select.value = "all";
    generation++;
    loading = false;
    items = [];
    total = 0;
    list.textContent = "";
    hiddenState();
    closePreview();
    summary.textContent = app.t("filesLoading");
    roomName.textContent = app.state.room.name ? ` · ${app.state.room.name}` : "";
    dialog.showModal();
    heading.focus();
    Promise.resolve(app.loadManageableMembers?.()).then(() => { if (dialog.open && items.length) render(); });
    void load(true);
  };
  app.openFilesDialog = open;

  const close = () => { if (dialog.open) dialog.close(); };

  trigger?.addEventListener("click", () => { app.closePanels(); open(); });
  $("#btnCloseFiles")?.addEventListener("click", close);
  $("#btnRefreshFiles")?.addEventListener("click", () => void load(true));
  more.addEventListener("click", () => void load(false));
  select.addEventListener("change", render);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => {
    generation++;
    loading = false;
    setBusy(false);
    previewToken++;
    closePreview();
    items = [];
    total = 0;
    list.textContent = "";
    empty.hidden = true;
    more.hidden = true;
    hideError();
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-file-action]");
    if (!button || !list.contains(button)) return;
    const row = button.closest(".file-row");
    const resource = items.find((item) => item.id === row?.dataset.resourceId);
    if (!resource) return;
    const action = button.dataset.fileAction;
    if (action === "preview") void togglePreview(resource, row, button);
    else if (action === "download") void download(resource);
    else if (action === "delete") void removeResource(resource);
  });
  document.addEventListener("chat-room-activated", () => {
    if (dialog.open) close();
    closePreview();
    items = [];
    total = 0;
    generation++;
  });

  const applyLocale = app.applyLocale;
  app.applyLocale = () => {
    applyLocale();
    if (!dialog.open) return;
    roomName.textContent = app.state.room?.name ? ` · ${app.state.room.name}` : "";
    render();
  };
}