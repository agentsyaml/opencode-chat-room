// Markdown resources open in a reading pane on wide screens, or in a modal overlay
// when the window is too narrow or too short to give the chat a usable column.
import { formatBytes, renderMarkdown } from "./markdown.js";

const PANE_QUERY = "(min-width: 1100px) and (min-height: 560px)";

export function initDocPreview(app) {
  const dialog = app.$("#docPreview");
  if (!dialog) return;
  const title = app.$("#docPreviewTitle"), size = app.$("#docPreviewSize");
  const status = app.$("#docPreviewStatus"), body = app.$("#docPreviewBody");
  const empty = app.$("#docPreviewEmpty"), download = app.$("#btnDocPreviewDownload");
  const chatView = app.$("#chatView"), pane = matchMedia(PANE_QUERY);
  let current = null, blob = null, token = 0, opener = null, pendingReopen = false, restoreOnClose = true;

  const show = () => {
    if (pane.matches) {
      dialog.classList.add("is-pane");
      chatView.classList.add("has-doc");
      if (!dialog.open) dialog.show();
    } else {
      dialog.classList.remove("is-pane");
      chatView.classList.remove("has-doc");
      if (!dialog.open) dialog.showModal();
    }
  };

  // Crossing the breakpoint keeps the document: the pane becomes an overlay, or back.
  const syncMode = () => {
    if (!dialog.open || pane.matches === dialog.classList.contains("is-pane")) return;
    pendingReopen = true;
    dialog.close();
    show();
    title.focus({ preventScroll: true });
  };

  const open = async (roomId, resource, source) => {
    opener = source instanceof HTMLElement ? source : null;
    restoreOnClose = true;
    current = { roomId, resource };
    const request = ++token;
    blob = null;
    title.textContent = resource.name;
    size.textContent = formatBytes(resource.size);
    status.textContent = app.t("resourceLoading");
    body.textContent = "";
    empty.hidden = true;
    download.disabled = true;
    if (app.preserveReadingLayout) await app.preserveReadingLayout(show);
    else show();
    if (request !== token) return;
    title.focus({ preventScroll: true });
    try {
      const data = await app.apiBlob(`/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(resource.id)}/content`);
      if (request !== token) return;
      const text = await data.text();
      if (request !== token) return;
      blob = data;
      renderMarkdown(body, text, app);
      empty.hidden = body.children.length > 0;
      status.textContent = "";
      download.disabled = false;
    } catch {
      if (request === token) status.textContent = app.t("docPreviewFailed");
    }
  };

  const close = (restoreFocus = true) => {
    restoreOnClose = restoreFocus;
    if (!restoreFocus) opener = null;
    // Remove the column class now; the queued close event must not leave Tasks
    // hidden behind a column the task pane is about to take back.
    chatView.classList.remove("has-doc");
    if (dialog.open) dialog.close();
    else restoreOnClose = true;
  };

  const downloadDocument = () => {
    if (!blob || !current) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = String(current.resource.name).replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "download";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  app.openDocPreview = (roomId, resource, source) => { void open(roomId, resource, source); };
  app.closeDocPreview = () => close();

  app.$("#btnCloseDocPreview")?.addEventListener("click", () => close());
  download.addEventListener("click", downloadDocument);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !dialog.classList.contains("is-pane")) close();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.open || !dialog.classList.contains("is-pane")) return;
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    // A breakpoint switch closes and reopens the same dialog; its queued close event
    // must not wipe the document that is already back on screen.
    if (pendingReopen) { pendingReopen = false; restoreOnClose = true; return; }
    const shouldRestore = restoreOnClose;
    restoreOnClose = true;
    token++;
    current = null; blob = null;
    chatView.classList.remove("has-doc");
    dialog.classList.remove("is-pane");
    title.textContent = ""; size.textContent = ""; status.textContent = "";
    body.textContent = ""; empty.hidden = true; download.disabled = true;
    const target = opener; opener = null;
    if (!shouldRestore) return;
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    else app.focusChatComposer?.({ force: true });
  });
  const onChange = () => syncMode();
  if (pane.addEventListener) pane.addEventListener("change", onChange);
  else pane.addListener(onChange);
  document.addEventListener("chat-room-activated", () => close(false));
}