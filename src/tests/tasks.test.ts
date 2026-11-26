import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "chat-room-tasks-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = directory;
const { withStateTransaction, readRoomTask } = await import("../state/sqlite-state.ts");
const { writeState } = await import("../state/store.ts");
const { clearCompletedTasks, createTask, deleteTask, listTasks, maxRoomTasks, updateTask } = await import("../rooms/tasks.ts");
const { Database } = await import("../state/sqlite.ts");
const database = path.join(directory, "chat-room.sqlite");

const entry = (name: string, membershipID: string) => ({ serverUrl: "", apiPrefix: "/api", name, membershipID });

const [roomID, directRoomID] = await writeState((svc, registry) => {
  const room = svc.createRoom("Tasks", "Owner");
  for (const name of ["Alice", "Bob", "Carol", "Admin"]) svc.joinRoom(room.id, { id: name, name });
  room.adminIds = ["Admin"];
  room.adminMembershipIDs = ["admin-m"];
  registry[room.id] = {
    owner: entry("Owner", "owner-m"), alice: entry("Alice", "alice-m"), bob: entry("Bob", "bob-m"),
    carol: entry("Carol", "carol-m"), admin: entry("Admin", "admin-m"), "alice-twin": entry("Alice", "twin-m"),
  };
  const direct = svc.createDirectRoom("Direct", "Owner", ["direct-a", "direct-b"]);
  svc.joinRoom(direct.id, { id: "direct-a", name: "Alice" });
  svc.joinRoom(direct.id, { id: "direct-b", name: "Bob" });
  registry[direct.id] = { "direct-a": entry("Alice", "da-m"), "direct-b": entry("Bob", "db-m") };
  return [room.id, direct.id] as const;
});

const taskOf = (result: Awaited<ReturnType<typeof createTask>>) => {
  if (!("task" in result)) throw new Error(result.error);
  return result.task;
};

const expectInvalid = (result: Awaited<ReturnType<typeof createTask>>, field: string) => {
  if (!("error" in result)) throw new Error("expected a validation failure");
  expect(result.status).toBe(400);
  expect(result.error).toContain(field);
};

const limitRoom = (name: string) => writeState((svc, registry) => {
  const room = svc.createRoom(name, "Owner");
  svc.joinRoom(room.id, { id: "Alice", name });
  registry[room.id] = { alice: entry("Alice", `${name}-alice`) };
  return room.id;
});

const withTaskLimit = async <T>(value: string, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.CHAT_ROOM_MAX_ROOM_TASKS;
  process.env.CHAT_ROOM_MAX_ROOM_TASKS = value;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.CHAT_ROOM_MAX_ROOM_TASKS;
    else process.env.CHAT_ROOM_MAX_ROOM_TASKS = previous;
  }
};

afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("create defaults, trim, ordering, and validation", async () => {
  const first = taskOf(await createTask(roomID, "alice", { title: "  First task  " }));
  expect(first).toMatchObject({ roomId: roomID, title: "First task", description: "", assignee: "", status: "todo", creatorName: "Alice", creatorSessionID: "alice", dueDate: "", participants: [], conclusion: "", steps: [] });
  expect(first.updatedAt).toBeGreaterThanOrEqual(first.createdAt);

  for (const input of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: "ok", description: "x".repeat(5001) }, { title: "ok", assignee: "Nobody" }]) {
    const result = await createTask(roomID, "alice", input);
    expect("error" in result ? result.status : 200).toBe(400);
  }

  const assigned = taskOf(await createTask(roomID, "alice", { title: "Assigned", description: "details", assignee: "Bob" }));
  expect(assigned).toMatchObject({ description: "details", assignee: "Bob", status: "todo" });
  await withStateTransaction(database, (db) => db.query("UPDATE room_tasks SET created_at=? WHERE id=?").run(first.createdAt + 1000, first.id));
  const listed = await listTasks(roomID, "bob");
  if (!("tasks" in listed)) throw new Error(listed.error);
  expect(listed.tasks.map((task) => task.id).sort()).toEqual([assigned.id, first.id].sort());

  expect(await listTasks(roomID, "outsider")).toMatchObject({ status: 403, error: "not a room member" });
  expect(await listTasks("missing-room", "alice")).toMatchObject({ status: 404 });
});

