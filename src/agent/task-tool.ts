import { createTask, deleteTask, listTasks, updateTask, type RoomTask } from "../rooms/tasks.ts";

export type TaskStep = string | { text: string; done?: boolean };
export type Task = Omit<RoomTask, "dueDate" | "participants" | "conclusion" | "steps"> & {
  dueDate?: string;
  participants?: string[];
  conclusion?: string;
  steps?: TaskStep[];
};
export type TaskArgs = {
  action: string;
  roomId?: string;
  taskId?: string;
  title?: string;
  description?: string;
  assignee?: string;
  status?: string;
  dueDate?: string;
  participants?: string[];
  conclusion?: string;
  steps?: TaskStep[];
};
export type TaskEditFields = Pick<TaskArgs, "title" | "description" | "assignee" | "status" | "dueDate" | "participants" | "conclusion" | "steps">;

const EDIT_KEYS = ["title", "description", "assignee", "status", "dueDate", "participants", "conclusion", "steps"] as const;
const MAX_STEPS = 30;

function visible(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value.trim()).length <= max;
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function readSteps(value: unknown): TaskStep[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_STEPS) return undefined;
  const steps: TaskStep[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (!visible(item, 300)) return undefined;
      steps.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const step = item as { text?: unknown; done?: unknown };
    if (!visible(step.text, 300) || (step.done !== undefined && typeof step.done !== "boolean")) return undefined;
    steps.push({ text: step.text.trim(), done: step.done === true });
  }
  return steps;
}

/** Steps normalized for display: strings become open steps, objects keep their done flag. */
function displaySteps(steps: TaskStep[] | undefined): Array<{ text: string; done: boolean }> {
  return (steps ?? []).flatMap((step) => {
    if (typeof step === "string") return step ? [{ text: step, done: false }] : [];
    return typeof step?.text === "string" && step.text ? [{ text: step.text, done: step.done === true }] : [];
  });
}

/** Model-facing parameter errors shared by the standalone tool and central client. */
export function validateTaskFields(fields: TaskEditFields, creating: boolean): string | undefined {
  if (creating && (typeof fields.title !== "string" || !fields.title.trim())) return "title is required to create a task; pass a short task title";
  if (fields.title !== undefined && !visible(fields.title, 200)) return "title must contain 1 to 200 characters";
  if (fields.description !== undefined && (typeof fields.description !== "string" || Array.from(fields.description).length > 5000)) return "description must be a string of at most 5000 characters";
  if (fields.assignee !== undefined && (typeof fields.assignee !== "string" || Array.from(fields.assignee.trim()).length > 64)) return "assignee must be a participant name of at most 64 characters";
  if (fields.status !== undefined && !["todo", "doing", "done"].includes(fields.status)) return "status must be todo, doing, or done";
  if (fields.dueDate !== undefined) {
    if (typeof fields.dueDate !== "string") return "dueDate must be YYYY-MM-DD or empty to clear it";
    if (fields.dueDate.trim() !== "" && !calendarDate(fields.dueDate.trim())) return "dueDate must be a real calendar date in YYYY-MM-DD form, for example 2026-12-31, or empty to clear it";
  }
  if (fields.participants !== undefined && (!Array.isArray(fields.participants) || fields.participants.length > 50 || !fields.participants.every((name) => visible(name, 64)))) return "participants must be an array of at most 50 room participant names, each 1 to 64 characters";
  if (fields.conclusion !== undefined && (typeof fields.conclusion !== "string" || Array.from(fields.conclusion).length > 5000)) return "conclusion must be a string of at most 5000 characters";
  if (fields.steps !== undefined && readSteps(fields.steps) === undefined) return "steps must be an array of at most 30 steps; each step is text of 1 to 300 characters or {text, done}";
  return undefined;
}

