import { randomUUID } from "node:crypto";
import { isRoomAdmin, type RoleEntry, type RoleRoom } from "../state/roles.ts";
import { ROOM_TASK_STATUSES, deleteCompletedRoomTasks, deleteRoomTask, insertRoomTask, listRoomTasks, patchRoomTask, readRoomTask, type RoomTask, type RoomTaskPatch, type RoomTaskStatus, type RoomTaskStep } from "../state/sqlite-state.ts";
import type { Database } from "../state/sqlite.ts";
import { databasePath } from "../state/store.ts";
import { withStateTransaction } from "../state/sqlite-state.ts";

export type { RoomTask, RoomTaskStatus };
export type TaskFailure = { status: 400 | 403 | 404 | 409; error: string };
export type TaskListResult = { tasks: RoomTask[] } | TaskFailure;
export type TaskWriteResult = { task: RoomTask } | TaskFailure;
export type TaskDeleteResult = { ok: true } | TaskFailure;
export type TaskClearResult = { ok: true; count: number } | TaskFailure;
export type TaskFields = {
  title?: unknown; description?: unknown; assignee?: unknown; status?: unknown;
  dueDate?: unknown; participants?: unknown; conclusion?: unknown; steps?: unknown;
};

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_CONCLUSION = 5000;
const MAX_PARTICIPANTS = 50;
const MAX_STEPS = 30;
const MAX_STEP_TEXT = 300;
const invalid = (error: string): TaskFailure => ({ status: 400, error });

type Context = { room: RoleRoom; entry: RoleEntry; name: string; participants: Set<string> };
type RoomRow = {
  kind: string; owner_id: string; owner_membership_id: string | null;
  admin_names: string | null; admin_membership_ids: string | null;
};
type MemberRow = {
  name: string; protocol: string | null; host: string | null;
  receiver_owner_id: string | null; membership_id: string | null;
};

// The session must be a current participant and a registry entry; roles come
// from the stored room, never from a client-supplied name.
function context(db: Database, roomID: string, sessionID: string): Context | TaskFailure {
  const room = db.query("SELECT kind,owner_id,owner_membership_id,admin_names,admin_membership_ids FROM rooms WHERE id=?").get(roomID) as RoomRow | null;
  if (!room) return { status: 404, error: "room not found" };
  if (room.kind === "direct") return { status: 409, error: "tasks are not available in direct rooms" };
  const member = db.query("SELECT g.name,g.protocol,g.host,g.receiver_owner_id,g.membership_id FROM registry g JOIN participants p ON p.room_id=g.room_id AND p.id=g.name WHERE g.room_id=? AND g.session_id=?")
    .get(roomID, sessionID) as MemberRow | null;
  if (!member) return { status: 403, error: "not a room member" };
  const roleRoom: RoleRoom = {
    ownerId: room.owner_id,
    ...(room.owner_membership_id ? { ownerMembershipID: room.owner_membership_id } : {}),
    ...(room.admin_names ? { adminIds: JSON.parse(room.admin_names) as string[] } : {}),
    ...(room.admin_membership_ids ? { adminMembershipIDs: JSON.parse(room.admin_membership_ids) as string[] } : {}),
  };
  const entry: RoleEntry = {
    name: member.name,
    ...(member.protocol ? { protocol: member.protocol } : {}),
    ...(member.host ? { host: member.host } : {}),
    ...(member.receiver_owner_id ? { receiverOwnerID: member.receiver_owner_id } : {}),
    ...(member.membership_id ? { membershipID: member.membership_id } : {}),
  };
  const participants = new Set((db.query("SELECT name FROM participants WHERE room_id=?").all(roomID) as Array<{ name: string }>).map((row) => row.name));
  return { room: roleRoom, entry, name: member.name, participants };
}

const isFailure = (value: Context | TaskFailure): value is TaskFailure => "status" in value;

function readTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title && Array.from(title).length <= MAX_TITLE ? title : undefined;
}

function readDescription(value: unknown): string | undefined {
  return typeof value === "string" && Array.from(value).length <= MAX_DESCRIPTION ? value : undefined;
}

function readDueDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  if (value.length !== 10) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function readParticipants(value: unknown, participants: Set<string>): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) return undefined;
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !participants.has(name) || names.includes(name)) return undefined;
    names.push(name);
  }
  return names;
}

function readConclusion(value: unknown): string | undefined {
  return typeof value === "string" && Array.from(value).length <= MAX_CONCLUSION ? value : undefined;
}

function readStepText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= MAX_STEP_TEXT ? value : undefined;
}

function readSteps(value: unknown): RoomTaskStep[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_STEPS) return undefined;
  const steps: RoomTaskStep[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = readStepText(item);
      if (text === undefined) return undefined;
      steps.push({ text, done: false });
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const text = readStepText((item as { text?: unknown }).text);
    const done = (item as { done?: unknown }).done;
    if (text === undefined || typeof done !== "boolean") return undefined;
    steps.push({ text, done });
  }
  return steps;
}

export function listTasks(roomID: string, sessionID: string): Promise<TaskListResult> {
  return withStateTransaction(databasePath(), (db) => {
    const ctx = context(db, roomID, sessionID);
    if (isFailure(ctx)) return ctx;
    return { tasks: listRoomTasks(db, roomID) };
  });
}

export function createTask(roomID: string, sessionID: string, input: TaskFields): Promise<TaskWriteResult> {
  return withStateTransaction(databasePath(), (db) => {
    const ctx = context(db, roomID, sessionID);
    if (isFailure(ctx)) return ctx;
    const title = readTitle(input.title);
    if (!title) return invalid(`title must contain 1 to ${MAX_TITLE} characters`);
    const description = input.description === undefined ? "" : readDescription(input.description);
    if (description === undefined) return invalid(`description must be a string of at most ${MAX_DESCRIPTION} characters`);
    const assignee = input.assignee === undefined ? "" : input.assignee;
    if (typeof assignee !== "string" || (assignee !== "" && !ctx.participants.has(assignee))) return invalid("assignee must be a current participant name");
    const dueDate = input.dueDate === undefined ? "" : readDueDate(input.dueDate);
    if (dueDate === undefined) return invalid("dueDate must be empty or a valid YYYY-MM-DD calendar date");
    const participants = input.participants === undefined ? [] : readParticipants(input.participants, ctx.participants);
    if (participants === undefined) return invalid(`participants must be at most ${MAX_PARTICIPANTS} unique current participant names`);
    const conclusion = input.conclusion === undefined ? "" : readConclusion(input.conclusion);
    if (conclusion === undefined) return invalid(`conclusion must be a string of at most ${MAX_CONCLUSION} characters`);
    const steps = input.steps === undefined ? [] : readSteps(input.steps);
    if (steps === undefined) return invalid(`steps must be at most ${MAX_STEPS} items, each text 1 to ${MAX_STEP_TEXT} characters with a boolean done`);
    const now = Date.now();
    const task: RoomTask = {
      id: randomUUID(), roomId: roomID, title, description, assignee, status: "todo",
      creatorName: ctx.name, creatorSessionID: sessionID, createdAt: now, updatedAt: now,
      dueDate, participants, conclusion, steps,
    };
    insertRoomTask(db, task);
    return { task };
  });
}

