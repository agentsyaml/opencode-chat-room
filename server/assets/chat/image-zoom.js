// An image in a message opens full-screen in a native dialog. Nothing in the
// message list moves: the overlay is a top-layer dialog, not a row change.
export function initImageZoom(app) {
  const dialog = app.$("#imageDialog"), preview = app.$("#imageDialogImage");
  let trigger = null;
  const imageOf = (node) => node?.closest?.("#msgList img, #attachmentList img");
  function open(image) {
    if (!image || !dialog) return;
    trigger = image;
    // Reuse the URL the list already loaded, so the overlay costs no second download.
    preview.src = image.currentSrc || image.src;
    preview.alt = image.alt || "";
    dialog.showModal();
  }
  const close = () => { if (dialog.open) dialog.close(); };
  // A click that focuses the image makes the browser scroll it into view; the
  // overlay must leave the thread exactly where the reader left it.
  for (const selector of ["#msgList", "#attachmentList"]) app.$(selector)?.addEventListener("mousedown", (event) => {
    if (imageOf(event.target)) event.preventDefault();
  });
  for (const selector of ["#msgList", "#attachmentList"]) app.$(selector)?.addEventListener("click", (event) => {
    const image = imageOf(event.target);
    if (!image) return;
    // An image wrapped in a link is zoomed, not followed.
    event.preventDefault();
    open(image);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const image = imageOf(event.target);
    if (!image) return;
    event.preventDefault();
    open(image);
  });
  app.$("#btnCloseImage")?.addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => {
    preview.removeAttribute("src");
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  });
  // Images are in the tab order so the overlay can hand focus back to them.
  const enhance = () => {
    for (const image of document.querySelectorAll("#msgList img, #attachmentList img")) {
      if (image.hasAttribute("tabindex")) continue;
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.dataset.i18nAriaLabel = "zoomImage";
      image.setAttribute("aria-label", app.t("zoomImage"));
    }
  };
  for (const selector of ["#msgList", "#attachmentList"]) {
    const list = app.$(selector);
    if (list) new MutationObserver(enhance).observe(list, { childList: true, subtree: true });
  }
  enhance();
}
