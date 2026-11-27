// Panel and key-dialog plumbing: every overlay closes the same way.
const PANEL_DEFAULTS = { announcements: "dialog", files: "dialog", tasks: "pane", reminders: "dialog" };
const PANEL_MODES = ["dialog", "pane"];
const PANE_QUERY = "(min-width: 1100px) and (min-height: 560px)";

export function initPanels(app) {
  const $ = app.$;
  const pane = matchMedia(PANE_QUERY);
  const watchers = new Map(), surfaces = new Map(), dismissibles = new Map();
  const readModes = () => {
    const stored = app.LS.panelMode;
    return Object.fromEntries(Object.entries(PANEL_DEFAULTS)
      .map(([kind, fallback]) => [kind, PANEL_MODES.includes(stored[kind]) ? stored[kind] : fallback]));
  };
  const notify = (kind) => { for (const watcher of watchers.get(kind) || []) watcher(); };
  app.panelMode = (kind) => readModes()[kind] || "dialog";
  app.panelPlacement = (kind) => app.panelMode(kind) === "pane" && pane.matches ? "pane" : "dialog";
  app.watchPanel = (kind, watcher) => {
    if (!watchers.has(kind)) watchers.set(kind, new Set());
    watchers.get(kind).add(watcher);
  };
  app.setPanelMode = (kind, mode) => {
    if (!Object.hasOwn(PANEL_DEFAULTS, kind)) return;
    const next = PANEL_MODES.includes(mode) ? mode : PANEL_DEFAULTS[kind];
    app.LS.panelMode = { ...readModes(), [kind]: next };
    // Settings is modal; layout changes behind it wait until it closes.
    if (!app.settingsOpen?.()) notify(kind);
  };
  app.registerPanelSurface = (kind, handlers) => {
    surfaces.set(kind, handlers);
    dismissibles.set(kind, handlers);
  };
  app.registerDismissibleSurface = (id, handlers) => dismissibles.set(id, handlers);
  app.closeOtherPanelSurfaces = (except) => {
    for (const [kind, surface] of surfaces) if (kind !== except) surface.close?.(false);
    app.closeDocPreview?.(false);
  };
  // Alt+Esc closes the top right-hand surface. A modal dialog above it keeps
  // ownership of the key, and IME composition never closes the pane.
  app.dismissTopSurface = () => {
    const top = [...dismissibles.values()].find((surface) => surface.element?.open && surface.element.getClientRects().length);
    if (!top) return false;
    if ([...document.querySelectorAll("dialog[open]:modal")].some((dialog) => dialog !== top.element)) return "blocked";
    top.close?.(true);
    return "closed";
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "Escape" && event.code !== "Escape") return;
    if (!app.dismissTopSurface()) return;
    event.preventDefault();
  });
  pane.addEventListener("change", () => {
    // Keep the settings modal on top; its close listener re-syncs every surface.
    if (app.settingsOpen?.()) return;
    for (const kind of watchers.keys()) notify(kind);
  });
  $("#chatSettings")?.addEventListener("close", () => { for (const kind of watchers.keys()) notify(kind); });
  app.closePanels = () => {
    document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = true; });
    $("#btnMembers").setAttribute("aria-expanded", "false");
    $("#btnRoomOptions").setAttribute("aria-expanded", "false");
  };
  app.togglePanel = (selector) => {
    const panel = $(selector), wasHidden = panel.hidden;
    app.closePanels();
    panel.hidden = !wasHidden;
    const trigger = $(selector === "#memberPanel" ? "#btnMembers" : "#btnSettings");
    trigger.setAttribute("aria-expanded", String(wasHidden));
    if (wasHidden) {
      app.lastFocus = trigger;
      if (selector === "#memberPanel") void app.loadManageableMembers();
      const heading = panel.querySelector("h3");
      heading.tabIndex = -1;
      heading.focus();
    }
  };
  app.openTokenBox = () => {
    const box = $("#tokenBox");
    if (!box.open) box.showModal();
    $("#inToken").focus();
  };
}
