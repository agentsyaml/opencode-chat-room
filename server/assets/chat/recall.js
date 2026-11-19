import { LS } from "./state.js";
import { renderMarkdown } from "./markdown.js";
import { isOwnMessage } from "./messages.js";
import { isRoomAdmin } from "./admin-badge.js";
import { formatSystemMessage, setRoomPreview } from "./system-messages.js";

const RECALL_ICON = '<svg class="message-recall-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/></svg>';
const RECALLED_ICON = '<svg class="recalled-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/></svg>';

// Recall is a soft hide: the server keeps the text and members may reveal it.
export function initRecall(app) {
  const $ = app.$, base = app.renderMessage;

  app.canRecallMessage = (message) => {
    if (!message || message.recalledAt || message.pending) return false;
    const self = app.state.memberSessions.get(app.state.room?.id)?.find((member) => member.sessionID === LS.sessionID);
    // Member data may not have loaded yet; the server re-checks the real membership.
    const humanAdmin = (!self || self.type === "human") && isRoomAdmin(app);
    if (message.senderId === "system") return false;
    if (isOwnMessage(message, app)) return true;
    if (app.state.room?.kind === "direct") return false;
    return humanAdmin;
  };

  app.renderMessage = (message, live) => {
    const row = base(message, live);
    if (message.recalledAt) return renderTombstone(row, message, app, false);
    if (!app.canRecallMessage(message)) return row;
    row.querySelector(".message-actions")?.append(recallButton(message, app));
    return row;
  };

  $("#msgList").addEventListener("click", (event) => {
    const recallTarget = event.target.closest?.("[data-recall-message]");
    if (recallTarget && app.state.room) {
      const message = app.state.room.messages.find((item) => item.id === recallTarget.dataset.recallMessage);
      if (message) void recall(message, recallTarget, app);
      return;
    }
    const revealTarget = event.target.closest?.("[data-reveal-message]");
    if (revealTarget && app.state.room) {
      const message = app.state.room.messages.find((item) => item.id === revealTarget.dataset.revealMessage);
      if (message) void toggleOriginal(revealTarget, message, app);
    }
  });

  app.applyRecall = (roomId, event) => applyRecall(roomId, event, app);
  app.syncLoadedHistory = (roomId, generation) => syncLoadedHistory(roomId, generation, app);
}

