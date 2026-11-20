// The rail "+" opens a large modal instead of a small popover, so the create
// form has room for its name, join policy, and inline validation.
export function initCreateRoomDialog(app) {
  const dialog = app.$("#createRoomDialog");
  const input = app.$("#inRoomNameChat");
  const error = app.$("#createRoomError");
  const trigger = app.$("#btnNewRoom");
  if (!dialog || !input || !error || !trigger) return;
  let opener = null;
  let restoreFocus = true;

  const close = (restore = true) => {
    if (!dialog.open) return;
    restoreFocus = restore;
    trigger.setAttribute("aria-expanded", "false");
    dialog.close();
  };

  app.showCreateRoomError = (key, values = {}) => {
    app.setText(error, key, values);
    error.dataset.errorKey = key;
    error.hidden = false;
  };
  app.hideCreateRoomError = () => { error.hidden = true; delete error.dataset.errorKey; };
  app.openCreateRoomDialog = () => {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : trigger;
    app.hideCreateRoomError();
    if (!dialog.open) dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
  };
  app.closeCreateRoomDialog = (restore = true) => close(restore);

  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("cancel", () => trigger.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("close", () => {
    const target = opener;
    opener = null;
    trigger.setAttribute("aria-expanded", "false");
    app.hideCreateRoomError();
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
    restoreFocus = true;
  });
  app.$("#btnCloseCreateRoom")?.addEventListener("click", () => close());
  app.$("#btnCancelCreateRoom")?.addEventListener("click", () => close());
  input.addEventListener("input", app.hideCreateRoomError);
}