// The shortcut sheet lists genuine ChatRoom shortcuts. Alt+/ opens it; no
// per-control badges, no native Tab/Enter hints, and no background observers.
export function initShortcuts(app) {
  const dialog = app.$("#shortcutsDialog");
  if (!dialog) return;
  const heading = app.$("#shortcutsHeading");
  const thread = app.$("#thread");
  const triggers = [...document.querySelectorAll("[data-shortcuts]")];

  const openSheet = () => {
    if (dialog.open || document.querySelector("dialog[open]")) return;
    app.closePanels?.();
    app.closeMention?.();
    dialog.showModal();
    heading?.focus();
  };

  triggers.forEach((button) => button.addEventListener("click", openSheet));
  app.$("#btnCloseShortcuts")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => requestAnimationFrame(() => app.focusComposer?.()));
  const scrollToEdge = (bottom) => {
    if (!thread) return;
    app.state.userScrollIntentUntil = performance.now() + 700;
    if (!bottom) {
      app.state.jumpToLoadedTop = true;
      setTimeout(() => { app.state.jumpToLoadedTop = false; }, 100);
    }
    thread.scrollTop = bottom ? thread.scrollHeight : 0;
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