export function updateTask(roomID: string, taskID: string, sessionID: string, input: TaskFields): Promise<TaskWriteResult> {
  return withStateTransaction(databasePath(), (db) => {
    const ctx = context(db, roomID, sessionID);
    if (isFailure(ctx)) return ctx;
    const task = readRoomTask(db, roomID, taskID);
    if (!task) return { status: 404, error: "task not found" };
    const patch: RoomTaskPatch = {};
    if (input.title !== undefined) {
      const title = readTitle(input.title);
      if (!title) return invalid(`title must contain 1 to ${MAX_TITLE} characters`);
      patch.title = title;
    }
    if (input.description !== undefined) {
      const description = readDescription(input.description);
      if (description === undefined) return invalid(`description must be a string of at most ${MAX_DESCRIPTION} characters`);
      patch.description = description;
    }
    if (input.assignee !== undefined) {
      // Keep an existing assignee valid after they leave so editing another
      // field does not fail; assigning a different person still requires membership.
      const assignee = input.assignee;
      if (typeof assignee !== "string") return invalid("assignee must be a current participant name");
      if (assignee !== "" && !ctx.participants.has(assignee) && assignee !== task.assignee) return invalid("assignee must be a current participant name");
      patch.assignee = assignee;
    }
    if (input.status !== undefined) {
      if (typeof input.status !== "string" || !ROOM_TASK_STATUSES.includes(input.status as RoomTaskStatus)) return invalid("status must be todo, doing, or done");
      patch.status = input.status as RoomTaskStatus;
    }
    if (input.dueDate !== undefined) {
      const dueDate = readDueDate(input.dueDate);
      if (dueDate === undefined) return invalid("dueDate must be empty or a valid YYYY-MM-DD calendar date");
      patch.dueDate = dueDate;
    }
    if (input.participants !== undefined) {
      // A participant who left the room stays valid on an existing task so
      // editing another field cannot silently drop them.
      const allowed = new Set([...ctx.participants, ...task.participants]);
      const participants = readParticipants(input.participants, allowed);
      if (participants === undefined) return invalid(`participants must be at most ${MAX_PARTICIPANTS} unique participant names`);
      patch.participants = participants;
    }
    if (input.conclusion !== undefined) {
      const conclusion = readConclusion(input.conclusion);
      if (conclusion === undefined) return invalid(`conclusion must be a string of at most ${MAX_CONCLUSION} characters`);
      patch.conclusion = conclusion;
    }
    if (input.steps !== undefined) {
      const steps = readSteps(input.steps);
      if (steps === undefined) return invalid(`steps must be at most ${MAX_STEPS} items, each text 1 to ${MAX_STEP_TEXT} characters with a boolean done`);
      patch.steps = steps;
    }
    if (!Object.keys(patch).length) return invalid("at least one task field is required");
    const admin = isRoomAdmin(ctx.room, ctx.entry);
    const creator = task.creatorSessionID === sessionID;
    const assignee = task.assignee !== "" && task.assignee === ctx.name;
    const contentChanged = patch.title !== undefined || patch.description !== undefined || patch.assignee !== undefined ||
      patch.dueDate !== undefined || patch.participants !== undefined || patch.conclusion !== undefined;
    const stepsChanged = patch.steps !== undefined && (patch.steps.length !== task.steps.length ||
      patch.steps.some((step, index) => step.text !== task.steps[index]!.text));
    if (!admin && !creator && (!assignee || contentChanged || stepsChanged)) {
      return { status: 403, error: "only the creator or a room admin may edit task fields; the assignee may change status or toggle step done values" };
    }
    const updated = patchRoomTask(db, roomID, taskID, patch, Date.now());
    return updated ? { task: updated } : { status: 404, error: "task not found" };
  });
}

export function deleteTask(roomID: string, taskID: string, sessionID: string): Promise<TaskDeleteResult> {
  return withStateTransaction(databasePath(), (db) => {
    const ctx = context(db, roomID, sessionID);
    if (isFailure(ctx)) return ctx;
    const task = readRoomTask(db, roomID, taskID);
    if (!task) return { status: 404, error: "task not found" };
    if (task.creatorSessionID !== sessionID && !isRoomAdmin(ctx.room, ctx.entry)) {
      return { status: 403, error: "not allowed to delete this task" };
    }
    deleteRoomTask(db, roomID, taskID);
    return { ok: true };
  });
}

export function clearCompletedTasks(roomID: string, sessionID: string): Promise<TaskClearResult> {
  return withStateTransaction(databasePath(), (db) => {
    const ctx = context(db, roomID, sessionID);
    if (isFailure(ctx)) return ctx;
    const admin = isRoomAdmin(ctx.room, ctx.entry);
    return { ok: true, count: deleteCompletedRoomTasks(db, roomID, admin ? undefined : sessionID) };
  });
}