// A recall version only tells us something changed; older loaded pages are outside
// the newest room payload, so walk every loaded page and hide recalled text already
// in memory. The page budget is derived from the loaded seq span, never a fixed cap.
async function syncLoadedHistory(roomId, generation, app) {
  const entry = app.state.rooms.get(roomId), room = entry?.room;
  if (!entry || !room || entry.historySync) return false;
  const seqs = room.messages.map((message) => message.seq).filter(Number.isSafeInteger);
  if (seqs.length < 2) return false;
  const oldest = Math.min(...seqs), newest = Math.max(...seqs);
  const maxPages = Math.ceil((newest - oldest + 1) / 200) + 1;
  let cursor = newest + 1, changed = false;
  entry.historySync = true;
  try {
    for (let page = 0; page < maxPages && cursor > oldest; page++) {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/history?beforeSeq=${cursor}&limit=200`);
      if (app.state.room?.id !== roomId || app.state.pollGeneration !== generation) return changed;
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const next = Math.min(...messages.map((message) => message.seq).filter(Number.isSafeInteger));
      for (const message of messages) {
        if (!message.recalledAt) continue;
        const local = room.messages.find((item) => item.id === message.id);
        if (!local || local.recalledAt) continue;
        app.applyRecall?.(roomId, { messageID: message.id, recalledAt: message.recalledAt, recalledBy: message.recalledBy });
        changed = true;
      }
      if (!Number.isSafeInteger(next) || next >= cursor) break;
      cursor = next;
      if (!result.hasMore) break;
    }
  } catch { /* the next recall version retries */ }
  finally { entry.historySync = false; }
  return changed;
}

function applyRecall(roomId, event, app) {
  const entry = app.state.rooms.get(roomId), messageID = event?.messageID || event?.id;
  if (!entry || typeof messageID !== "string") return false;
  const message = entry.room.messages.find((item) => item.id === messageID);
  if (!message) return false;
  const changed = !message.recalledAt;
  message.recalledAt = Number(event.recalledAt) || message.recalledAt || Date.now();
  if (typeof event.recalledBy === "string" && event.recalledBy) message.recalledBy = event.recalledBy;
  message.text = "";
  const hadUnread = entry.unreadIds.delete(messageID);
  if (entry.previewAt === message.createdAt) refreshPreview(entry);
  if (app.replyTargetFor?.(roomId)?.id === messageID) app.setReplyTarget(roomId, null);
  if (app.state.room?.id === roomId) {
    const row = app.$("#msgList").querySelector(`[data-msg-id="${CSS.escape(messageID)}"]`);
    if (row) {
      const keepFocus = row.contains(document.activeElement);
      renderTombstone(row, message, app, changed);
      // The recall button just vanished under the caret; land on the new control.
      if (keepFocus) row.querySelector("[data-reveal-message]")?.focus({ preventScroll: true });
    }
    // Replies that quoted this message must not keep showing its text.
    const quote = app.$("#msgList").querySelector(`.reply-quote[data-reply-target-id="${CSS.escape(messageID)}"]`);
    if (quote) quote.textContent = app.t("replyOriginalRecalled");
    if (hadUnread || changed) {
      app.state.unread = entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
      app.updateBadge();
      app.updateJump();
    }
  }
  if (hadUnread || changed) {
    app.renderRoomOptions?.(app.$("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions?.(app.$("#roomListChat"), app.state.availableRooms || []);
  }
  return changed;
}

// The rail preview must not keep showing text the room already hid.
function refreshPreview(entry) {
  const latest = [...entry.room.messages].reverse().find((item) => !item.recalledAt);
  if (latest) setRoomPreview(entry, latest);
  else { entry.preview = ""; entry.previewSenderId = ""; entry.previewRecalled = true; }
}

function recallButton(message, app) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-recall";
  button.dataset.recallMessage = message.id;
  button.setAttribute("aria-label", app.t("recallMessage"));
  button.dataset.i18nAriaLabel = "recallMessage";
  button.title = isOwnMessage(message, app) ? app.t("recallMessage") : app.t("recallAdminConfirm", { name: message.senderId });
  button.innerHTML = RECALL_ICON;
  return button;
}



async function recall(message, button, app) {
  const roomId = app.state.room?.id;
  if (!roomId || button.disabled) return;
  const own = isOwnMessage(message, app);
  const prompt = own ? app.t("recallConfirm") : app.t("recallAdminConfirm", { name: message.senderId });
  if (!(await app.confirmAction(prompt))) return;
  button.disabled = true;
  try {
    const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(message.id)}/recall`, {
      method: "POST", body: JSON.stringify({ sessionID: LS.sessionID }),
    });
    const detail = result?.message ?? {};
    app.applyRecall(roomId, {
      messageID: typeof result?.messageID === "string" ? result.messageID : message.id,
      recalledAt: Number(result?.recalledAt ?? detail.recalledAt) || Date.now(),
      recalledBy: typeof result?.recalledBy === "string" ? result.recalledBy
        : typeof detail.recalledBy === "string" ? detail.recalledBy : app.state.myName,
    });
  } catch (error) {
    button.disabled = false;
    if (error.status === 401) app.openChatSettings();
    app.showSendError(error.status === 401 ? "sendAuth" : "recallFailed", { message: error.message });
  }
}