/** Validated fields forwarded to the task routes; empty strings and arrays clear values. */
export function taskFields(args: TaskEditFields): Record<string, unknown> {
  return {
    ...(args.title !== undefined ? { title: args.title.trim() } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.assignee !== undefined ? { assignee: args.assignee.trim() } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.dueDate !== undefined ? { dueDate: args.dueDate.trim() } : {}),
    ...(args.participants !== undefined ? { participants: args.participants.map((name) => name.trim()) } : {}),
    ...(args.conclusion !== undefined ? { conclusion: args.conclusion } : {}),
    ...(args.steps !== undefined ? { steps: readSteps(args.steps) } : {}),
  };
}

export function formatTasks(tasks: Task[]): string {
  if (!tasks.length) return "no tasks";
  return tasks
    .map((task) => {
      const steps = displaySteps(task.steps);
      const done = steps.filter((step) => step.done).length;
      return `${task.id} [${task.status}] ${task.title} (creator: ${task.creatorName})` +
        `${task.assignee ? ` (assignee: ${task.assignee})` : ""}` +
        `${task.dueDate ? ` (due: ${task.dueDate})` : ""}` +
        `${task.participants?.length ? ` (participants: ${task.participants.join(", ")})` : ""}` +
        `${task.description ? `\n  ${task.description}` : ""}` +
        `${steps.length ? `\n  steps: ${done}/${steps.length}${steps.map((step) => `\n  - [${step.done ? "x" : " "}] ${step.text}`).join("")}` : ""}` +
        `${task.conclusion ? `\n  conclusion: ${task.conclusion}` : ""}`;
    })
    .join("\n");
}

const NOT_JOINED = "error: not joined; call join for this room first, and wait for approval if required";

function failure(error: string, status: number, action: string): string {
  if (status === 404) {
    return error === "room not found"
      ? "error: room not found; run room action list to see valid room UUIDs"
      : `error: ${error}; run task_list to get a task ID`;
  }
  if (status === 403 && (action === "task_list" || action === "task_create")) return NOT_JOINED;
  if (status === 403) return `error: ${error}; only the task creator or a room administrator can edit or delete a task, and the assignee may change status or toggle existing steps`;
  return `error: ${error}`;
}

/** Standalone task actions backed by the shared SQLite store; undefined for other actions. */
export async function runTaskTool(args: TaskArgs, sessionID: string): Promise<string | undefined> {
  if (!args.action.startsWith("task_")) return undefined;
  if (!args.roomId) return "error: roomId is required; use a room UUID from the room list, not the room name";
  if (args.action === "task_list") {
    const result = await listTasks(args.roomId, sessionID);
    return "error" in result ? failure(result.error, result.status, args.action) : formatTasks(result.tasks);
  }
  if (args.action === "task_create") {
    const error = validateTaskFields(args, true);
    if (error) return `error: ${error}`;
    const result = await createTask(args.roomId, sessionID, taskFields(args));
    return "error" in result
      ? failure(result.error, result.status, args.action)
      : `task created: ${result.task.title} (id: ${result.task.id}, status: ${result.task.status})`;
  }
  if (!args.taskId) return "error: taskId is required; run task_list to get a task ID";
  if (args.action === "task_delete") {
    const result = await deleteTask(args.roomId, args.taskId, sessionID);
    return "error" in result ? failure(result.error, result.status, args.action) : `task deleted: ${args.taskId}`;
  }
  if (args.action !== "task_update") return "error: unsupported task action";
  const error = validateTaskFields(args, false);
  if (error) return `error: ${error}`;
  if (!EDIT_KEYS.some((field) => args[field] !== undefined)) return `error: at least one of ${EDIT_KEYS.join(", ")} is required to update a task`;
  const result = await updateTask(args.roomId, args.taskId, sessionID, taskFields(args));
  return "error" in result
    ? failure(result.error, result.status, args.action)
    : `task updated: ${result.task.title} (id: ${result.task.id}, status: ${result.task.status})`;
}