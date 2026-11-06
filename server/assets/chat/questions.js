import { LS } from "./state.js";

export function initQuestions(app) {
  const $ = app.$, pending = new Map(), selected = new Map(), drafts = new Map(), questionMode = new Map(), submitting = new Set();
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
        const item = document.createElement("li"), button = document.createElement("button");
        button.type = "button";
        button.className = "question-item";
        button.dataset.questionId = question.id;
        button.setAttribute("aria-pressed", String(selected.get(roomId) === question.id));
        button.textContent = question.text;
        item.append(button);
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
      const key = `${roomId}\0${question.id}`, input = box.querySelector("textarea"), send = box.querySelector("button");
      box.hidden = false;
      if (input && send) send.disabled = !input.value.trim() || submitting.has(key);
      return;
    }
    box.textContent = "";
    box.dataset.roomId = question ? roomId : "";
    box.dataset.questionId = question?.id || "";
    box.hidden = !question;
    if (!question) return;
    const heading = document.createElement("p"), form = document.createElement("form"), input = document.createElement("textarea"), send = document.createElement("button");
    heading.className = "question-reply-quote";
    heading.textContent = question.text;
    form.className = "question-reply-form";
    input.className = "input";
    input.rows = 2;
    input.maxLength = 2000;
    input.placeholder = app.t("answerPlaceholder");
    input.setAttribute("aria-label", app.t("answerPlaceholder"));
    input.value = drafts.get(`${roomId}\0${question.id}`) || "";
    const key = `${roomId}\0${question.id}`;
    send.type = "submit";
    send.className = "btn primary small";
    send.textContent = app.t("sendAnswer");
    send.disabled = !input.value.trim() || submitting.has(key);
    input.addEventListener("input", () => {
      drafts.set(`${roomId}\0${question.id}`, input.value);
      send.disabled = !input.value.trim() || submitting.has(key);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void answer(roomId, question.id, input.value.trim(), send);
    });
    form.append(input, send);
    box.append(heading, form);
  }

  async function load(roomId = app.state.room?.id) {
    if (!roomId) return;
    const id = ++request;
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
      if (error.status === 401) app.openChatSettings();
      status.dataset.error = "true";
      app.setText(status, "questionsFailed");
      status.hidden = false;
      render(roomId);
    }
  }

  async function answer(roomId, questionId, text, button) {
    const key = `${roomId}\0${questionId}`;
    if (!text || submitting.has(key)) return;
    submitting.add(key);
    button.disabled = true;
    renderReply(roomId);
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/answers`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID, text }),
      });
      const entry = app.state.rooms.get(roomId);
      if (entry && result.answer && !entry.room.messages.some((item) => item.id === result.answer.id)) {
        entry.room.messages.push({ ...result.answer, roomId });
        entry.room.messages.sort((left, right) => left.createdAt - right.createdAt);
        if (entry.room.messages.length > 500) entry.room.messages.splice(0, entry.room.messages.length - 500);
        if (app.state.room?.id === roomId) app.renderMessages(true);
      }
      pending.set(roomId, (pending.get(roomId) || []).filter((item) => item.id !== result.questionID));
      if (selected.get(roomId) === questionId) selected.delete(roomId);
      drafts.delete(`${roomId}\0${questionId}`);
      if (app.state.room?.id === roomId) render(roomId);
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
    const button = event.target.closest("[data-question-id]");
    if (!button || !app.state.room) return;
    selected.set(app.state.room.id, button.dataset.questionId);
    render(app.state.room.id);
    $("#questionReply textarea")?.focus();
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
  setInterval(() => { if (app.state.room) void load(); }, 5000);
}
