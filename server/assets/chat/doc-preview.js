// Markdown resources open in a reading pane on wide screens, or in a modal overlay
// when the window is too narrow or too short to give the chat a usable column.
import { formatBytes, renderMarkdown } from "./markdown.js";
import { docPreviewFormat, TEXT_PREVIEW_LIMIT } from "./resource-format.js";
import { createCopyButton, copyResourceText } from "./copy-action.js";

const PANE_QUERY = "(min-width: 1100px) and (min-height: 560px)";

export function initDocPreview(app) {
  const dialog = app.$("#docPreview");
  if (!dialog) return;
  const title = app.$("#docPreviewTitle"), size = app.$("#docPreviewSize");
  const status = app.$("#docPreviewStatus"), body = app.$("#docPreviewBody");
  const empty = app.$("#docPreviewEmpty"), download = app.$("#btnDocPreviewDownload");
  const languageLabel = app.$("#docPreviewLanguage"), notice = app.$("#docPreviewNotice");
  const eyebrow = app.$("#docPreviewEyebrow");
  const chatView = app.$("#chatView"), pane = matchMedia(PANE_QUERY);
  let current = null, blob = null, objectUrl = null, token = 0, opener = null, pendingReopen = false, restoreOnClose = true;
  let rawText = "";

  const copyButton = createCopyButton(app, "doc-preview-copy");
  copyButton.id = "btnDocPreviewCopy";
  copyButton.hidden = true;
  download.before(copyButton);
  copyButton.addEventListener("click", () => {
    const target = current;
    if (!target) return;
    void copyResourceText(copyButton, app, async () => {
      // The preview already owns the raw text; over-cap files fail instead of fetching.
      if (Number(target.resource.size) > TEXT_PREVIEW_LIMIT) return "";
      return rawText;
    });
  });
  const resetCopy = () => {
    clearTimeout(copyButton._copyFeedbackTimer);
    copyButton.classList.remove("is-copied", "is-copy-failed");
    copyButton.setAttribute("aria-label", app.t("copyMessage"));
    copyButton.title = app.t("copyMessage");
    const feedback = copyButton.querySelector(".copy-feedback");
    if (feedback) feedback.textContent = "";
  };

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

  const contentPath = (roomId, id) => `/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}/content`;

  const clearFrame = () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    dialog.classList.remove("is-pdf");
  };

  const renderText = (text, format) => {
    copyButton.hidden = false;
    languageLabel.textContent = format.label || "";
    languageLabel.hidden = !format.label;
    if (!text) { empty.hidden = false; return; }
    const pre = document.createElement("pre");
    pre.className = "code-block doc-code";
    const code = document.createElement("code");
    code.className = format.language ? `hljs language-${format.language}` : "hljs";
    code.textContent = text;
    if (format.language && window.hljs?.getLanguage?.(format.language)) {
      try { code.innerHTML = window.hljs.highlight(text, { language: format.language }).value; } catch { /* Keep escaped text. */ }
    }
    pre.append(code);
    body.append(pre);
    empty.hidden = true;
  };

  const showTooLarge = (format) => {
    clearFrame();
    copyButton.hidden = false;
    body.textContent = "";
    empty.hidden = true;
    languageLabel.textContent = format.label || "";
    languageLabel.hidden = !format.label;
    notice.textContent = app.t("docPreviewTooLarge");
    notice.dataset.i18n = "docPreviewTooLarge";
    notice.hidden = false;
    status.textContent = "";
    // The blob is fetched on click, so a huge file still downloads.
    download.disabled = false;
  };

  const renderPdf = (resource, data) => {
    copyButton.hidden = true;
    const pdf = data.type === "application/pdf" ? data : data.slice(0, data.size, "application/pdf");
    objectUrl = URL.createObjectURL(pdf);
    const frame = document.createElement("iframe");
    frame.className = "doc-pdf-frame";
    frame.title = resource.name;
    frame.src = objectUrl;
    frame.addEventListener("error", () => {
      clearFrame();
      body.textContent = "";
      status.textContent = app.t("docPreviewFailed");
      download.disabled = false;
    }, { once: true });
    body.textContent = "";
    body.append(frame);
    dialog.classList.add("is-pdf");
    languageLabel.textContent = "PDF";
    languageLabel.hidden = false;
    empty.hidden = true;
    notice.hidden = true;
    status.textContent = "";
    download.disabled = false;
  };

  const open = async (roomId, resource, source) => {
    opener = source instanceof HTMLElement ? source : null;
    restoreOnClose = true;
    current = { roomId, resource };
    const request = ++token;
    const format = docPreviewFormat(resource) || { kind: "markdown", language: "", label: "" };
    blob = null;
    rawText = "";
    copyButton.hidden = true;
    resetCopy();
    clearFrame();
    const eyebrowKey = format.kind === "markdown" ? "docPreviewEyebrow" : "docPreviewFileEyebrow";
    eyebrow.dataset.i18n = eyebrowKey;
    eyebrow.textContent = app.t(eyebrowKey);
    title.textContent = resource.name;
    size.textContent = formatBytes(resource.size);
    status.textContent = app.t("resourceLoading");
    body.textContent = "";
    empty.hidden = true;
    notice.hidden = true;
    notice.textContent = "";
    delete notice.dataset.i18n;
    languageLabel.hidden = true;
    languageLabel.textContent = "";
    download.disabled = true;
    if (app.preserveReadingLayout) await app.preserveReadingLayout(show);
    else show();
    if (request !== token) return;
    title.focus({ preventScroll: true });
    const textual = format.kind !== "pdf";
    if (textual && Number(resource.size) > TEXT_PREVIEW_LIMIT) { showTooLarge(format); return; }
    try {
      const data = await app.apiBlob(contentPath(roomId, resource.id));
      if (request !== token) return;
      blob = data;
      if (textual && data.size > TEXT_PREVIEW_LIMIT) { showTooLarge(format); return; }
      if (format.kind === "pdf") { renderPdf(resource, data); return; }
      const text = await data.text();
      if (request !== token) return;
      rawText = text;
      if (format.kind === "text") renderText(text, format);
      else {
        renderMarkdown(body, text, app);
        empty.hidden = body.children.length > 0;
        copyButton.hidden = false;
      }
      status.textContent = "";
      download.disabled = false;
    } catch {
      if (request === token) {
        clearFrame();
        copyButton.hidden = true;
        status.textContent = app.t("docPreviewFailed");
      }
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

  const downloadDocument = async () => {
    const target = current;
    if (!target) return;
    let data = blob;
    if (!data) {
      download.disabled = true;
      try {
        data = await app.apiBlob(contentPath(target.roomId, target.resource.id));
        if (current !== target) return;
        blob = data;
      } catch {
        if (current === target) status.textContent = app.t("docPreviewFailed");
        return;
      } finally {
        if (current === target) download.disabled = false;
      }
    }
    const url = URL.createObjectURL(data), link = document.createElement("a");
    link.href = url;
    link.download = String(target.resource.name).replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "download";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  app.openDocPreview = (roomId, resource, source) => { void open(roomId, resource, source); };
  app.closeDocPreview = (restoreFocus = true) => close(restoreFocus);

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
    current = null; blob = null; rawText = "";
    copyButton.hidden = true;
    resetCopy();
    clearFrame();
    chatView.classList.remove("has-doc");
    dialog.classList.remove("is-pane");
    title.textContent = ""; size.textContent = ""; status.textContent = "";
    body.textContent = ""; empty.hidden = true; download.disabled = true;
    languageLabel.hidden = true; languageLabel.textContent = "";
    notice.hidden = true; notice.textContent = ""; delete notice.dataset.i18n;
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