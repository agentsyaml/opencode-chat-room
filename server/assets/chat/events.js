import { LS } from "./state.js";
import { copyCodeFromButton, copyTextToClipboard } from "./markdown.js";

export function initEvents(app) {
  const $ = app.$;
  document.querySelectorAll(".locale-select").forEach((select) => {
    select.addEventListener("change", () => {
      app.setLocale(select.value);
      if (!app.state.availableRooms) return;
      app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
      app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    });
  });
  $("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#inRoomId").value.trim(), name = $("#inName").value.trim();
    if (!id) return app.showJoinError("roomIdRequired");
    if (!name) return app.showJoinError("nameRequired");
    void app.joinRoom(id, name);
  });
  $("#createForm").addEventListener("submit", (event) => { event.preventDefault(); void app.createRoom(); });
  $("#btnSend").addEventListener("click", () => void app.send());
  $("#btnJump").addEventListener("click", app.jumpToBottom);
  $("#btnCopyId").addEventListener("click", () => void app.copyRoomId());
  $("#btnLeave").addEventListener("click", () => app.leaveRoom(false));
  $("#btnDeleteRoom").addEventListener("click", () => void app.deleteRoom());
  $("#btnMembers").addEventListener("click", () => app.togglePanel("#memberPanel"));
  $("#btnSettings").addEventListener("click", () => app.togglePanel("#chatSettings"));
  $("#btnRefreshRooms").addEventListener("click", () => void app.refreshRoomList());
  $("#btnNewRoom").addEventListener("click", () => {
    const form = $("#railRoomForm");
    form.hidden = !form.hidden;
    if (!form.hidden) $("#inRoomNameChat").focus();
  });
  $("#railRoomForm").addEventListener("submit", (event) => { event.preventDefault(); void app.createRoom(); });
  $("#inRoomNameChat").addEventListener("input", app.hideSendError);

  const input = $("#msgInput");
  $(".composer").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-failed-action]");
    if (!button) return;
    const { failedAction, failedRoom, failedId } = button.dataset;
    if (failedAction === "retry") void app.retryFailedMessage(failedRoom, failedId);
    else app.discardFailedMessage(failedRoom, failedId);
  });
  input.addEventListener("input", () => {
    app.autoGrow(input);
    app.updateSendState();
    app.updateDraftCount();
    if (app.state.room) {
      const id = app.state.room.id;
      app.state.draftRevision.set(id, (app.state.draftRevision.get(id) || 0) + 1);
      app.saveDraft(id, input.value);
    }
    app.recomputeMention();
  });
  input.addEventListener("keydown", (event) => handleMessageKey(event, app));
  input.addEventListener("keyup", (event) => {
    if (app.mentionActive && /^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) app.recomputeMention();
  });
  input.addEventListener("click", app.recomputeMention);
  input.addEventListener("blur", () => app.closeMention());
  $("#mentionPicker").addEventListener("mousedown", (event) => {
    const option = event.target.closest(".mention-opt");
    if (!option) return;
    event.preventDefault();
    app.insertMention(option.dataset.name);
  });
  $("#thread").addEventListener("scroll", () => {
    const thread = $("#thread");
    if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) void app.markActiveRoomRead();
    app.queueReceiptRefresh();
    app.queueReceiptObservation();
    app.updateJump();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { void app.markActiveRoomRead(); void app.loadManageableMembers(); }
  });
  window.addEventListener("focus", () => { void app.markActiveRoomRead(); app.queueReceiptRefresh(); app.queueReceiptObservation(); });
  $("#msgList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-code]");
    if (button) void copyCodeFromButton(button, app);
    const messageButton = event.target.closest("[data-copy-message]");
    if (messageButton) void copyTextToClipboard(messageButton._copyText).then((copied) => app.flash(messageButton, copied ? "copiedMessage" : "copyMessageFailed"));
  });
  ["#inRoomId", "#inName", "#inRoomName"].forEach((selector) => {
    $(selector).addEventListener("input", app.hideJoinError);
  });
  ["#inToken", "#inTokenChat"].forEach((selector) => {
    $(selector).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector(`[data-token-save="${selector.slice(1)}"]`).click();
      }
    });
  });

  document.addEventListener("click", (event) => {
    const save = event.target.closest("[data-token-save]");
    if (save) {
      saveAccessToken(save, app);
      return;
    }
    if (app.mentionActive && !event.target.closest("#mentionPicker")) app.closeMention();
    if (!event.target.closest(".anchor")) app.closePanels();
    if (!event.target.closest("#railRoomForm, #btnNewRoom")) $("#railRoomForm").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.mentionActive) app.closeMention();
    if (event.key === "Escape" && !$("#railRoomForm").hidden) $("#railRoomForm").hidden = true;
    if (event.key === "Escape" && (!$("#memberPanel").hidden || !$("#chatSettings").hidden)) {
      app.closePanels();
      app.lastFocus?.focus();
    }
  });

  app.applyLocale();
  $("#inToken").value = LS.token;
  $("#inTokenChat").value = LS.token;
  void app.refreshRoomList();
  $("#inRoomId").focus();
}

function saveAccessToken(button, app) {
  const input = document.getElementById(button.dataset.tokenSave);
  input.value = app.setToken(input.value);
  document.querySelector("#inToken").value = LS.token;
  document.querySelector("#inTokenChat").value = LS.token;
  let persistent = false;
  try { persistent = localStorage.getItem("chat.token") === LS.token; } catch { /* Memory fallback is tab-scoped. */ }
  app.flash(button, persistent ? "saved" : "savedMemory");
  void app.refreshRoomList();
  app.retryPendingAction();
}

function handleMessageKey(event, app) {
  if (app.mentionActive && !event.isComposing) {
    if (event.key === "ArrowDown") { event.preventDefault(); app.moveMention(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); app.moveMention(-1); return; }
    if (event.key === "Escape") { event.preventDefault(); app.closeMention(); return; }
    if (event.key === "Enter" || event.key === "Tab") {
      if (app.mention?.items.length) {
        event.preventDefault();
        app.insertMention(app.mention.items[app.mention.index]);
        return;
      }
      app.closeMention();
      if (event.key === "Tab") return;
    }
  }
  if (event.key === "Enter" && !event.isComposing && (event.ctrlKey || !event.shiftKey)) {
    event.preventDefault();
    void app.send();
  }
}