test("the room owner can manage any member's task", async () => {
  const created = taskOf(await createTask(roomID, "alice", { title: "Owner sees this" }));
  const patched = await updateTask(roomID, created.id, "owner", { status: "done", title: "Owner edited" });
  if (!("task" in patched)) throw new Error(patched.error);
  expect(patched.task).toMatchObject({ title: "Owner edited", status: "done" });
  expect(await deleteTask(roomID, created.id, "owner")).toEqual({ ok: true });
});

test("partial updates keep untouched fields and enforce ownership", async () => {
  const created = taskOf(await createTask(roomID, "alice", { title: "Owned", description: "keep", assignee: "Bob" }));

  const byAssignee = await updateTask(roomID, created.id, "bob", { status: "doing" });
  if (!("task" in byAssignee)) throw new Error(byAssignee.error);
  expect(byAssignee.task).toMatchObject({ title: "Owned", description: "keep", assignee: "Bob", status: "doing" });
  expect(await updateTask(roomID, created.id, "bob", { title: "Hijack" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { status: "done", title: "Hijack" })).toMatchObject({ status: 403 });
  expect(await deleteTask(roomID, created.id, "bob")).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "carol", { status: "done" })).toMatchObject({ status: 403 });

  const creatorPatch = await updateTask(roomID, created.id, "alice", { description: "" });
  if (!("task" in creatorPatch)) throw new Error(creatorPatch.error);
  expect(creatorPatch.task).toMatchObject({ title: "Owned", description: "", assignee: "Bob", status: "doing" });
  expect(creatorPatch.task.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

  expect(await updateTask(roomID, created.id, "alice-twin", { title: "Twin" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "alice", { status: "invalid" })).toMatchObject({ status: 400 });
  expect(await updateTask(roomID, created.id, "alice", {})).toMatchObject({ status: 400 });
  expect(await updateTask(roomID, randomUUID(), "alice", { title: "Missing" })).toMatchObject({ status: 404 });

  const reassigned = await updateTask(roomID, created.id, "alice", { assignee: "Carol" });
  if (!("task" in reassigned)) throw new Error(reassigned.error);
  expect(reassigned.task.assignee).toBe("Carol");
  expect(await updateTask(roomID, created.id, "bob", { status: "done" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "carol", { status: "done" })).toMatchObject({ task: { status: "done" } });

  const adminPatch = await updateTask(roomID, created.id, "admin", { title: "Admin edited" });
  if (!("task" in adminPatch)) throw new Error(adminPatch.error);
  expect(adminPatch.task).toMatchObject({ title: "Admin edited", assignee: "Carol", status: "done" });
  expect(await deleteTask(roomID, created.id, "admin")).toEqual({ ok: true });
  expect(await deleteTask(roomID, created.id, "admin")).toMatchObject({ status: 404 });

  const own = taskOf(await createTask(roomID, "carol", { title: "Carol owns" }));
  expect(await deleteTask(roomID, own.id, "carol")).toEqual({ ok: true });
});

test("detail fields round-trip and enforce limits", async () => {
  const created = taskOf(await createTask(roomID, "alice", {
    title: "Detailed", dueDate: "2026-12-31", participants: ["Bob", "Carol"],
    conclusion: "Ship it", steps: ["Draft", { text: "Review", done: true }],
  }));
  expect(created).toMatchObject({ dueDate: "2026-12-31", participants: ["Bob", "Carol"], conclusion: "Ship it",
    steps: [{ text: "Draft", done: false }, { text: "Review", done: true }] });

  const cleared = await updateTask(roomID, created.id, "alice", { dueDate: "", participants: [], conclusion: "", steps: [] });
  if (!("task" in cleared)) throw new Error(cleared.error);
  expect(cleared.task).toMatchObject({ dueDate: "", participants: [], conclusion: "", steps: [] });

  for (const dueDate of ["2026-02-30", "2026-13-01", "2026-1-01", "not-a-date", 20260101]) {
    expectInvalid(await createTask(roomID, "alice", { title: "ok", dueDate }), "dueDate");
  }
  for (const participants of [["Nobody"], ["Bob", "Bob"], Array.from({ length: 51 }, (_, index) => `P${index}`), "Bob"]) {
    expectInvalid(await createTask(roomID, "alice", { title: "ok", participants }), "participants");
  }
  for (const steps of ["x", Array.from({ length: 31 }, (_, index) => `step ${index}`), [{ text: "", done: false }], [{ text: "ok", done: "yes" }], ["x".repeat(301)]]) {
    expectInvalid(await createTask(roomID, "alice", { title: "ok", steps }), "steps");
  }
  expectInvalid(await createTask(roomID, "alice", { title: "ok", conclusion: "x".repeat(5001) }), "conclusion");
  expectInvalid(await updateTask(roomID, created.id, "alice", { dueDate: "2025-02-29" }), "dueDate");
  expectInvalid(await updateTask(roomID, created.id, "alice", { steps: [{ text: "x" }] }), "steps");
  expect(taskOf(await createTask(roomID, "alice", { title: "Leap", dueDate: "2024-02-29" })).dueDate).toBe("2024-02-29");
});

test("editing a task can keep a participant who later left the room", async () => {
  const leavingRoom = await writeState((svc, registry) => {
    const room = svc.createRoom("Leaving", "Alice");
    svc.joinRoom(room.id, { id: "Bob", name: "Bob" });
    registry[room.id] = { alice: entry("Alice", "leave-alice"), bob: entry("Bob", "leave-bob") };
    return room.id;
  });
  const task = taskOf(await createTask(leavingRoom, "alice", { title: "Keep Bob", assignee: "Bob", participants: ["Bob"] }));
  await writeState((svc, registry) => {
    svc.leaveRoom(leavingRoom, "Bob");
    const roomRegistry = registry[leavingRoom];
    if (roomRegistry) delete roomRegistry.bob;
  });

  const kept = await updateTask(leavingRoom, task.id, "alice", { title: "Still keeps Bob", assignee: "Bob", participants: ["Bob"] });
  if (!("task" in kept)) throw new Error(kept.error);
  expect(kept.task).toMatchObject({ title: "Still keeps Bob", assignee: "Bob", participants: ["Bob"] });

  const dropped = await updateTask(leavingRoom, task.id, "alice", { participants: [], assignee: "" });
  if (!("task" in dropped)) throw new Error(dropped.error);
  expect(dropped.task).toMatchObject({ participants: [], assignee: "" });
  expectInvalid(await updateTask(leavingRoom, task.id, "alice", { participants: ["Ghost"] }), "participants");
  expectInvalid(await updateTask(leavingRoom, task.id, "alice", { assignee: "Ghost" }), "assignee");
});

test("direct rooms conflict and room deletion cascades tasks", async () => {
  expect(await listTasks(directRoomID, "direct-a")).toMatchObject({ status: 409 });
  expect(await createTask(directRoomID, "direct-a", { title: "nope" })).toMatchObject({ status: 409 });
  expect(await updateTask(directRoomID, randomUUID(), "direct-a", { status: "done" })).toMatchObject({ status: 409 });
  expect(await deleteTask(directRoomID, randomUUID(), "direct-a")).toMatchObject({ status: 409 });

  const cascadeRoom = await writeState((svc, registry) => {
    const room = svc.createRoom("Cascade", "Owner");
    registry[room.id] = { owner: entry("Owner", "cascade-m") };
    return room.id;
  });
  await createTask(cascadeRoom, "owner", { title: "Gone" });
  await writeState((svc, registry) => { svc.deleteRoom(cascadeRoom); delete registry[cascadeRoom]; });
  const row = await withStateTransaction(database, (db) => db.query("SELECT count(*) AS count FROM room_tasks WHERE room_id=?").get(cascadeRoom) as { count: number });
  expect(row.count).toBe(0);
});

test("assignee toggles step done values but not text, while creator and admin edit all fields", async () => {
  const created = taskOf(await createTask(roomID, "alice", {
    title: "Steps", assignee: "Bob", dueDate: "2026-01-02", participants: ["Carol"],
    conclusion: "initial", steps: ["Plan", { text: "Build", done: false }],
  }));
  const toggled = await updateTask(roomID, created.id, "bob", { status: "doing", steps: [{ text: "Plan", done: true }, { text: "Build", done: true }] });
  if (!("task" in toggled)) throw new Error(toggled.error);
  expect(toggled.task).toMatchObject({ status: "doing", steps: [{ text: "Plan", done: true }, { text: "Build", done: true }] });

  expect(await updateTask(roomID, created.id, "bob", { steps: ["Plan"] })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { steps: [{ text: "Plan", done: true }, { text: "Renamed", done: true }] })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { steps: [{ text: "Plan", done: true }, { text: "Build", done: true }], title: "Hijack" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { conclusion: "rewrite" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { dueDate: "2026-02-03" })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "bob", { participants: [] })).toMatchObject({ status: 403 });
  expect(await updateTask(roomID, created.id, "carol", { status: "done" })).toMatchObject({ status: 403 });

  const creatorPatch = await updateTask(roomID, created.id, "alice", {
    dueDate: "2026-03-04", participants: ["Bob", "Carol"], conclusion: "creator", steps: ["Only"],
  });
  if (!("task" in creatorPatch)) throw new Error(creatorPatch.error);
  expect(creatorPatch.task).toMatchObject({ dueDate: "2026-03-04", participants: ["Bob", "Carol"], conclusion: "creator", steps: [{ text: "Only", done: false }] });

  const adminPatch = await updateTask(roomID, created.id, "admin", {
    dueDate: "", participants: [], conclusion: "", steps: [{ text: "Admin", done: true }],
  });
  if (!("task" in adminPatch)) throw new Error(adminPatch.error);
  expect(adminPatch.task).toMatchObject({ dueDate: "", participants: [], conclusion: "", steps: [{ text: "Admin", done: true }] });
});

test("clear completed tasks scopes deletion to admins or the task creator", async () => {
  const clearRoom = await writeState((svc, registry) => {
    const room = svc.createRoom("Clear", "Owner");
    for (const name of ["Alice", "Bob", "Carol", "Admin"]) svc.joinRoom(room.id, { id: name, name });
    room.adminIds = ["Admin"];
    room.adminMembershipIDs = ["admin-m"];
    registry[room.id] = { owner: entry("Owner", "owner-m"), alice: entry("Alice", "alice-m"), bob: entry("Bob", "bob-m"), carol: entry("Carol", "carol-m"), admin: entry("Admin", "admin-m") };
    return room.id;
  });
  const completed = async (session: string, title: string) => {
    const task = taskOf(await createTask(clearRoom, session, { title }));
    await updateTask(clearRoom, task.id, session, { status: "done" });
    return task.id;
  };
  const bobDone = await completed("bob", "Bob done");
  const aliceDone = await completed("alice", "Alice done");
  const bobTodo = taskOf(await createTask(clearRoom, "bob", { title: "Bob todo" }));

  expect(await clearCompletedTasks(clearRoom, "carol")).toEqual({ ok: true, count: 0 });
  expect(await clearCompletedTasks(clearRoom, "bob")).toEqual({ ok: true, count: 1 });
  const afterBob = await listTasks(clearRoom, "bob");
  if (!("tasks" in afterBob)) throw new Error(afterBob.error);
  expect(afterBob.tasks.map((task) => task.id).sort()).toEqual([aliceDone, bobTodo.id].sort());
  expect(afterBob.tasks.map((task) => task.id)).not.toContain(bobDone);
  expect(await clearCompletedTasks(clearRoom, "alice")).toEqual({ ok: true, count: 1 });

  await completed("bob", "Bob done again");
  await completed("admin", "Admin done");
  expect(await clearCompletedTasks(clearRoom, "admin")).toEqual({ ok: true, count: 2 });
  const afterAdmin = await listTasks(clearRoom, "bob");
  if (!("tasks" in afterAdmin)) throw new Error(afterAdmin.error);
  expect(afterAdmin.tasks.map((task) => task.id)).toEqual([bobTodo.id]);

  expect(await clearCompletedTasks(clearRoom, "outsider")).toMatchObject({ status: 403 });
  expect(await clearCompletedTasks(directRoomID, "direct-a")).toMatchObject({ status: 409 });
  expect(await clearCompletedTasks("missing-room", "alice")).toMatchObject({ status: 404 });
  expect(await clearCompletedTasks(clearRoom, "bob")).toEqual({ ok: true, count: 0 });
});

test("room task limit defaults to 10 and rejects the eleventh task", async () => {
  const limitedRoom = await limitRoom("LimitTen");
  for (let index = 1; index <= 10; index++) {
    taskOf(await createTask(limitedRoom, "alice", { title: `Task ${index}` }));
  }
  expect(await createTask(limitedRoom, "alice", { title: "Task 11" })).toEqual({
    status: 409,
    error: "room task limit reached (10); delete a completed task before adding another",
  });
  const listed = await listTasks(limitedRoom, "alice");
  if (!("tasks" in listed)) throw new Error(listed.error);
  expect(listed.tasks).toHaveLength(10);
  expect(listed.limit).toBe(10);
});

test("CHAT_ROOM_MAX_ROOM_TASKS overrides the limit and deleting a completed task frees a slot", async () => {
  await withTaskLimit("2", async () => {
    const limitedRoom = await limitRoom("LimitTwo");
    const one = taskOf(await createTask(limitedRoom, "alice", { title: "One" }));
    taskOf(await createTask(limitedRoom, "alice", { title: "Two" }));
    // Unfinished tasks count, and completing one does not free a slot.
    expect(await createTask(limitedRoom, "alice", { title: "Three" })).toMatchObject({ status: 409 });
    await updateTask(limitedRoom, one.id, "alice", { status: "done" });
    expect(await createTask(limitedRoom, "alice", { title: "Three" })).toMatchObject({ status: 409 });

    expect(await deleteTask(limitedRoom, one.id, "alice")).toEqual({ ok: true });
    taskOf(await createTask(limitedRoom, "alice", { title: "Three" }));
    const listed = await listTasks(limitedRoom, "alice");
    if (!("tasks" in listed)) throw new Error(listed.error);
    expect(listed.tasks).toHaveLength(2);
    expect(listed.limit).toBe(2);
  });
});

test("concurrent creates do not exceed the room task limit", async () => {
  await withTaskLimit("3", async () => {
    const limitedRoom = await limitRoom("LimitConcurrent");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => createTask(limitedRoom, "alice", { title: `Concurrent ${index}` })));
    let created = 0;
    for (const result of results) {
      if ("task" in result) created++;
      else expect(result).toEqual({ status: 409, error: "room task limit reached (3); delete a completed task before adding another" });
    }
    expect(created).toBe(3);
    const listed = await listTasks(limitedRoom, "alice");
    if (!("tasks" in listed)) throw new Error(listed.error);
    expect(listed.tasks).toHaveLength(3);
  });
});

