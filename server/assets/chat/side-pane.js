// Resizes the right-hand pane (Markdown preview or task board) on wide windows.
// --side-pane-width holds the only width; the rail keeps its 252px column and the
// chat column never shrinks below MIN_CHAT.
const STORAGE_KEY = "chat.sidePaneWidth";
const MIN_WIDTH = 360;
const MIN_CHAT = 420;
const WIDE_TASKS_MIN_CHAT = 700;
const RAIL_WIDTH = 252;
const GUTTER = 8;
const MAX_WIDTH = 960;

export function initSidePaneSplitter(app) {
  const view = app.$("#chatView");
  const handle = app.$("#sidePaneHandle");
  const preview = app.$("#docPreview");
  const tasks = app.$("#tasksDialog");
  if (!view || !handle) return;

  let stored = readStored();
  let applied = 0;
  let frame = 0;
  let pending = 0;
  let drag = null;

  const activePane = () => view.classList.contains("has-doc") ? preview
    : view.classList.contains("has-tasks") ? tasks : null;

  // A wide task board must leave the conversation a full working column; the
  // Markdown preview keeps the normal minimum.
  const wideTasks = () => view.classList.contains("has-tasks") && !view.classList.contains("has-doc")
    && window.matchMedia("(min-width: 1500px) and (min-height: 900px)").matches;
  const minChat = () => wideTasks() ? WIDE_TASKS_MIN_CHAT : MIN_CHAT;

  const maxWidth = () => {
    const available = view.clientWidth - RAIL_WIDTH - GUTTER - minChat();
    return Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, MAX_WIDTH, available));
  };
  const clamp = (width) => Math.max(MIN_WIDTH, Math.min(width, maxWidth()));

  const syncAria = () => {
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    handle.setAttribute("aria-valuemax", String(Math.round(maxWidth())));
    const pane = activePane();
    if (pane?.open) {
      handle.setAttribute("aria-valuenow", String(Math.round(pane.getBoundingClientRect().width)));
    }
  };

  const apply = (width) => {
    applied = Math.round(width);
    view.style.setProperty("--side-pane-width", `${applied}px`);
    syncAria();
  };

  // Pane classes change on open, close, and breakpoint switches; the hidden
  // attribute changes when the workspace first appears.
  const reflow = () => {
    if (!view.clientWidth) return;
    if (stored == null) syncAria();
    else apply(clamp(stored));
  };

  const setWidth = (width) => {
    const next = clamp(width);
    apply(next);
    return next;
  };

  const persist = (width) => {
    stored = Math.round(width);
    try { localStorage.setItem(STORAGE_KEY, String(stored)); } catch { /* The width still applies for this page. */ }
  };

  handle.addEventListener("pointerdown", (event) => {
    const pane = activePane();
    if (event.button !== 0 || !pane?.open) return;
    drag = { pointerId: event.pointerId, x: event.clientX, width: pane.getBoundingClientRect().width };
    applied = Math.round(drag.width);
    pending = drag.width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing-pane");
    handle.focus({ preventScroll: true });
  });

  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Dragging left widens the right-hand pane; the divider follows the pointer.
    pending = clamp(drag.width - (event.clientX - drag.x));
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      apply(pending);
    });
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    apply(pending);
    persist(applied);
    drag = null;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-pane");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  handle.addEventListener("keydown", (event) => {
    if (!activePane()?.open) return;
    const current = activePane().getBoundingClientRect().width;
    const step = event.shiftKey ? 64 : 16;
    let next;
    if (event.key === "ArrowRight") next = current - step;
    else if (event.key === "ArrowLeft") next = current + step;
    else if (event.key === "Home") next = MIN_WIDTH;
    else if (event.key === "End") next = maxWidth();
    else return;
    event.preventDefault();
    persist(setWidth(next));
  });

  handle.addEventListener("dblclick", () => {
    stored = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Ignore unavailable storage. */ }
    view.style.removeProperty("--side-pane-width");
    syncAria();
  });

  window.addEventListener("resize", reflow);
  new MutationObserver(reflow).observe(view, { attributes: true, attributeFilter: ["class", "hidden"] });
  reflow();
}

function readStored() {
  try {
    const width = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}