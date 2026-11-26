import { type StateDatabase } from "./sqlite.ts";

// --- Room tasks (group rooms only; HTTP permissions live in rooms/tasks.ts) ---
export const ROOM_TASK_STATUSES = ["todo", "doing", "done"] as const;
export type RoomTaskStatus = (typeof ROOM_TASK_STATUSES)[number];
export type RoomTaskStep = { text: string; done: boolean };
export type RoomTask = {
  id: string; roomId: string; title: string; description: string; assignee: string;
  status: RoomTaskStatus; creatorName: string; creatorSessionID: string;
  createdAt: number; updatedAt: number; dueDate: string; participants: string[];
  conclusion: string; steps: RoomTaskStep[];
};
type RoomTaskRow = Omit<RoomTask, "status" | "participants" | "steps"> & { status: string; participants: string; steps: string };
const ROOM_TASK_COLUMNS = "id,room_id AS roomId,title,description,assignee,status,creator_name AS creatorName,creator_session_id AS creatorSessionID,created_at AS createdAt,updated_at AS updatedAt,due_date AS dueDate,participants,conclusion,steps";
const jsonArray = <T>(value: string): T[] => {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed as T[] : []; }
  catch { return []; }
};
const roomTask = (row: RoomTaskRow): RoomTask => ({
  ...row, status: row.status as RoomTaskStatus,
  participants: jsonArray<string>(row.participants), steps: jsonArray<RoomTaskStep>(row.steps),
});

export function listRoomTasks(db: StateDatabase, roomID: string): RoomTask[] {
  return (db.query(`SELECT ${ROOM_TASK_COLUMNS} FROM room_tasks WHERE room_id=? ORDER BY created_at,id`).all(roomID) as RoomTaskRow[]).map(roomTask);
}

export function countRoomTasks(db: StateDatabase, roomID: string): number {
  return Number((db.query("SELECT COUNT(*) AS count FROM room_tasks WHERE room_id=?").get(roomID) as { count: number } | null)?.count ?? 0);
}

export function readRoomTask(db: StateDatabase, roomID: string, id: string): RoomTask | undefined {
  const row = db.query(`SELECT ${ROOM_TASK_COLUMNS} FROM room_tasks WHERE room_id=? AND id=?`).get(roomID, id) as RoomTaskRow | null;
  return row ? roomTask(row) : undefined;
}

export function insertRoomTask(db: StateDatabase, task: RoomTask): void {
  db.query("INSERT INTO room_tasks(id,room_id,title,description,assignee,status,creator_name,creator_session_id,created_at,updated_at,due_date,participants,conclusion,steps) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(task.id, task.roomId, task.title, task.description, task.assignee, task.status, task.creatorName, task.creatorSessionID,
      task.createdAt, task.updatedAt, task.dueDate, JSON.stringify(task.participants), task.conclusion, JSON.stringify(task.steps));
}

export type RoomTaskPatch = Partial<Pick<RoomTask, "title" | "description" | "assignee" | "status" | "dueDate" | "participants" | "conclusion" | "steps">>;

export function patchRoomTask(db: StateDatabase, roomID: string, id: string, patch: RoomTaskPatch, updatedAt: number): RoomTask | undefined {
  const sets: string[] = [], values: string[] = [];
  for (const [column, value] of [["title", patch.title], ["description", patch.description], ["assignee", patch.assignee], ["status", patch.status], ["due_date", patch.dueDate], ["conclusion", patch.conclusion]] as const) {
    if (value !== undefined) { sets.push(`${column}=?`); values.push(value); }
  }
  if (patch.participants !== undefined) { sets.push("participants=?"); values.push(JSON.stringify(patch.participants)); }
  if (patch.steps !== undefined) { sets.push("steps=?"); values.push(JSON.stringify(patch.steps)); }
  db.query(`UPDATE room_tasks SET ${sets.map((set) => `${set},`).join("")}updated_at=? WHERE room_id=? AND id=?`)
    .run(...values, updatedAt, roomID, id);
  return readRoomTask(db, roomID, id);
}

export function deleteRoomTask(db: StateDatabase, roomID: string, id: string): boolean {
  return db.query("DELETE FROM room_tasks WHERE room_id=? AND id=?").run(roomID, id).changes > 0;
}

export function deleteCompletedRoomTasks(db: StateDatabase, roomID: string, creatorSessionID?: string): number {
  return creatorSessionID === undefined
    ? db.query("DELETE FROM room_tasks WHERE room_id=? AND status='done'").run(roomID).changes
    : db.query("DELETE FROM room_tasks WHERE room_id=? AND status='done' AND creator_session_id=?").run(roomID, creatorSessionID).changes;
}
