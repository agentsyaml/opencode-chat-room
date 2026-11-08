import { LS } from "./state.js";
import { copyCodeFromButton, copyTextToClipboard } from "./markdown.js";

export function initEvents(app) {
  const $ = app.$;
  initImages(app);
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

function initImages(app) {
  const $ = app.$, drafts = [], cache = new Map(), files = new Map();
  let draftRoom = null;
  app.imageDrafts = drafts;
  app.failedImageFiles = files;
  app.clearImages = () => {
    for (const item of drafts) URL.revokeObjectURL(item.url);
    drafts.length = 0;
    $("#imageInput").value = "";
    renderDrafts();
  };
  app.syncImageRoom = () => {
    const room = app.state.room?.id || null;
    if (room !== draftRoom) { app.clearImages(); draftRoom = room; }
  };
  function renderDrafts() {
    const container = $("#imageDrafts");
    container.replaceChildren();
    container.hidden = !drafts.length;
    for (const item of drafts) {
      const row = document.createElement("div"), img = document.createElement("img"), name = document.createElement("span"), remove = document.createElement("button");
      row.className = "image-draft"; img.src = item.url; img.alt = ""; name.textContent = item.file.name;
      remove.type = "button"; remove.className = "btn ghost"; remove.textContent = "×";
      remove.setAttribute("aria-label", app.t("removeImage") + ": " + item.file.name);
      remove.onclick = () => { URL.revokeObjectURL(item.url); drafts.splice(drafts.indexOf(item), 1); renderDrafts(); app.updateSendState(); };
      row.append(img, name, remove); container.append(row);
    }
  }
  function addFiles(selected) {
    app.syncImageRoom();
    app.hideSendError();
    for (const file of selected) {
      if (drafts.length >= 2) { app.showSendError("tooManyImages"); break; }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { app.showSendError("invalidImage"); continue; }
      if (file.size > 8 * 1024 * 1024) { app.showSendError("imageTooLarge"); continue; }
      drafts.push({ file, url: URL.createObjectURL(file) });
    }
    renderDrafts(); app.updateSendState();
  }
  $("#btnAttach").onclick = () => $("#imageInput").click();
  $("#imageInput").onchange = (event) => { addFiles(event.target.files); event.target.value = ""; };
  $("#msgInput").addEventListener("paste", (event) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (images.length) { event.preventDefault(); addFiles(images); }
  });
  $(".composer").addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });
  $(".composer").addEventListener("drop", (event) => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
  app.uploadImages = async (roomId, images, save = () => {}) => {
    for (const image of images) {
      if (image.id) continue;
      if (!image.file) throw new Error(app.t("imageUnavailable"));
      const result = await app.api(`/attachments/${encodeURIComponent(roomId)}?sessionID=${encodeURIComponent(LS.sessionID)}`, {
        method: "POST", headers: { "Content-Type": image.file.type }, body: image.file,
      });
      image.id = result.id;
      save();
    }
    return images.map((image) => image.id);
  };
  app.renderImages = (message, row) => {
    if (!message.attachments?.length) return;
    const container = document.createElement("div");
    container.className = "message-images";
    row.append(container);
    for (const image of message.attachments) {
      const link = document.createElement("a"), img = document.createElement("img");
      link.target = "_blank"; link.rel = "noopener"; link.dataset.attachmentId = image.id;
      img.alt = image.name || "Image"; link.setAttribute("aria-label", img.alt); link.append(img); container.append(link);
      const key = `${app.state.room.id}/${image.id}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = { links: new Set(), url: null };
        cache.set(key, entry);
        app.api(`/attachments/${encodeURIComponent(app.state.room.id)}/${encodeURIComponent(image.id)}`, { responseType: "blob" })
          .then((blob) => {
            if (cache.get(key) !== entry) return;
            entry.url = URL.createObjectURL(blob);
            for (const anchor of entry.links) { anchor.href = entry.url; anchor.firstChild.src = entry.url; }
          }).catch(() => { if (cache.get(key) === entry) cache.delete(key); });
      }
      entry.links.add(link);
      if (entry.url) { link.href = entry.url; img.src = entry.url; }
    }
  };
  new MutationObserver(() => {
    for (const [key, entry] of cache) {
      for (const link of entry.links) if (!link.isConnected) entry.links.delete(link);
      if (!entry.links.size) { if (entry.url) URL.revokeObjectURL(entry.url); cache.delete(key); }
    }
  }).observe($("#msgList"), { childList: true, subtree: true });
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
