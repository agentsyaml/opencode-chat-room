// An image in a message opens full-screen in a native dialog. Nothing in the
// message list moves: the overlay is a top-layer dialog, not a row change.
export function initImageZoom(app) {
  const dialog = app.$("#imageDialog"), preview = app.$("#imageDialogImage");
  const zoomLevel = app.$("#zoomLevel"), zoomOut = app.$("#btnZoomOut"), zoomIn = app.$("#btnZoomIn"), zoomReset = app.$("#btnZoomReset");
  const MAX = 4, STEP = 1.25;
  let trigger = null, scale = 1, fitScale = 1, pendingFit = false, panX = 0, panY = 0, drag = null;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const imageOf = (node) => node?.closest?.("#msgList img, #attachmentList img");
  function fitLimit() {
    const style = getComputedStyle(dialog);
    const width = dialog.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = dialog.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!preview.naturalWidth || !preview.naturalHeight) return 1;
    return Math.min(1, width / preview.naturalWidth, height / preview.naturalHeight);
  }
  function limits() {
    const style = getComputedStyle(dialog);
    const box = dialog.getBoundingClientRect();
    const left = box.left + parseFloat(style.paddingLeft), right = box.right - parseFloat(style.paddingRight);
    const top = box.top + parseFloat(style.paddingTop), bottom = box.bottom - parseFloat(style.paddingBottom);
    // Flex centering keeps an oversized image centered, so its untransformed
    // layout box may start outside the dialog; offsetLeft still gives that
    // position, while the live rect reflects the current scale and pan.
    const layoutLeft = box.left + parseFloat(style.borderLeftWidth) + preview.offsetLeft;
    const layoutTop = box.top + parseFloat(style.borderTopWidth) + preview.offsetTop;
    const scaledWidth = preview.offsetWidth * scale, scaledHeight = preview.offsetHeight * scale;
    const baseLeft = layoutLeft + preview.offsetWidth / 2 - scaledWidth / 2;
    const baseTop = layoutTop + preview.offsetHeight / 2 - scaledHeight / 2;
    const fitsX = scaledWidth <= right - left, fitsY = scaledHeight <= bottom - top;
    const minX = fitsX ? 0 : right - baseLeft - scaledWidth;
    const maxX = fitsX ? 0 : left - baseLeft;
    const minY = fitsY ? 0 : bottom - baseTop - scaledHeight;
    const maxY = fitsY ? 0 : top - baseTop;
    return { minX, maxX, minY, maxY, x: maxX - minX, y: maxY - minY };
  }
  function apply() {
    const limit = limits();
    panX = clamp(panX, limit.minX, limit.maxX); panY = clamp(panY, limit.minY, limit.maxY);
    preview.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`;
    preview.classList.toggle("is-zoomed", limit.x > 0 || limit.y > 0);
    if (zoomLevel) zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    if (zoomOut) zoomOut.disabled = scale <= fitScale + .001;
    if (zoomIn) zoomIn.disabled = scale >= MAX - .001;
  }
  function zoomTo(next, x = innerWidth / 2, y = innerHeight / 2) {
    const target = clamp(next, fitScale, MAX);
    if (Math.abs(target - scale) < .001) return apply();
    // Keep the point under the pointer fixed while scaling.
    const dx = x - innerWidth / 2, dy = y - innerHeight / 2, ratio = target / scale;
    panX = dx - ratio * (dx - panX); panY = dy - ratio * (dy - panY);
    scale = target;
    if (scale <= fitScale + .001) { scale = fitScale; panX = 0; panY = 0; }
    preview.style.animation = "none";
    apply();
  }
  const zoomBy = (factor) => zoomTo(scale * factor);
  function resetZoom() {
    fitScale = fitLimit(); scale = fitScale; pendingFit = false; panX = 0; panY = 0; apply();
  }
  function open(image) {
    if (!image || !dialog) return;
    trigger = image;
    dialog.showModal();
    // Reuse the URL the list already loaded, so the overlay costs no second download.
    preview.src = image.currentSrc || image.src;
    preview.alt = image.alt || "";
    preview.style.animation = "";
    scale = 1; panX = 0; panY = 0; fitScale = fitLimit();
    pendingFit = !(preview.complete && preview.naturalWidth);
    if (pendingFit) apply(); else resetZoom();
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
  // The viewer owns the wheel while it is open so the thread behind it cannot scroll.
  dialog.addEventListener("wheel", (event) => {
    if (!dialog.open) return;
    event.preventDefault();
    if (event.target.closest?.(".image-dialog-tools, .image-dialog-close")) return;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomTo(scale * Math.exp(-delta * .0015), event.clientX, event.clientY);
  }, { passive: false });
  dialog.addEventListener("keydown", (event) => {
    if (!dialog.open) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(STEP); }
    else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomBy(1 / STEP); }
    else if (event.key === "0") { event.preventDefault(); resetZoom(); }
    else if ((limits().x > 0 || limits().y > 0) && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const step = event.shiftKey ? 120 : 40;
      if (event.key === "ArrowLeft") panX += step;
      else if (event.key === "ArrowRight") panX -= step;
      else if (event.key === "ArrowUp") panY += step;
      else panY -= step;
      apply();
    }
  });
  zoomIn?.addEventListener("click", () => zoomBy(STEP));
  zoomOut?.addEventListener("click", () => zoomBy(1 / STEP));
  zoomReset?.addEventListener("click", resetZoom);
  window.addEventListener("resize", () => {
    if (!dialog.open) return;
    const wasFit = Math.abs(scale - fitScale) < .001;
    fitScale = fitLimit();
    if (wasFit) { scale = fitScale; panX = 0; panY = 0; }
    else scale = Math.max(scale, fitScale);
    apply();
  });
  preview.addEventListener("load", () => { if (dialog.open && pendingFit) resetZoom(); });
  // Pointer dragging pans the zoomed image; the tool buttons are the touch and
  // keyboard alternative for changing the scale, and arrow keys pan to the edges.
  preview.draggable = false;
  preview.addEventListener("pointerdown", (event) => {
    if ((limits().x <= 0 && limits().y <= 0) || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
    preview.setPointerCapture(event.pointerId);
    preview.classList.add("is-dragging");
    event.preventDefault();
  });
  preview.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    panX = drag.panX + event.clientX - drag.x; panY = drag.panY + event.clientY - drag.y;
    apply();
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; preview.classList.remove("is-dragging");
    if (preview.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId);
  };
  preview.addEventListener("pointerup", endDrag);
  preview.addEventListener("pointercancel", endDrag);
  dialog.addEventListener("close", () => {
    preview.removeAttribute("src");
    preview.style.animation = "";
    resetZoom();
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