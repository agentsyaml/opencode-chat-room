// Markdown resources open in a reading pane on wide screens, or in a modal overlay
// when the window is too narrow or too short to give the chat a usable column.
import { formatBytes, renderMarkdown } from "./markdown.js";
import { docPreviewFormat, OFFICE_KINDS, OFFICE_PREVIEW_LIMIT, TEXT_PREVIEW_LIMIT } from "./resource-format.js";
import { createCopyButton, copyResourceText } from "./copy-action.js";
import { enhanceCodeElement } from "./shiki.js";

const PANE_QUERY = "(min-width: 1100px) and (min-height: 560px)";

export function initDocPreview(app) {
  const dialog = app.$("#docPreview");
  if (!dialog) return;
  const title = app.$("#docPreviewTitle"), size = app.$("#docPreviewSize");
  const status = app.$("#docPreviewStatus"), body = app.$("#docPreviewBody");
  const empty = app.$("#docPreviewEmpty"), download = app.$("#btnDocPreviewDownload");
  const languageLabel = app.$("#docPreviewLanguage"), notice = app.$("#docPreviewNotice");
  const eyebrow = app.$("#docPreviewEyebrow");
  const fullscreenButton = app.$("#btnDocPreviewFullscreen");
  const chatView = app.$("#chatView"), pane = matchMedia(PANE_QUERY);
  let current = null, blob = null, objectUrl = null, token = 0, opener = null, pendingReopen = false, restoreOnClose = true;
  let rawText = "", fullscreen = false, paneMode = false;
  let officeKind = null, officeRender = 0, pptxWidth = 0, pptxTimer = 0;

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

  const updateFullscreenButton = () => {
    if (!fullscreenButton) return;
    const key = fullscreen ? "docPreviewExitFullscreen" : "docPreviewFullscreen";
    fullscreenButton.dataset.i18nAriaLabel = key;
    fullscreenButton.dataset.i18nTitle = key;
    fullscreenButton.setAttribute("aria-label", app.t(key));
    fullscreenButton.title = app.t(key);
    fullscreenButton.querySelector("use")?.setAttribute("href", `/assets/fluent-icons.svg#fluent-${fullscreen ? "arrow_minimize" : "arrow_maximize"}-24`);
  };

  const show = () => {
    const targetPane = pane.matches && !fullscreen;
    dialog.classList.toggle("is-pane", targetPane);
    dialog.classList.toggle("is-fullscreen", fullscreen);
    chatView.classList.toggle("has-doc", targetPane);
    if (dialog.open && paneMode !== targetPane) {
      pendingReopen = true;
      dialog.close();
    }
    if (!dialog.open) {
      if (targetPane) dialog.show();
      else dialog.showModal();
    }
    paneMode = targetPane;
  };

  // Full screen is always a modal so the chat behind it stays inert; leaving it
  // returns to the pane or the plain modal according to the current window.
  const setFullscreen = (next) => {
    if (!dialog.open || fullscreen === next) return;
    fullscreen = next;
    document.body.classList.toggle("doc-preview-fullscreen", next);
    updateFullscreenButton();
    show();
    if (!dialog.open) return;
    if (next) title.focus({ preventScroll: true });
    else fullscreenButton?.focus({ preventScroll: true });
  };

  const leaveFullscreen = () => {
    fullscreen = false;
    document.body.classList.remove("doc-preview-fullscreen");
    dialog.classList.remove("is-fullscreen");
    updateFullscreenButton();
  };

  // Crossing the breakpoint keeps the document: the pane becomes an overlay, or back.
  const syncMode = () => {
    if (!dialog.open || fullscreen || pane.matches === paneMode) return;
    show();
    title.focus({ preventScroll: true });
  };

  const contentPath = (roomId, id) => `/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}/content`;

  const clearFrame = () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    dialog.classList.remove("is-pdf", "is-office");
  };

  const renderText = (text, format) => {
    copyButton.hidden = false;
    languageLabel.textContent = format.label || "";
    languageLabel.hidden = !format.label;
    if (!text) { empty.hidden = false; return; }
    const pre = document.createElement("pre");
    pre.className = "code-block doc-code";
    const code = document.createElement("code");
    code.className = format.language ? `language-${format.language}` : "";
    code.textContent = text;
    pre.append(code);
    body.append(pre);
    empty.hidden = true;
    void enhanceCodeElement(code);
  };

  const showTooLarge = (format) => {
    clearFrame();
    const office = OFFICE_KINDS.has(format.kind);
    copyButton.hidden = office;
    body.textContent = "";
    empty.hidden = true;
    languageLabel.textContent = office ? "" : format.label || "";
    languageLabel.hidden = office || !format.label;
    const key = office ? "docPreviewOfficeTooLarge" : "docPreviewTooLarge";
    notice.textContent = app.t(key);
    notice.dataset.i18n = key;
    notice.hidden = false;
    status.textContent = "";
    // The blob is fetched on click, so a huge file still downloads.
    download.disabled = false;
  };

  const renderOfficeDocument = async (kind, data, request, width = 0) => {
    officeKind = kind;
    const render = ++officeRender;
    dialog.classList.add("is-office");
    copyButton.hidden = true;
    languageLabel.hidden = true;
    body.textContent = "";
    empty.hidden = true;
    notice.hidden = true;
    // The blob is already here, so download stays available while parsing or after a failure.
    download.disabled = false;
    const module = await import("/assets/chat/office-preview.js");
    if (request !== token || render !== officeRender) return;
    await module.renderOffice(kind, data, body, {
      width: width || undefined,
      onProgress: () => { if (request === token && render === officeRender) status.textContent = app.t("resourceLoading"); },
    });
    if (request !== token || render !== officeRender) return;
    if (kind === "pptx") pptxWidth = Math.round(width || body.clientWidth);
    status.textContent = "";
    empty.hidden = body.children.length > 0;
  };

  // A fixed-width slide deck must be laid out again when the reading pane grows
  // (full screen, splitter drag, breakpoint change), or it stays pane-sized.
  const resizePptx = () => {
    if (!dialog.open || officeKind !== "pptx" || !blob) return;
    const width = Math.round(body.clientWidth);
    if (width < 200 || Math.abs(width - pptxWidth) < 8) return;
    clearTimeout(pptxTimer);
    pptxTimer = setTimeout(() => {
      if (dialog.open && officeKind === "pptx" && blob) {
        void renderOfficeDocument("pptx", blob, token, width);
      }
    }, 150);
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(resizePptx).observe(body);

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
    officeKind = null;
    pptxWidth = 0;
    clearTimeout(pptxTimer);
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
    const office = OFFICE_KINDS.has(format.kind);
    officeKind = office ? format.kind : null;
    const limit = office ? OFFICE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT;
    if (format.kind !== "pdf" && Number(resource.size) > limit) { showTooLarge(format); return; }
    try {
      const data = await app.apiBlob(contentPath(roomId, resource.id));
      if (request !== token) return;
      blob = data;
      if (format.kind !== "pdf" && data.size > limit) { showTooLarge(format); return; }
      if (format.kind === "pdf") { renderPdf(resource, data); return; }
      if (office) { await renderOfficeDocument(format.kind, data, request); return; }
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
        body.textContent = "";
        empty.hidden = true;
        copyButton.hidden = true;
        if (office) {
          status.textContent = "";
          notice.textContent = app.t("docPreviewOfficeFailed");
          notice.dataset.i18n = "docPreviewOfficeFailed";
          notice.hidden = false;
          download.disabled = false;
        } else status.textContent = app.t("docPreviewFailed");
      }
    }
  };

  const close = (restoreFocus = true) => {
    restoreOnClose = restoreFocus;
    if (!restoreFocus) opener = null;
    // Closing from full screen leaves the locked page as part of the same step.
    if (fullscreen) leaveFullscreen();
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
  updateFullscreenButton();

  app.$("#btnCloseDocPreview")?.addEventListener("click", () => close());
  fullscreenButton?.addEventListener("click", () => setFullscreen(!fullscreen));
  download.addEventListener("click", downloadDocument);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !fullscreen && !dialog.classList.contains("is-pane")) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    // The first Esc leaves full screen; the next one closes the preview.
    if (fullscreen) setFullscreen(false);
    else close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.open || fullscreen || !dialog.classList.contains("is-pane")) return;
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
    leaveFullscreen();
    officeRender++;
    officeKind = null;
    pptxWidth = 0;
    clearTimeout(pptxTimer);
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