function renderTombstone(row, message, app, live) {
  if (message.senderId === "system") return renderSystemTombstone(row, message, app, live);
  row.dataset.recalled = "true";
  row.querySelector(".message-actions")?.remove();
  row.querySelector(".message-readers")?.remove();
  row.querySelector(".question-mark")?.remove();
  const bubble = row.querySelector(".msg-text");
  if (!bubble) return row;
  bubble.classList.add("recalled");
  bubble.textContent = "";
  const note = document.createElement("p"), mark = document.createElement("span"), label = document.createElement("span");
  note.className = "recalled-note";
  mark.className = "recalled-mark"; mark.innerHTML = RECALLED_ICON;
  label.textContent = app.t("messageRecalled");
  note.append(mark, label);
  bubble.append(note);
  if (message.recalledBy && message.recalledBy !== message.senderId) {
    const by = document.createElement("p");
    by.className = "recalled-by";
    by.textContent = app.t("recalledBy", { name: message.recalledBy });
    bubble.append(by);
  }
  const body = document.createElement("div"), reveal = document.createElement("button");
  body.className = "recalled-body";
  reveal.type = "button"; reveal.className = "recalled-reveal"; reveal.dataset.revealMessage = message.id;
  body.hidden = true;
  if (message._revealedText !== undefined) fillRevealed(body, message, message._revealedText, app);
  const shown = Boolean(message._revealed) && message._revealedText !== undefined;
  body.hidden = !shown;
  setRevealButton(reveal, shown, app);
  bubble.append(body, reveal);
  if (live) { row.classList.remove("recalled-in"); void row.offsetWidth; row.classList.add("recalled-in"); }
  return row;
}

// Room notices keep their centered line, so their tombstone is a chip plus controls.
function renderSystemTombstone(row, message, app, live) {
  row.dataset.recalled = "true";
  row.classList.add("recalled");
  row.classList.remove("has-recall");
  row.textContent = "";
  const label = document.createElement("span");
  label.className = "sys-recalled";
  label.innerHTML = RECALLED_ICON;
  label.append(document.createTextNode(app.t("messageRecalled")));
  const by = document.createElement("p");
  by.className = "recalled-by";
  by.textContent = message.recalledBy ? app.t("recalledBy", { name: message.recalledBy }) : "";
  const body = document.createElement("div"), reveal = document.createElement("button");
  body.className = "recalled-body";
  reveal.type = "button"; reveal.className = "recalled-reveal"; reveal.dataset.revealMessage = message.id;
  if (message._revealedText !== undefined) fillRevealed(body, message, message._revealedText, app);
  const shown = Boolean(message._revealed) && message._revealedText !== undefined;
  body.hidden = !shown;
  setRevealButton(reveal, shown, app);
  row.append(label);
  if (by.textContent) row.append(by);
  row.append(reveal, body);
  if (live) { row.classList.remove("recalled-in"); void row.offsetWidth; row.classList.add("recalled-in"); }
  return row;
}

function fillRevealed(body, message, text, app) {
  body.textContent = "";
  if (message.senderId === "system") body.textContent = formatSystemMessage({ senderId: "system", text }, app);
  else renderMarkdown(body, text, app);
}

function setRevealButton(button, shown, app) {
  button.textContent = app.t(shown ? "hideRecalled" : "showRecalled");
  button.setAttribute("aria-expanded", String(shown));
}

async function toggleOriginal(button, message, app) {
  if (button.disabled) return;
  const body = button.parentElement?.querySelector(".recalled-body");
  if (!body) return;
  if (message._revealedText !== undefined) {
    message._revealed = !message._revealed;
    body.hidden = !message._revealed;
    setRevealButton(button, message._revealed, app);
    return;
  }
  button.disabled = true;
  setRevealButton(button, false, app);
  try {
    const roomId = app.state.room?.id;
    const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(message.id)}/content?sessionID=${encodeURIComponent(LS.sessionID)}`);
    const text = typeof result?.message?.text === "string" ? result.message.text : typeof result?.text === "string" ? result.text : undefined;
    if (text === undefined) throw new Error(app.t("revealFailed"));
    message._revealedText = text;
    message._revealed = true;
    fillRevealed(body, message, text, app);
    body.hidden = false;
    setRevealButton(button, true, app);
  } catch {
    button.textContent = app.t("revealFailed");
  } finally {
    button.disabled = false;
  }
}