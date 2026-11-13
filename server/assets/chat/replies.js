import { LS } from "./state.js";
import { replaceEditorRange, setEditorSelection, setCaret } from "./editor.js";

export function initReplies(app) {
  const $ = app.$, targets = new Map(Object.entries(LS.replyDrafts || {}).filter(([, item]) => validTarget(item)));
  $("#replyCancel").textContent = app.t("cancelReply");
  app.replyTargetFor = (roomId) => targets.get(roomId);
  app.setReplyTarget = (roomId, target) => {
    if (validTarget(target)) targets.set(roomId, target); else targets.delete(roomId);
    LS.replyDrafts = Object.fromEntries(targets);
    if (app.state.room?.id === roomId) app.renderReplyPreview();
  };
  app.clearReplyTarget = (roomId) => app.setReplyTarget(roomId, null);
  app.renderReplyPreview = () => {
    const roomId = app.state.room?.id, target = roomId && targets.get(roomId), box = $("#replyPreview");
    box.hidden = !target;
    if (!target) return;
    $("#replyPreviewName").textContent = senderName(target, app);
    $("#replyPreviewText").textContent = excerpt(target.text);
  };
  $("#replyCancel").addEventListener("click", () => cancelReply(app));
  bindMessageActions(app);
}

function validTarget(item) {
  return item && typeof item.id === "string" && typeof item.text === "string" && typeof item.senderId === "string";
}
function excerpt(text) { return String(text).replace(/<at>@([^<]+)<\/at>/g, "@$1").replace(/\s+/g, " ").trim().slice(0, 180); }

function bindMessageActions(app) {
  const $ = app.$;
  const render = app.renderMessage;
  app.renderMessage = (message, live) => {
    const row = render(message, live);
    if (message.senderId === "system") return row;
    if (message.answerToMessageID) row.querySelector(".msg-meta")?.after(quoteButton(message, app));
    const copy = row.querySelector("[data-copy-message]");
    if (copy) {
      const actions = document.createElement("div"), reply = document.createElement("button");
      actions.className = "message-actions";
      reply.type = "button"; reply.className = "message-reply"; reply.innerHTML = '<svg class="message-reply-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 10 4 15l5 5M4 15h9a7 7 0 0 0 7-7V5"/></svg>';
      reply.setAttribute("aria-label", app.t("replyMessage")); reply.dataset.i18nAriaLabel = "replyMessage"; reply.dataset.replyMessage = message.id;
      copy.before(actions); actions.append(copy, reply);
    }
    return row;
  };
  $("#msgList").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-reply-message], [data-reply-target-id]");
    if (!button || !app.state.room) return;
    const room = app.state.room, id = button.dataset.replyMessage || button.dataset.replyTargetId;
    if (button.dataset.replyMessage) selectReply(app.state.room.messages.find((item) => item.id === id), app);
    else void jumpToOriginal(room.id, id, app);
  });
}

function selectReply(message, app) {
  if (!message || !app.state.room) return;
  const roomId = app.state.room.id;
  removeAutoMention(app.replyTargetFor(roomId), app.$("#msgInput"));
  const target = { id: message.id, text: message.text, senderId: message.senderId, senderSessionID: message.senderSessionID, isQuestion: Boolean(message.isQuestion) };
  const name = uniqueAuthor(message, app);
  const input = app.$("#msgInput");
  if (name && !input.value.includes(`<at>@${name}</at>`)) {
    const prefix = `<at>@${name}</at> `;
    target.autoMention = name;
    replaceEditorRange(input, 0, 0, prefix); input.setCaret(prefix.length);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }
  app.setReplyTarget(roomId, target);
  input.focus({ preventScroll: true });
}

function cancelReply(app) {
  const roomId = app.state.room?.id, target = roomId && app.replyTargetFor(roomId);
  if (!roomId || !target) return;
  removeAutoMention(target, app.$("#msgInput"));
  app.clearReplyTarget(roomId);
}

function removeAutoMention(target, input) {
  const prefix = target?.autoMention && `<at>@${target.autoMention}</at> `;
  if (prefix && input.value.startsWith(prefix)) {
    setEditorSelection(input, 0, prefix.length); getSelection().deleteFromDocument(); setCaret(input, 0);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }
}

