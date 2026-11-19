// The shortcut sheet lists genuine ChatRoom shortcuts. Alt+/ opens it; the
// composer keeps one visible entry and no per-control badges.
export function initShortcuts(app) {
  const dialog = app.$("#shortcutsDialog");
  if (!dialog) return;
  const heading = app.$("#shortcutsHeading");
  const thread = app.$("#thread");
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Option" : "Alt";
  document.body.classList.toggle("is-mac", modifier === "Option");
  document.querySelectorAll(".shortcut-mod").forEach((key) => { key.textContent = modifier; });
  const lead = app.$("#shortcutsLead");
  if (lead) {
    lead._i18nValues = { modifier };
    lead.textContent = app.t("shortcutsLead", { modifier });
  }

  const openSheet = () => {
    if (dialog.open || document.querySelector("dialog[open]")) return;
    app.closePanels?.();
    app.closeMention?.();
    dialog.showModal();
    heading?.focus();
  };

  app.$("#btnShortcuts")?.addEventListener("mousedown", (event) => event.preventDefault());
  app.$("#btnShortcuts")?.addEventListener("click", openSheet);
  app.$("#btnCloseShortcuts")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => requestAnimationFrame(() => app.focusComposer?.()));
  const scrollToEdge = (bottom) => {
    if (!thread) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    app.state.userScrollIntentUntil = performance.now() + 700;
    if (!bottom) {
      app.state.jumpToLoadedTop = true;
      clearTimeout(app.state.jumpToLoadedTopTimer);
      app.state.jumpToLoadedTopTimer = setTimeout(() => { app.state.jumpToLoadedTop = false; }, reduced ? 100 : 800);
    }
    thread.scrollTop = bottom ? thread.scrollHeight : 0;
    app.animateThreadJump?.(bottom);
  };
  app.animateThreadJump = (bottom) => {
    const list = app.$("#msgList");
    if (!list) return;
    list.classList.remove("thread-jump-up", "thread-jump-down");
    void list.offsetWidth;
    list.classList.add(bottom ? "thread-jump-down" : "thread-jump-up");
  };
  app.animateRoomSwitch = (direction) => {
    const list = app.$("#msgList");
    if (!list) return;
    list.classList.remove("room-switch-next", "room-switch-prev");
    void list.offsetWidth;
    list.classList.add(direction > 0 ? "room-switch-next" : "room-switch-prev");
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Home" || event.code === "Home") { event.preventDefault(); scrollToEdge(false); return; }
    if (event.key === "End" || event.code === "End") { event.preventDefault(); scrollToEdge(true); return; }
    if (event.key !== "/" && event.code !== "Slash") return;
    event.preventDefault();
    openSheet();
  });
}