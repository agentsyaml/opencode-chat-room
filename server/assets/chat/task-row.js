// Task rows: a compact summary of people, due date, steps, and conclusion.
import { icon } from "./icons.js";
import { buildTaskForm } from "./task-form.js";

const STATUSES = ["todo", "doing", "done"];
const STATUS_LABELS = { todo: "tasksStatusTodo", doing: "tasksStatusDoing", done: "tasksStatusDone" };

const statusSelect = (view, task) => {
  const app = view.app;
  const select = document.createElement("select");
  select.className = "input task-status-select";
  select.setAttribute("aria-label", app.t("tasksStatusFor", { title: task.title }));
  for (const status of STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = app.t(STATUS_LABELS[status]);
    select.append(option);
  }
  select.value = view.statusOf(task);
  select.addEventListener("change", () => void view.onStatus(task, select));
  return select;
};

const actionButton = (view, task, key, name) => {
  const app = view.app;
  const button = document.createElement("button");
  const label = app.t(key, { title: task.title });
  button.type = "button";
  button.className = `task-action task-action-${name}`;
  button.dataset.taskAction = name;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon(name);
  button.addEventListener("click", () => name === "delete" ? void view.onDelete(task) : view.onEdit(task));
  return button;
};

export const buildTaskRow = (view, task, index) => {
  const app = view.app;
  const row = document.createElement("li");
  const status = view.statusOf(task), steps = view.stepsOf(task);
  row.className = "task-row";
  row.dataset.taskId = task.id;
  row.dataset.status = status;
  row.style.setProperty("--task-i", String(Math.min(index, 9)));
  if (view.isEditing(task)) {
    row.classList.add("task-row-editing");
    row.append(buildTaskForm(view, task));
    return row;
  }
  const main = document.createElement("div");
  main.className = "task-main";
  const titleLine = document.createElement("div");
  titleLine.className = "task-title-line";
  const title = document.createElement("h4");
  title.className = "task-title";
  title.textContent = task.title;
  const badge = document.createElement("span");
  badge.className = "task-status";
  badge.dataset.status = status;
  badge.textContent = app.t(STATUS_LABELS[status]);
  titleLine.append(title, badge);
  main.append(titleLine);
  if (task.description) {
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    main.append(description);
  }
  if (steps.length) {
    const done = steps.filter((step) => step.done).length;
    const progress = document.createElement("div");
    progress.className = "task-progress";
    const head = document.createElement("div");
    head.className = "task-progress-head";
    const label = document.createElement("span");
    label.textContent = app.t("tasksStepsProgress", { done, total: steps.length });
    const track = document.createElement("span");
    track.className = "task-progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(steps.length));
    track.setAttribute("aria-valuenow", String(done));
    track.setAttribute("aria-label", label.textContent);
    const fill = document.createElement("span");
    fill.className = "task-progress-fill";
    fill.style.width = `${Math.round(done / steps.length * 100)}%`;
    track.append(fill);
    head.append(label);
    const list = document.createElement("ul");
    list.className = "task-steps";
    steps.forEach((step, position) => {
      const item = document.createElement("li");
      item.className = `task-step${step.done ? " is-done" : ""}`;
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "task-step-toggle";
      toggle.checked = step.done;
      toggle.disabled = !view.canStatus(task);
      toggle.dataset.stepIndex = String(position);
      toggle.setAttribute("aria-label", `${app.t("tasksStepDoneLabel")}: ${step.text}`);
      toggle.addEventListener("change", () => void view.onToggleStep(task, position, toggle));
      const text = document.createElement("span");
      text.className = "task-step-text";
      text.textContent = step.text;
      item.append(toggle, text);
      list.append(item);
    });
    progress.append(head, track, list);
    main.append(progress);
  }
  const meta = document.createElement("p");
  meta.className = "task-meta";
  const creator = document.createElement("span");
  creator.className = "task-creator";
  creator.textContent = app.t("tasksCreator", { name: task.creatorName || app.t("guest") });
  const assignee = document.createElement("span");
  assignee.className = "task-assignee";
  if (!task.assignee) assignee.classList.add("is-unassigned");
  assignee.innerHTML = icon("people");
  const assigneeName = document.createElement("span");
  assigneeName.textContent = `${app.t("tasksAssigneeLabel")}: ${task.assignee || app.t("tasksUnassigned")}`;
  assignee.append(assigneeName);
  meta.append(creator, assignee);
  const participants = view.participantsOf(task);
  if (participants.length) {
    const people = document.createElement("span");
    people.className = "task-participants";
    people.textContent = app.t("tasksParticipantsMeta", { names: participants.join(", ") });
    meta.append(people);
  }
  const dueDate = view.dateValue(task.dueDate);
  if (dueDate) {
    const due = document.createElement("span");
    due.className = "task-due";
    if (view.isOverdue(task)) due.classList.add("is-overdue");
    due.textContent = app.t("tasksDueOn", { date: view.formatDue(dueDate) });
    if (view.isOverdue(task)) due.textContent += ` · ${app.t("tasksOverdue")}`;
    meta.append(due);
  }
  const updated = view.updatedOf(task);
  if (updated) {
    const time = document.createElement("time");
    time.className = "task-updated";
    time.dateTime = new Date(updated).toISOString();
    time.textContent = app.t("tasksUpdated", { time: app.fmtTime(updated) });
    meta.append(time);
  }
  main.append(meta);
  if (task.conclusion) {
    const conclusion = document.createElement("p");
    conclusion.className = "task-conclusion";
    const label = document.createElement("span");
    label.className = "task-conclusion-label";
    label.textContent = app.t("tasksConclusionLabel");
    const text = document.createElement("span");
    text.textContent = task.conclusion;
    conclusion.append(label, text);
    main.append(conclusion);
  }
  const actions = document.createElement("div");
  actions.className = "task-row-actions";
  if (view.canStatus(task)) actions.append(statusSelect(view, task));
  if (view.canEdit(task)) actions.append(actionButton(view, task, "tasksEditLabel", "edit"));
  if (view.canEdit(task)) actions.append(actionButton(view, task, "tasksDeleteLabel", "delete"));
  row.append(main);
  if (actions.childElementCount) row.append(actions);
  return row;
};