function uniqueAuthor(message, app) {
  const members = app.state.memberSessions.get(app.state.room?.id) || [];
  const matches = message.senderSessionID ? members.filter((item) => item.sessionID === message.senderSessionID)
    : members.filter((item) => item.name === message.senderId);
  const name = matches[0]?.name;
  return matches.length === 1 && members.filter((item) => item.name === name).length === 1 && matches[0].sessionID !== LS.sessionID && name !== "all" ? name : "";
}

function senderName(message, app) {
  if (message.senderSessionID === LS.sessionID) return app.t("you");
  const members = app.state.memberSessions.get(app.state.room?.id) || [];
  const match = message.senderSessionID && members.find((item) => item.sessionID === message.senderSessionID);
  if (match) return match.name;
  return message.senderId || app.t("guest");
}

function quoteButton(message, app) {
  const button = document.createElement("button"), targetId = message.answerToMessageID;
  const original = app.state.room.messages.find((item) => item.id === targetId);
  button.type = "button"; button.className = "reply-quote"; button.dataset.replyTargetId = targetId;
  button.setAttribute("aria-label", app.t("replyOpenOriginal")); button.dataset.i18nAriaLabel = "replyOpenOriginal";
  button.textContent = original ? `${senderName(original, app)} · ${excerpt(original.text)}` : app.t("replyOpenOriginal");
  return button;
}

async function jumpToOriginal(roomId, messageId, app) {
  const generation = app.state.navigationGeneration;
  let entry = app.state.rooms.get(roomId), room = entry?.room;
  if (!entry || !room) return;
  let original = room.messages.find((item) => item.id === messageId), beforeSeq;
  try {
    while (!original) {
      const query = new URLSearchParams({ limit: "100" });
      if (beforeSeq) query.set("beforeSeq", String(beforeSeq));
      const page = await app.api(`/rooms/${encodeURIComponent(roomId)}/history?${query}`);
      entry = app.state.rooms.get(roomId); if (!entry) return;
      room = entry.room;
      original = (page.messages || []).find((item) => item.id === messageId);
      const merged = new Map([...room.messages, ...(page.messages || []).map((item) => ({ ...item, roomId }))].map((item) => [item.id, item]));
      room.messages = [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
      // Keep the upward-pagination cursor aligned with what the jump loaded.
      if (typeof room.messages[0]?.seq === "number") entry.historyBeforeSeq = room.messages[0].seq;
      if (!page.hasMore) entry.historyComplete = true;
      if (original || !page.hasMore || !page.nextBeforeSeq || page.nextBeforeSeq === beforeSeq) break;
      beforeSeq = page.nextBeforeSeq;
    }
  } catch { return; }
  if (!original) return markUnavailable(messageId, roomId, app);
  app.state.positions.set(roomId, { messageId, offset: 0, atBottom: false }); app.savePosition(roomId, { messageId, offset: 0, atBottom: false });
  if (app.state.room?.id === roomId && app.state.navigationGeneration === generation) {
    app.state.room = app.state.rooms.get(roomId)?.room || room; app.rerenderMessages();
    const row = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`), thread = app.$("#thread");
    if (row && thread) {
      // Land the message's top on the thread's top edge so the most context shows.
      thread.scrollTop += row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop);
      clearTimeout(row._jumpFlashTimer); row.classList.remove("jump-flash"); void row.offsetWidth; row.classList.add("jump-flash");
      row._jumpFlashTimer = setTimeout(() => row.classList.remove("jump-flash"), 900);
    }
  }
  const quote = document.querySelector(`[data-reply-target-id="${CSS.escape(messageId)}"]`);
  if (quote) quote.textContent = `${senderName(original, app)} · ${excerpt(original.text)}`;
}

function markUnavailable(messageId, roomId, app) {
  if (app.state.room?.id !== roomId) return;
  const quote = document.querySelector(`[data-reply-target-id="${CSS.escape(messageId)}"]`);
  if (quote) { quote.textContent = app.t("replyOriginalUnavailable"); quote.disabled = true; }
}
