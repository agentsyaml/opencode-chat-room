// Room tasks: a side pane on wide windows and a modal board elsewhere. The pane
// leaves the conversation usable while tasks stay visible.
import { LS } from "./state.js";
import { isRoomAdmin } from "./admin-badge.js";
import { TITLE_MAX, buildTaskForm, createStepsEditor, fillAssignees, fillPeople, readPeople } from "./task-form.js";
import { buildTaskRow } from "./task-row.js";

const STATUSES = ["todo", "doing", "done"];
const STATUS_LABELS = { todo: "tasksStatusTodo", doing: "tasksStatusDoing", done: "tasksStatusDone" };
const PANE_QUERY = "(min-width: 1100px) and (min-height: 560px)";

const dateValue = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
const stepsOf = (task) => (Array.isArray(task.steps) ? task.steps : [])
  .filter((step) => step && typeof step.text === "string" && step.text.trim())
  .map((step) => ({ text: step.text, done: step.done === true }));
const participantsOf = (task) => (Array.isArray(task.participants) ? task.participants : [])
  .filter((name) => typeof name === "string" && name);

export function initTasks(app) {
  const dialog = app.$("#tasksDialog");
  if (!dialog) return;
  const $ = app.$, chatView = $("#chatView"), pane = matchMedia(PANE_QUERY);
  const trigger = $("#btnTasks"), heading = $("#tasksHeading"), roomName = $("#tasksRoomName");
  const groups = $("#taskGroups"), empty = $("#tasksEmpty"), summary = $("#tasksSummary");
  const error = $("#tasksError"), errorText = $("#tasksErrorText"), refresh = $("#btnRefreshTasks");
  const limitNotice = $("#tasksLimitNotice");
  const filter = $("#taskFilter"), createDetails = $("#taskCreateDetails"), createForm = $("#taskCreateForm");
  const titleInput = $("#taskTitle"), descriptionInput = $("#taskDescription"), assigneeSelect = $("#taskAssignee");
  const dueInput = $("#taskDueDate"), conclusionInput = $("#taskConclusion"), createPeople = $("#taskCreateParticipants");
  const menuButton = $("#btnTasksMenu"), menu = $("#tasksMenu"), clearButton = $("#btnClearCompleted");
  const createButton = $("#btnCreateTask");
  const editDialog = $("#taskEditDialog"), editHeading = $("#taskEditHeading"), editBody = $("#taskEditFormHost");
  const editError = $("#taskEditError"), editErrorText = $("#taskEditErrorText");
  if (!editDialog) return;
  const createSteps = createStepsEditor(app, $("#taskCreateSteps"), $("#btnAddCreateStep"));
  let items = [], loading = false, failed = false, generation = 0, editingId = "";
  let taskLimit = null;
  let opener = null, restoreFocus = true, pendingReopen = false;

  const statusOf = (task) => STATUSES.includes(task.status) ? task.status : "todo";
  const updatedOf = (task) => Number(task.updatedAt || task.createdAt) || 0;
  const itemURL = (task) => `/rooms/${encodeURIComponent(app.state.room?.id || task.roomId)}/tasks/${encodeURIComponent(task.id)}`;
  const currentRoom = (roomId) => app.state.room?.id === roomId && dialog.open;
  const isAdmin = () => isRoomAdmin(app);
  const isCreator = (task) => task.creatorSessionID === LS.sessionID || (!task.creatorSessionID && task.creatorName === app.state.myName);
  const isAssignee = (task) => Boolean(task.assignee) && task.assignee === app.state.myName;
  const canEdit = (task) => isAdmin() || isCreator(task);
  const canStatus = (task) => canEdit(task) || isAssignee(task);

  const formatDue = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(app.intlLocale(), { month: "short", day: "numeric", year: "numeric" })
      .format(new Date(year, month - 1, day));
  };
  const isOverdue = (task) => {
    const value = dateValue(task.dueDate);
    if (!value || statusOf(task) === "done") return false;
    const [year, month, day] = value.split("-").map(Number);
    const now = new Date();
    return new Date(year, month - 1, day) < new Date(now.getFullYear(), now.getMonth(), now.getDate());
  };

  const syncHead = () => {
    trigger.hidden = app.state.room?.kind === "direct";
    roomName.textContent = app.state.room?.name ? ` · ${app.state.room.name}` : "";
  };
  // Errors belong to the edit modal while it is open; the pane error sits behind it.
  const showError = (key) => {
    const inEdit = editDialog.open;
    app.setText(inEdit ? editErrorText : errorText, key);
    (inEdit ? editError : error).hidden = false;
  };
  const hideError = () => { error.hidden = true; editError.hidden = true; };
  const showText = (message) => {
    errorText.textContent = message;
    delete errorText.dataset.i18n;
    delete errorText._i18nValues;
    error.hidden = false;
  };
  const clearableCount = () => items.filter((task) => statusOf(task) === "done" && (isAdmin() || isCreator(task))).length;
  const syncClear = () => {
    const count = clearableCount();
    clearButton.disabled = loading || count === 0;
    clearButton.dataset.count = String(count);
  };
  const atLimit = () => Number.isInteger(taskLimit) && taskLimit > 0 && items.length >= taskLimit;
  const syncLimit = () => {
    const reached = atLimit();
    if (limitNotice) {
      limitNotice.hidden = !reached;
      if (reached) app.setText(limitNotice, "tasksLimitReached", { limit: taskLimit });
    }
    createButton.disabled = loading || reached;
    if (reached) {
      createButton.setAttribute("aria-describedby", "tasksLimitNotice");
      createButton.title = app.t("tasksLimitReached", { limit: taskLimit });
    } else {
      createButton.removeAttribute("aria-describedby");
      createButton.removeAttribute("title");
    }
  };
  const setBusy = (busy) => {
    loading = busy;
    dialog.setAttribute("aria-busy", String(busy));
    // A reload that finishes while an editor is open must not re-enable the
    // refresh control the editor has locked.
    refresh.disabled = busy || Boolean(editingId);
    syncClear();
    syncLimit();
  };

  const focusRowControl = (taskId, selector) => {
    const row = groups.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
    const control = row?.querySelector(selector);
    control?.focus();
    return Boolean(control);
  };

  const replaceTask = (task) => {
    if (items.some((item) => item.id === task.id)) items = items.map((item) => item.id === task.id ? { ...item, ...task } : item);
    else items = [...items, task];
  };

  const toggleStep = async (task, index, input) => {
    // render() rebuilds the open edit form; keep unsaved edits alive.
    if (editingId) return;
    const roomId = app.state.room?.id;
    if (!roomId) return;
    const steps = stepsOf(task).map((step, position) => position === index ? { ...step, done: input.checked } : step);
    input.disabled = true;
    try {
      const result = await app.api(itemURL(task), {
        method: "PATCH", body: JSON.stringify({ sessionID: LS.sessionID, steps }),
      });
      if (!currentRoom(roomId)) return;
      replaceTask(result?.task || { ...task, steps });
      hideError();
      render();
      focusRowControl(task.id, `.task-step-toggle[data-step-index="${index}"]`);
    } catch (failure) {
      if (!currentRoom(roomId)) return;
      input.checked = !input.checked;
      input.disabled = false;
      showError("tasksUpdateFailed");
      if (failure?.status === 403) void load();
    }
  };

  const changeStatus = async (task, select) => {
    // render() rebuilds the open edit form; keep unsaved edits alive.
    if (editingId) return;
    const roomId = app.state.room?.id, next = select.value;
    if (!roomId || next === statusOf(task)) return;
    select.disabled = true;
    try {
      const result = await app.api(itemURL(task), {
        method: "PATCH", body: JSON.stringify({ sessionID: LS.sessionID, status: next }),
      });
      if (!currentRoom(roomId)) return;
      replaceTask(result?.task || { ...task, status: next });
      hideError();
      render();
      focusRowControl(task.id, ".task-status-select");
    } catch (failure) {
      if (!currentRoom(roomId)) return;
      select.value = statusOf(task);
      select.disabled = false;
      showError("tasksUpdateFailed");
      if (failure?.status === 403) void load();
    }
  };

  const removeTask = async (task) => {
    if (!(await app.confirmAction(app.t("tasksDeleteConfirm", { title: task.title })))) return;
    const roomId = app.state.room?.id;
    if (!roomId) return;
    try {
      await app.api(itemURL(task), { method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }) });
      if (!currentRoom(roomId)) return;
      items = items.filter((item) => item.id !== task.id);
      hideError();
      render();
      heading.focus();
    } catch (failure) {
      if (!currentRoom(roomId)) return;
      showError("tasksDeleteFailed");
      if (failure?.status === 403) void load();
    }
  };

  // The dialog close event is async, so clear the form before another edit can open.
  const closeEdit = (restore = true) => {
    if (!editDialog.open) return;
    const taskId = editingId;
    editDialog.close();
    editingId = "";
    editBody.textContent = "";
    editError.hidden = true;
    refresh.disabled = loading;
    // A breakpoint change waits for the editor so its modal never lands under the board.
    if (pane.matches !== dialog.classList.contains("is-pane")) syncMode();
    if (!restore || !dialog.open || !taskId) return;
    if (!focusRowControl(taskId, ".task-action-edit")) heading.focus();
  };

  // The modal form owns the draft fields, so pane renders and reloads cannot drop them.
  const startEdit = (task) => {
    if (editDialog.open || !dialog.open) return;
    editingId = task.id;
    hideError();
    editBody.textContent = "";
    editHeading.textContent = app.t("tasksEditHeading");
    editBody.append(buildTaskForm(view, task));
    refresh.disabled = true;
    editDialog.showModal();
    editBody.querySelector(".task-edit-title")?.focus();
  };

  const cancelEdit = () => closeEdit(true);

  const saveEdit = async (task, body) => {
    const roomId = app.state.room?.id;
    if (!roomId) return false;
    try {
      const result = await app.api(itemURL(task), {
        method: "PATCH", body: JSON.stringify({ sessionID: LS.sessionID, ...body }),
      });
      if (!currentRoom(roomId)) return true;
      replaceTask(result?.task || { ...task, ...body });
      hideError();
      render();
      closeEdit(true);
      return true;
    } catch (failure) {
      if (!currentRoom(roomId)) return true;
      showError("tasksUpdateFailed");
      if (failure?.status === 403) {
        closeEdit(false);
        void load();
      }
      return false;
    }
  };

  const view = {
    app, statusOf, updatedOf, canEdit, canStatus, stepsOf, participantsOf, dateValue, formatDue, isOverdue,
    // One open editor owns the board; other rows stay visible but inert.
    isLocked: () => Boolean(editingId),
    onStatus: changeStatus, onEdit: startEdit, onDelete: removeTask, onToggleStep: toggleStep,
    showError, onCancel: cancelEdit, onSave: saveEdit,
  };

  const render = () => {
    const selected = filter.value || "all";
    const visible = items.filter((task) => selected === "all" || statusOf(task) === selected);
    groups.textContent = "";
    let index = 0;
    for (const status of STATUSES) {
      const bucket = visible.filter((task) => statusOf(task) === status)
        .sort((left, right) => updatedOf(right) - updatedOf(left));
      if (!bucket.length) continue;
      const section = document.createElement("section");
      section.className = "task-group";
      section.dataset.status = status;
      const title = document.createElement("h3");
      title.className = "task-group-title";
      const mark = document.createElement("span");
      mark.className = "task-group-dot";
      mark.dataset.status = status;
      mark.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = app.t(STATUS_LABELS[status]);
      const count = document.createElement("span");
      count.className = "task-group-count";
      count.textContent = String(bucket.length);
      title.append(mark, label, count);
      const list = document.createElement("ul");
      list.className = "task-list";
      for (const task of bucket) list.append(buildTaskRow(view, task, index++));
      section.append(title, list);
      groups.append(section);
    }
    empty.hidden = visible.length > 0 || failed;
    if (!empty.hidden) app.setText(empty, items.length ? "tasksEmptyFiltered" : "tasksEmpty");
    summary.textContent = items.length ? app.t("tasksSummary", { count: visible.length }) : "";
    syncClear();
    syncLimit();
    refresh.disabled = loading || Boolean(editingId);
  };

  const load = async () => {
    const room = app.state.room;
    if (!room || loading) return;
    const roomId = room.id, request = ++generation;
    taskLimit = null;
    setBusy(true);
    hideError();
    if (!items.length) summary.textContent = app.t("tasksLoading");
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/tasks?sessionID=${encodeURIComponent(LS.sessionID)}`);
      if (request !== generation || !currentRoom(roomId)) return;
      failed = false;
      items = (Array.isArray(result?.tasks) ? result.tasks : [])
        .filter((task) => task && typeof task.id === "string" && typeof task.title === "string");
      const limit = Number(result?.limit);
      taskLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
      render();
    } catch {
      if (request !== generation || !currentRoom(roomId)) return;
      failed = true;
      showError("tasksLoadFailed");
      render();
    } finally {
      if (request === generation) setBusy(false);
    }
  };

  const setMenu = (open) => {
    menu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  };

  const clearCompleted = async () => {
    const count = clearableCount();
    if (!count) return;
    setMenu(false);
    if (!(await app.confirmAction(app.t("tasksClearConfirm", { count })))) {
      menuButton.focus();
      return;
    }
    const roomId = app.state.room?.id;
    if (!roomId) return;
    clearButton.disabled = true;
    try {
      await app.api(`/rooms/${encodeURIComponent(roomId)}/tasks`, {
        method: "DELETE", body: JSON.stringify({ sessionID: LS.sessionID }),
      });
      if (!currentRoom(roomId)) return;
      hideError();
      await load();
      if (currentRoom(roomId)) heading.focus();
    } catch {
      if (!currentRoom(roomId)) return;
      showError("tasksClearFailed");
    } finally {
      if (currentRoom(roomId)) syncClear();
    }
  };

  const resetCreate = () => {
    createForm.reset();
    fillAssignees(app, assigneeSelect, "");
    fillPeople(app, createPeople, []);
    createSteps.reset();
  };

  const show = () => {
    if (app.panelPlacement("tasks") === "pane") {
      app.closeOtherPanelSurfaces?.("tasks");
      dialog.classList.add("is-pane");
      chatView.classList.add("has-pane", "has-tasks");
      chatView.dataset.sidePane = "tasks";
      if (!dialog.open) dialog.show();
    } else {
      dialog.classList.remove("is-pane");
      chatView.classList.remove("has-tasks");
      if (chatView.dataset.sidePane === "tasks") {
        delete chatView.dataset.sidePane;
        chatView.classList.remove("has-pane");
      }
      if (!dialog.open) dialog.showModal();
    }
  };

  const syncMode = () => {
    if (editDialog.open || !dialog.open
      || (app.panelPlacement("tasks") === "pane") === dialog.classList.contains("is-pane")) return;
    pendingReopen = true;
    setMenu(false);
    dialog.close();
    show();
    heading.focus({ preventScroll: true });
  };

  const open = () => {
    const room = app.state.room;
    if (!room || room.kind === "direct") return;
    // The document preview owns the third column while it is open, so Tasks
    // must take the column back even when the task pane is already open.
    app.closeDocPreview?.(false);
    if (dialog.open) { heading.focus(); return; }
    if (editDialog.open) closeEdit(false);
    app.closePanels();
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body && !active.closest("dialog") && !$("#roomOptions")?.contains(active)
      ? active : $("#btnRoomOptions");
    generation++;
    setBusy(false);
    failed = false;
    loading = false;
    items = [];
    taskLimit = null;
    editingId = "";
    filter.value = "all";
    createDetails.open = false;
    resetCreate();
    groups.textContent = "";
    empty.hidden = true;
    hideError();
    setMenu(false);
    summary.textContent = app.t("tasksLoading");
    syncHead();
    syncClear();
    syncLimit();
    show();
    heading.focus();
    void load();
    // A member may have joined since the last room snapshot; refresh the pickers without losing a choice.
    Promise.resolve(app.loadManageableMembers?.()).then(() => {
      if (!dialog.open || editingId) return;
      fillAssignees(app, assigneeSelect, assigneeSelect.value);
      fillPeople(app, createPeople, readPeople(createPeople));
    });
  };
  app.openTasksDialog = open;

  const close = (focus = true) => {
    restoreFocus = focus;
    if (editDialog.open) closeEdit(false);
    if (dialog.open) dialog.close();
  };

  dialog.addEventListener("close", () => {
    // A breakpoint switch closes and reopens the same dialog; keep the loaded list.
    if (pendingReopen) { pendingReopen = false; return; }
    closeEdit(false);
    generation++;
    setBusy(false);
    failed = false;
    loading = false;
    items = [];
    taskLimit = null;
    editingId = "";
    groups.textContent = "";
    empty.hidden = true;
    hideError();
    setMenu(false);
    summary.textContent = "";
    chatView.classList.remove("has-tasks");
    if (chatView.dataset.sidePane === "tasks") {
      delete chatView.dataset.sidePane;
      chatView.classList.remove("has-pane");
    }
    dialog.classList.remove("is-pane");
    const focus = restoreFocus;
    restoreFocus = true;
    if (!focus) return;
    const target = opener;
    opener = null;
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    else if (!app.focusChatComposer?.({ force: true }) && $("#btnRoomOptions")?.isConnected) $("#btnRoomOptions").focus({ preventScroll: true });
  });

  trigger.addEventListener("click", () => { app.closePanels(); open(); });
  app.registerPanelSurface?.("tasks", { element: dialog, close: (restore = false) => close(restore) });
  app.watchPanel?.("tasks", syncMode);
  $("#btnCloseTasks")?.addEventListener("click", () => close());
  refresh.addEventListener("click", () => { if (!editingId) void load(); });
  $("#btnRetryTasks")?.addEventListener("click", () => void load());
  filter.addEventListener("change", render);
  createDetails.addEventListener("toggle", () => {
    if (createDetails.open) fillAssignees(app, assigneeSelect, assigneeSelect.value);
  });
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = menu.hidden;
    setMenu(next);
    if (next && !clearButton.disabled) clearButton.focus();
  });
  menuButton.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setMenu(true);
    (clearButton.disabled ? menuButton : clearButton).focus();
  });
  clearButton.addEventListener("click", () => void clearCompleted());
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !event.target.closest?.(".tasks-menu-anchor")) setMenu(false);
  });

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const roomId = app.state.room?.id;
    const title = titleInput.value.trim();
    if (!roomId || !title || Array.from(title).length > TITLE_MAX) {
      showError("tasksInvalid");
      titleInput.focus();
      return;
    }
    if (atLimit()) { syncLimit(); return; }
    const description = descriptionInput.value.trim(), assignee = assigneeSelect.value;
    const body = {
      sessionID: LS.sessionID, title, dueDate: dueInput.value,
      participants: readPeople(createPeople), conclusion: conclusionInput.value.trim(), steps: createSteps.read(),
    };
    if (description) body.description = description;
    if (assignee) body.assignee = assignee;
    createButton.disabled = true;
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/tasks`, {
        method: "POST", body: JSON.stringify(body),
      });
      if (!currentRoom(roomId)) return;
      if (result?.task) replaceTask(result.task);
      resetCreate();
      createDetails.open = false;
      hideError();
      render();
      heading.focus();
    } catch (failure) {
      if (!currentRoom(roomId)) return;
      const message = String(failure?.message || "");
      if (failure?.status !== 409 && !/limit|maximum|too many/i.test(message)) {
        showError("tasksCreateFailed");
        return;
      }
      const parsed = Number(/(\d+)/.exec(message)?.[1]);
      await load();
      if (!currentRoom(roomId)) return;
      if (!taskLimit && Number.isInteger(parsed) && parsed > 0) taskLimit = parsed;
      const limit = taskLimit || parsed;
      syncLimit();
      if (limit) {
        app.setText(errorText, "tasksLimitReached", { limit });
        error.hidden = false;
      } else {
        showText(message || app.t("tasksCreateFailed"));
      }
    } finally {
      if (currentRoom(roomId)) syncLimit();
    }
  });

  $("#btnCloseTaskEdit")?.addEventListener("click", () => closeEdit(true));
  editDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeEdit(true); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.altKey) return;
    if (!menu.hidden) {
      event.preventDefault();
      setMenu(false);
      menuButton.focus();
      return;
    }
    if (!dialog.open || !dialog.classList.contains("is-pane") || !dialog.contains(document.activeElement)) return;
    event.preventDefault();
    close();
  });
  document.addEventListener("chat-room-activated", () => {
    closeEdit(false);
    // A modal blocks the room switch, so only the side pane survives it.
    if (dialog.open && dialog.classList.contains("is-pane") && app.state.room?.kind !== "direct") {
      items = [];
      taskLimit = null;
      editingId = "";
      filter.value = "all";
      // A draft typed for the previous room must not be created in the new one.
      createDetails.open = false;
      resetCreate();
      generation++;
      // The previous room's load may still be in flight and will bail on the
      // newer generation without clearing its busy flag; reset it here.
      setBusy(false);
      failed = false;
      render();
      syncHead();
      void load();
      return;
    }
    close(false);
    items = [];
    taskLimit = null;
    editingId = "";
    generation++;
    syncHead();
  });
  const onChange = () => syncMode();
  if (pane.addEventListener) pane.addEventListener("change", onChange);
  else pane.addListener(onChange);

  syncHead();
  const applyLocale = app.applyLocale;
  app.applyLocale = () => {
    applyLocale();
    syncHead();
    syncClear();
    syncLimit();
    if (!dialog.open) return;
    const unassigned = assigneeSelect.querySelector('option[value=""]');
    if (unassigned) unassigned.textContent = app.t("tasksUnassigned");
    if (!editingId) render();
  };
}