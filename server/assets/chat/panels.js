// Panel and key-dialog plumbing: every overlay closes the same way.
export function initPanels(app) {
  const $ = app.$;
  app.closePanels = () => {
    document.querySelectorAll(".panel").forEach((panel) => { panel.hidden = true; });
    $("#btnMembers").setAttribute("aria-expanded", "false");
    $("#btnSettings").setAttribute("aria-expanded", "false");
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
  app.openChatSettings = () => {
    app.closePanels();
    app.lastFocus = $("#btnSettings");
    $("#chatSettings").hidden = false;
    $("#btnSettings").setAttribute("aria-expanded", "true");
    $("#tokenHint").hidden = false;
    $("#inTokenChat").focus();
  };
}
