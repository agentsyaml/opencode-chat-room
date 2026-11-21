// One shared confirmation dialog replaces the browser's native confirmation
// window, so a destructive action stays inside the page.
export function initConfirmDialog(app) {
  const dialog = app.$("#confirmDialog"), message = app.$("#confirmMessage");
  const accept = app.$("#btnAcceptConfirm"), cancel = app.$("#btnCancelConfirm");
  let pending = null, opener = null;
  const settle = (value) => { const resolve = pending; pending = null; resolve?.(value); };
  function close(value) { settle(value); dialog.close(); }

  app.confirmAction = (text) => {
    // One dialog at a time: a newer request dismisses the open one as cancelled.
    if (dialog.open) close(false);
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    message.textContent = text;
    dialog.showModal();
    cancel.focus();
    return new Promise((resolve) => { pending = resolve; });
  };

  accept.addEventListener("click", () => close(true));
  cancel.addEventListener("click", () => close(false));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(false); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(false); });
  dialog.addEventListener("close", () => {
    // A close from outside the buttons still settles the promise; a re-open in the
    // same task leaves the dialog open, so the stale event must not clear it.
    if (dialog.open) return;
    settle(false);
    message.textContent = "";
    const target = opener;
    opener = null;
    requestAnimationFrame(() => {
      if (dialog.open) return;
      if (app.focusChatComposer?.({ force: true })) return;
      if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    });
  });
}