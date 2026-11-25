// Forwarding UI: the server lists configured targets, and a terminal system
// message reports the outcome. The dialog posts an explicit message ID and
// target; it never infers either from message text.
import { LS } from "./state.js";

const label = (target) => [target.platform, target.account, target.room].join(" / ");

export function initForward(app) {
  const dialog = app.$("#forwardDialog"), list = app.$("#forwardTargets"), status = app.$("#forwardStatus");
  const close = () => { if (dialog.open) dialog.close(); };
  app.$("#btnCloseForward").addEventListener("click", close);
  app.$("#btnCancelForward").addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => { status.textContent = ""; list.replaceChildren(); });

  async function send(roomId, messageId, target) {
    try {
      await app.api(`/rooms/${encodeURIComponent(roomId)}/forward`, {
        method: "POST",
        body: JSON.stringify({
          sessionID: LS.sessionID,
          messageId,
          target: { platform: target.platform, account: target.account, room: target.room },
        }),
      });
      return true;
    } catch (error) {
      status.textContent = app.t("forwardFailed", { message: error?.message || "" });
      return false;
    }
  }

  async function open(message, roomId) {
    let targets = [];
    try {
      const data = await app.api(`/rooms/${encodeURIComponent(roomId)}/forward-targets?sessionID=${encodeURIComponent(LS.sessionID)}`);
      targets = Array.isArray(data.targets) ? data.targets : [];
    } catch (error) {
      status.textContent = app.t(error?.status === 404 ? "forwardUnavailable" : "forwardLoadFailed");
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (targets.length === 0) {
      status.textContent = app.t("forwardNoTargets");
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (targets.length === 1) {
      if (!await app.confirmAction(app.t("forwardConfirm", { target: label(targets[0]) }))) return;
      if (!await send(roomId, message.id, targets[0])) dialog.showModal();
      return;
    }
    for (const target of targets) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "btn ghost small"; button.textContent = label(target);
      button.addEventListener("click", () => { void send(roomId, message.id, target).then((ok) => { if (ok) close(); }); });
      list.append(button);
    }
    dialog.showModal();
  }

  app.$("#msgList").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-forward-message]");
    const room = app.state.room;
    if (!button || !room) return;
    const message = room.messages.find((item) => item.id === button.dataset.forwardMessage);
    if (message) void open(message, room.id);
  });
}