test("CHAT_ROOM_MAX_ROOM_TASKS rejects invalid values instead of clamping", () => {
  expect(maxRoomTasks({})).toBe(10);
  expect(maxRoomTasks({ CHAT_ROOM_MAX_ROOM_TASKS: " 2 " })).toBe(2);
  for (const value of ["0", "-1", "2.5", "ten", "1e3"]) {
    expect(() => maxRoomTasks({ CHAT_ROOM_MAX_ROOM_TASKS: value })).toThrow("CHAT_ROOM_MAX_ROOM_TASKS must be a positive integer");
  }
});

test("legacy task rows gain empty detail fields through migration", async () => {
  const legacyDirectory = mkdtempSync(path.join(os.tmpdir(), "chat-room-task-legacy-"));
  const legacyFile = path.join(legacyDirectory, "chat-room.sqlite");
  const legacy = new Database(legacyFile);
  legacy.exec("CREATE TABLE room_tasks(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,creator_name TEXT NOT NULL,creator_session_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  legacy.query("INSERT INTO room_tasks(id,room_id,title,description,assignee,status,creator_name,creator_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("legacy", "room", "Old", "", "", "todo", "Alice", "alice", 1, 1);
  legacy.close();
  const task = await withStateTransaction(legacyFile, (db) => readRoomTask(db, "room", "legacy"));
  expect(task).toMatchObject({ title: "Old", dueDate: "", participants: [], conclusion: "", steps: [] });
  rmSync(legacyDirectory, { recursive: true, force: true });
});