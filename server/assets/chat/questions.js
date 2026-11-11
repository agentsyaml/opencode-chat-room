import { LS } from "./state.js";
import { autoMentionDraft, installEditor } from "./editor.js";
import { copyTextToClipboard, renderMarkdown } from "./markdown.js";

export function initQuestions(app) {
  const $ = app.$, pending = new Map(), selected = new Map(), drafts = new Map(), questionMode = new Map(), submitting = new Set(), unsupported = new Set();
  let request = 0;
  const panel = $("#questionPanel"), trigger = $("#btnQuestions"), list = $("#questionList"), status = $("#questionStatus");
  app.isQuestionSending = () => Boolean(questionMode.get(app.state.room?.id));
  $("#questionToggle").addEventListener("change", (event) => {
    if (app.state.room) questionMode.set(app.state.room.id, event.target.checked);
  });

  const renderMessage = app.renderMessage;
  app.renderMessage = (message, live) => {
    const row = renderMessage(message, live);
    if (message.isQuestion) {
      row.classList.add("question-message");
      const mark = document.createElement("span");
      mark.className = "question-mark";
      mark.textContent = app.t("questionLabel");
      mark.setAttribute("aria-label", app.t("questionLabel"));
      row.querySelector(".msg-meta")?.append(mark);
    }
    return row;
  };

  function render(roomId) {
    const items = pending.get(roomId) || [];
    const active = app.state.room?.id === roomId;
    if (active) {
      $("#questionBadge").textContent = items.length > 99 ? "99+" : String(items.length);
      $("#questionBadge").hidden = !items.length;
      trigger.setAttribute("aria-label", `${app.t("questions")}: ${items.length}`);
      list.textContent = "";
      for (const question of items) {
        const item = document.createElement("li"), card = document.createElement("article"), select = document.createElement("button"), body = document.createElement("div");
        card.className = `question-item${selected.get(roomId) === question.id ? " selected" : ""}`;
        card.dataset.questionId = question.id;
        select.type = "button"; select.className = "question-select"; select.textContent = app.t("selectQuestion");
        select.setAttribute("aria-pressed", String(selected.get(roomId) === question.id));
        body.className = "question-item-body";
        renderMarkdown(body, question.text, app);
        card.append(body, select);
        item.append(card);
        list.append(item);
      }
      status.hidden = items.length > 0 || status.dataset.error === "true";
      if (!items.length && status.dataset.error !== "true") app.setText(status, "questionsEmpty");
      renderReply(roomId);
    }
  }

  function renderReply(roomId) {
    const box = $("#questionReply"), question = (pending.get(roomId) || []).find((item) => item.id === selected.get(roomId));
    if (question && box.dataset.roomId === roomId && box.dataset.questionId === question.id) {
      const key = `${roomId}\0${question.id}`, input = box.querySelector("[contenteditable]"), send = box.querySelector("button[type=submit]"), copy = box.querySelector(".question-copy"), feedback = box.querySelector(".question-copy-feedback");
      box.hidden = false;
      copy.textContent = app.t("copyQuestion"); send.textContent = app.t("sendAnswer"); input.setAttribute("aria-placeholder", app.t("answerPlaceholder"));
      if (feedback.dataset.copyState) feedback.textContent = app.t(feedback.dataset.copyState);
      if (input && send) send.disabled = !input.value.trim() || input.value.length > 2000 || submitting.has(key);
      return;
    }
    box.textContent = "";
    box.dataset.roomId = question ? roomId : "";
    box.dataset.questionId = question?.id || "";
    box.hidden = !question;
    if (!question) return;
    const copy = document.createElement("button"), feedback = document.createElement("p"), form = document.createElement("form"), input = document.createElement("div"), send = document.createElement("button");
    copy.type = "button"; copy.className = "btn ghost small question-copy"; copy.textContent = app.t("copyQuestion");
    feedback.className = "question-copy-feedback"; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      feedback.dataset.copyState = await copyTextToClipboard(question.text) ? "questionCopied" : "questionCopyFailed";
      feedback.textContent = app.t(feedback.dataset.copyState);
    });
    form.className = "question-reply-form";
    input.className = "input";
    input.setAttribute("role", "textbox"); input.setAttribute("aria-multiline", "true");
    input.setAttribute("contenteditable", "true"); input.classList.add("message-editor");
    input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", "mentionPicker"); input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-placeholder", app.t("answerPlaceholder"));
    input.setAttribute("aria-label", app.t("answerPlaceholder"));
    installEditor(input);
    const key = `${roomId}\0${question.id}`;
    input.draftValue = drafts.has(key) ? drafts.get(key) : questionAuthorMention(question, roomId, app);
    send.type = "submit";
    send.className = "btn primary small";
    send.textContent = app.t("sendAnswer");
    send.disabled = !input.value.trim() || input.value.length > 2000 || submitting.has(key);
    input.addEventListener("input", (event) => {
      drafts.set(`${roomId}\0${question.id}`, input.draftValue);
      if (!event.isComposing) app.recomputeMention(input);
      send.disabled = !input.value.trim() || input.value.length > 2000 || submitting.has(key);
      if (input.value.length > 2000) { app.setText(status, "answerTooLong"); status.hidden = false; }
    });
    input.addEventListener("compositionend", () => app.recomputeMention(input));
    input.addEventListener("keydown", (event) => {
      if (app.handleMentionKey(event, input)) return;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); form.requestSubmit(); }
    });
    input.addEventListener("keyup", (event) => { if (!event.isComposing && /^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) app.recomputeMention(input); });
    input.addEventListener("click", () => app.recomputeMention(input));
    input.addEventListener("blur", () => { if (app.mention?.editor === input) app.closeMention(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void answer(roomId, question.id, input.value.trim(), send);
    });
    form.append(input, send);
    box.append(copy, feedback, form);
    input.setCaret(input.value.length);
  }

  function questionAuthorMention(question, roomId, app) {
    const members = app.state.memberSessions.get(roomId) || [];
    const author = question.senderSessionID
      ? members.filter((member) => member.sessionID === question.senderSessionID)
      : members.filter((member) => member.name === question.senderId);
    if (author.length !== 1 || members.filter((member) => member.name === author[0].name).length !== 1 || author[0].sessionID === LS.sessionID || author[0].name === "all") return "";
    return autoMentionDraft(author[0].name);
  }

  async function load(roomId = app.state.room?.id) {
    if (!roomId) return;
    const id = ++request;
    if (unsupported.has(roomId)) {
      const member = await roomMembership(roomId);
      if (id !== request || app.state.room?.id !== roomId) return;
      if (member === false) await app.removeJoinedRoom(roomId, { reason: true });
      else if (member === true) showUnavailable();
      else showFailed();
      return;
    }
    if (app.state.room?.id === roomId && !pending.has(roomId)) {
      app.setText(status, "questionsLoading");
      status.hidden = false;
    }
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/questions`);
      if (id !== request || app.state.room?.id !== roomId || !Array.isArray(result.questions)) return;
      pending.set(roomId, result.questions);
      status.dataset.error = "false";
      status.hidden = true;
      render(roomId);
    } catch (error) {
      if (id !== request || app.state.room?.id !== roomId) return;
      if (error.status === 404) {
        const member = await roomMembership(roomId);
        if (id !== request || app.state.room?.id !== roomId) return;
        if (member === false) await app.removeJoinedRoom(roomId, { reason: true });
        else if (member === true) { unsupported.add(roomId); showUnavailable(); }
        else showFailed();
        return;
      }
      if (error.status === 401) app.openChatSettings();
      showFailed();
      render(roomId);
    }
  }

  async function roomMembership(roomId) {
    const query = new URLSearchParams({ sessionID: LS.sessionID, roomId, timeout: "0" });
    try { const result = await app.api(`/inbox?${query}`); return typeof result.member === "boolean" ? result.member : null; }
    catch { return null; }
  }
  function showUnavailable() { status.dataset.error = "true"; app.setText(status, "questionsUnsupported"); status.hidden = false; }
  function showFailed() { status.dataset.error = "true"; app.setText(status, "questionsFailed"); status.hidden = false; }

  app.answerQuestionFromReply = async (roomId, questionId, text) => {
    if (text.length > 2000) throw Object.assign(new Error(app.t("answerTooLong")), { status: 413 });
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/answers`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, text }),
      });
      applyAnswer(roomId, questionId, result);
      return result;
    } catch (error) {
      if (error.status === 409 || error.status === 404) await load(roomId);
      throw error;
    }
  };

  async function answer(roomId, questionId, text, button) {
    const key = `${roomId}\0${questionId}`;
    if (!text || submitting.has(key)) return;
    if (text.length > 2000) { app.setText(status, "answerTooLong"); status.hidden = false; return; }
    submitting.add(key);
    button.disabled = true;
    renderReply(roomId);
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/answers`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, text }),
      });
      applyAnswer(roomId, questionId, result);
      void load(roomId);
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        await load(roomId);
        if (error.status === 409 && app.state.room?.id === roomId && !(pending.get(roomId) || []).some((item) => item.id === questionId)) {
          if (selected.get(roomId) === questionId) selected.delete(roomId);
          drafts.delete(`${roomId}\0${questionId}`);
          app.setText(status, "questionAlreadyAnswered");
          status.dataset.error = "true";
          status.hidden = false;
          render(roomId);
        }
      } else if (error.status === 401 && app.state.room?.id === roomId) {
        app.openChatSettings();
        app.showSendError("sendAuth");
      } else if (app.state.room?.id === roomId) {
        app.setText(status, "answerFailed");
        status.hidden = false;
      }
    } finally {
      submitting.delete(key);
      if (app.state.room?.id === roomId) renderReply(roomId);
    }
  }

  function applyAnswer(roomId, questionId, result) {
    const entry = app.state.rooms.get(roomId);
    if (entry && result.answer && !entry.room.messages.some((item) => item.id === result.answer.id)) {
      entry.room.messages.push({ ...result.answer, roomId }); entry.room.messages.sort((a, b) => a.createdAt - b.createdAt);
      if (entry.room.messages.length > 500) entry.room.messages.splice(0, entry.room.messages.length - 500);
      if (app.state.room?.id === roomId) app.renderMessages(true);
    }
    pending.set(roomId, (pending.get(roomId) || []).filter((item) => item.id !== (result.questionID || questionId)));
    if (selected.get(roomId) === questionId) selected.delete(roomId);
    drafts.delete(`${roomId}\0${questionId}`);
    if (app.state.room?.id === roomId) render(roomId);
  }

  trigger.addEventListener("click", () => {
    const open = panel.hidden;
    app.closePanels();
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      void load();
      $("#questionHeading").focus();
    }
  });
  $("#btnRefreshQuestions").addEventListener("click", () => void load());
  list.addEventListener("click", (event) => {
    event.stopPropagation();
    const card = event.target.closest(".question-item[data-question-id]"), select = event.target.closest(".question-select");
    if (!card || (!select && event.target.closest("a, button, input, textarea, select, [contenteditable=true]")) || !app.state.room) return;
    selected.set(app.state.room.id, card.dataset.questionId);
    render(app.state.room.id);
    $("#questionReply [contenteditable]")?.focus();
  });

  const closePanels = app.closePanels;
  app.closePanels = () => {
    closePanels();
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      app.closePanels();
      trigger.focus();
    }
  });
  const activateRoom = app.activateRoom;
  app.activateRoom = (roomId) => {
    activateRoom(roomId);
    $("#questionToggle").checked = Boolean(questionMode.get(roomId));
    void load(roomId);
  };
  const applyLocale = app.applyLocale;
  app.applyLocale = () => {
    applyLocale();
    if (app.state.room) render(app.state.room.id);
  };
  setInterval(() => { if (app.state.room && !panel.hidden) void load(); }, 5000);
}
