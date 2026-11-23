// Task form fields shared by the create and edit forms: people pickers and steps.
import { icon } from "./icons.js";

export const TITLE_MAX = 200, TEXT_MAX = 5000, STEP_MAX = 300, STEPS_MAX = 30;

export const roomPeople = (app) => {
  const room = app.state.room;
  return [...new Set([
    ...(room?.participants || []).map((person) => person.name),
    ...(app.state.memberSessions.get(room?.id) || []).map((member) => member.name),
  ].filter(Boolean))]
    .sort((left, right) => String(left).localeCompare(String(right), app.intlLocale()));
};

export const fillAssignees = (app, select, value) => {
  const names = roomPeople(app);
  if (value && !names.includes(value)) names.push(value);
  select.textContent = "";
  const add = (name, label) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = label;
    select.append(option);
  };
  add("", app.t("tasksUnassigned"));
  names.forEach((name) => add(name, name));
  select.value = names.includes(value) ? value : "";
};

export const fillPeople = (app, container, selected = []) => {
  container.textContent = "";
  const names = roomPeople(app);
  // Keep participants who left visible so an unrelated edit does not drop them.
  for (const name of selected) if (!names.includes(name)) names.push(name);
  names.sort((left, right) => String(left).localeCompare(String(right), app.intlLocale()));
  for (const name of names) {
    const label = document.createElement("label");
    label.className = "task-person";
    const input = document.createElement("input");
    input.type = "checkbox"; input.value = name; input.checked = selected.includes(name);
    const text = document.createElement("span");
    text.textContent = name;
    label.append(input, text);
    container.append(label);
  }
};

export const readPeople = (container) => [...container.querySelectorAll('input[type="checkbox"]:checked')]
  .map((input) => input.value);

// One editor for create and edit forms: text, done flag, and a remove button.
export function createStepsEditor(app, container, addButton, initial = []) {
  const rows = [];
  const sync = () => { addButton.disabled = rows.length >= STEPS_MAX; };
  const addRow = (step = {}) => {
    if (rows.length >= STEPS_MAX) return null;
    const row = document.createElement("div");
    row.className = "task-step-row";
    const done = document.createElement("input");
    done.type = "checkbox"; done.className = "task-step-done"; done.checked = step.done === true;
    done.setAttribute("data-i18n-aria-label", "tasksStepDoneLabel");
    done.setAttribute("aria-label", app.t("tasksStepDoneLabel"));
    const text = document.createElement("input");
    text.className = "input task-step-text"; text.maxLength = STEP_MAX; text.autocomplete = "off";
    text.value = step.text || "";
    text.setAttribute("data-i18n-placeholder", "tasksStepPlaceholder");
    text.setAttribute("data-i18n-aria-label", "tasksStepPlaceholder");
    text.placeholder = app.t("tasksStepPlaceholder");
    text.setAttribute("aria-label", app.t("tasksStepPlaceholder"));
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "task-action task-step-remove";
    remove.setAttribute("data-i18n-aria-label", "tasksRemoveStep");
    remove.setAttribute("aria-label", app.t("tasksRemoveStep"));
    remove.innerHTML = icon("dismiss");
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(row), 1);
      row.remove();
      sync();
      addButton.focus();
    });
    row.append(done, text, remove);
    container.append(row);
    rows.push(row);
    sync();
    return row;
  };
  const read = () => rows
    .map((row) => ({ text: row.querySelector(".task-step-text").value.trim(), done: row.querySelector(".task-step-done").checked }))
    .filter((step) => step.text);
  const reset = () => { rows.splice(0).forEach((row) => row.remove()); sync(); };
  addButton.addEventListener("click", () => addRow()?.querySelector(".task-step-text").focus());
  initial.forEach((step) => addRow(step));
  return { addRow, read, reset };
}

export const buildTaskForm = (view, task) => {
  const { app } = view;
  const form = document.createElement("form");
  form.className = "task-edit-form";
  form.noValidate = true;
  const field = (className, key, control) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    label.className = `field task-field ${className}`;
    text.className = "field-label";
    text.dataset.i18n = key;
    text.textContent = app.t(key);
    label.append(text, control);
    return label;
  };
  const legendField = (className, key, children) => {
    const set = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const text = document.createElement("span");
    set.className = `field task-field ${className}`;
    legend.className = "field-label";
    text.dataset.i18n = key;
    text.textContent = app.t(key);
    legend.append(text);
    set.append(legend, ...children);
    return set;
  };
  const title = document.createElement("input");
  title.className = "input task-edit-title";
  title.maxLength = TITLE_MAX;
  title.autocomplete = "off";
  title.value = task.title;
  const description = document.createElement("textarea");
  description.className = "input task-edit-description";
  description.rows = 2;
  description.maxLength = TEXT_MAX;
  description.value = task.description || "";
  const due = document.createElement("input");
  due.className = "input task-edit-due";
  due.type = "date";
  due.value = view.dateValue(task.dueDate);
  const assignee = document.createElement("select");
  assignee.className = "input task-edit-assignee tasks-select";
  fillAssignees(app, assignee, task.assignee || "");
  const people = document.createElement("div");
  people.className = "task-people";
  fillPeople(app, people, view.participantsOf(task));
  const stepsBox = document.createElement("div");
  stepsBox.className = "task-steps-editor";
  const addStep = document.createElement("button");
  addStep.type = "button";
  addStep.className = "btn ghost small task-add-step";
  addStep.dataset.i18n = "tasksAddStep";
  addStep.textContent = app.t("tasksAddStep");
  const steps = createStepsEditor(app, stepsBox, addStep, view.stepsOf(task));
  const conclusion = document.createElement("textarea");
  conclusion.className = "input task-edit-conclusion";
  conclusion.rows = 2;
  conclusion.maxLength = TEXT_MAX;
  conclusion.value = task.conclusion || "";
  const actions = document.createElement("div");
  actions.className = "task-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost small";
  cancel.dataset.i18n = "cancel";
  cancel.textContent = app.t("cancel");
  cancel.addEventListener("click", () => view.onCancel(task));
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn primary small";
  save.dataset.i18n = "save";
  save.textContent = app.t("save");
  actions.append(cancel, save);
  form.append(
    field("task-edit-title-field", "tasksTitleLabel", title),
    field("task-edit-description-field", "tasksDescriptionLabel", description),
    field("task-edit-due-field", "tasksDueDateLabel", due),
    field("task-edit-assignee-field", "tasksAssigneeLabel", assignee),
    legendField("task-edit-participants-field", "tasksParticipantsLabel", [people]),
    legendField("task-edit-steps-field", "tasksStepsLabel", [stepsBox, addStep]),
    field("task-edit-conclusion-field", "tasksConclusionLabel", conclusion),
    actions,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextTitle = title.value.trim();
    if (!nextTitle || Array.from(nextTitle).length > TITLE_MAX) {
      view.showError("tasksInvalid");
      title.focus();
      return;
    }
    save.disabled = true;
    const saved = await view.onSave(task, {
      title: nextTitle, description: description.value.trim(), dueDate: due.value,
      participants: readPeople(people), conclusion: conclusion.value.trim(),
      assignee: assignee.value, steps: steps.read(),
    });
    if (!saved) save.disabled = false;
  });
  return form;
};