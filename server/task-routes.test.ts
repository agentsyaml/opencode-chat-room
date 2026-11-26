import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "chat-room-task-routes-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = directory;
const { writeState } = await import("../src/state/store.ts");
const { taskRoutes } = await import("./task-routes.ts");
const { memberRoutes } = await import("./member-routes.ts");

const entry = (name: string, membershipID: string) => ({ serverUrl: "", apiPrefix: "/api", name, membershipID });
const [roomID, directRoomID] = await writeState((svc, registry) => {
  const room = svc.createRoom("Task routes", "Owner");
  for (const name of ["Alice", "Bob", "Admin"]) svc.joinRoom(room.id, { id: name, name });
  room.adminIds = ["Admin"];
  room.adminMembershipIDs = ["admin-m"];
  registry[room.id] = { owner: entry("Owner", "owner-m"), alice: entry("Alice", "alice-m"), bob: entry("Bob", "bob-m"), admin: entry("Admin", "admin-m") };
  const direct = svc.createDirectRoom("Direct", "Owner", ["direct-a", "direct-b"]);
  svc.joinRoom(direct.id, { id: "direct-a", name: "Alice" });
  svc.joinRoom(direct.id, { id: "direct-b", name: "Bob" });
  registry[direct.id] = { "direct-a": entry("Alice", "da-m"), "direct-b": entry("Bob", "db-m") };
  return [room.id, direct.id] as const;
});

const call = async (method: string, pathName: string, body?: unknown) => {
  const url = new URL(`http://test${pathName}`);
  return taskRoutes(new Request(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), url);
};
const collection = `/rooms/${roomID}/tasks`;
const item = (id: string) => `${collection}/${id}`;

afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("non-members and bad requests are rejected with existing route codes", async () => {
  expect((await call("GET", collection))?.status).toBe(400);
  expect((await call("GET", `${collection}?sessionID=outsider`))?.status).toBe(403);
  expect((await call("POST", collection, { sessionID: "outsider", title: "x" }))?.status).toBe(403);
  expect((await call("POST", collection, { title: "x" }))?.status).toBe(400);
  expect((await call("POST", collection, { sessionID: "alice", title: " " }))?.status).toBe(400);
  expect((await call("POST", collection, { sessionID: "alice", title: "x".repeat(201) }))?.status).toBe(400);
  expect((await call("GET", `/rooms/missing/tasks?sessionID=alice`))?.status).toBe(404);
  expect(await taskRoutes(new Request("http://test/elsewhere"), new URL("http://test/elsewhere"))).toBeUndefined();
  const wired = await memberRoutes(new Request(`http://test${collection}?sessionID=alice`), new URL(`http://test${collection}?sessionID=alice`));
  expect(wired?.status).toBe(200);
  expect(await (await call("GET", `${collection}?sessionID=alice`))!.json()).toMatchObject({ limit: 10 });
});

test("creator manages the task while the assignee may only move status", async () => {
  const created = await call("POST", collection, { sessionID: "alice", title: "Plan", description: "details" });
  expect(created?.status).toBe(201);
  const task = (await created!.json() as { task: Record<string, unknown> }).task;
  expect(task).toMatchObject({ roomId: roomID, title: "Plan", description: "details", assignee: "", status: "todo", creatorName: "Alice", creatorSessionID: "alice" });

  const listed = await call("GET", `${collection}?sessionID=bob`);
  expect(listed?.status).toBe(200);
  expect((await listed!.json() as { tasks: Array<{ id: string }> }).tasks.map((row) => row.id)).toContain(task.id as string);

  const assigned = await call("PATCH", item(task.id as string), { sessionID: "alice", assignee: "Bob", status: "doing" });
  expect(assigned?.status).toBe(200);
  expect((await assigned!.json() as { task: Record<string, unknown> }).task).toMatchObject({ title: "Plan", assignee: "Bob", status: "doing" });

  const moved = await call("PATCH", item(task.id as string), { sessionID: "bob", status: "done" });
  expect(moved?.status).toBe(200);
  expect((await moved!.json() as { task: Record<string, unknown> }).task).toMatchObject({ status: "done", title: "Plan" });
  expect((await call("PATCH", item(task.id as string), { sessionID: "bob", title: "Hijack" }))?.status).toBe(403);
  expect((await call("DELETE", item(task.id as string), { sessionID: "bob" }))?.status).toBe(403);
  expect((await call("PATCH", item(task.id as string), { sessionID: "alice", status: "blocked" }))?.status).toBe(400);
  expect((await call("PATCH", item(randomUUID()), { sessionID: "alice", title: "Ghost" }))?.status).toBe(404);

  const deleted = await call("DELETE", item(task.id as string), { sessionID: "alice" });
  expect(deleted?.status).toBe(200);
  expect(await deleted!.json()).toEqual({ ok: true });
  expect((await call("DELETE", item(task.id as string), { sessionID: "alice" }))?.status).toBe(404);
});

test("human admin edits and deletes any task, direct rooms conflict", async () => {
  const created = await call("POST", collection, { sessionID: "bob", title: "Bob task" });
  const id = (await created!.json() as { task: { id: string } }).task.id;
  const patched = await call("PATCH", item(id), { sessionID: "admin", title: "Admin edit", status: "doing" });
  expect(patched?.status).toBe(200);
  expect((await patched!.json() as { task: Record<string, unknown> }).task).toMatchObject({ title: "Admin edit", status: "doing" });
  expect((await call("DELETE", item(id), { sessionID: "admin" }))?.status).toBe(200);

  expect((await call("GET", `/rooms/${directRoomID}/tasks?sessionID=direct-a`))?.status).toBe(409);
  expect((await call("POST", `/rooms/${directRoomID}/tasks`, { sessionID: "direct-a", title: "nope" }))?.status).toBe(409);
  expect((await call("PATCH", `/rooms/${directRoomID}/tasks/${randomUUID()}`, { sessionID: "direct-a", status: "done" }))?.status).toBe(409);
  expect((await call("DELETE", `/rooms/${directRoomID}/tasks/${randomUUID()}`, { sessionID: "direct-a" }))?.status).toBe(409);
});

test("task routes round-trip detail fields and assignee step toggles", async () => {
  const created = await call("POST", collection, {
    sessionID: "alice", title: "Detail", assignee: "Bob", dueDate: "2026-05-06",
    participants: ["Bob"], conclusion: "why", steps: ["one", { text: "two", done: true }],
  });
  expect(created?.status).toBe(201);
  const task = (await created!.json() as { task: Record<string, unknown> }).task;
  expect(task).toMatchObject({ dueDate: "2026-05-06", participants: ["Bob"], conclusion: "why", steps: [{ text: "one", done: false }, { text: "two", done: true }] });

  const toggled = await call("PATCH", item(task.id as string), { sessionID: "bob", steps: [{ text: "one", done: true }, { text: "two", done: true }] });
  expect(toggled?.status).toBe(200);
  expect((await toggled!.json() as { task: Record<string, unknown> }).task).toMatchObject({ steps: [{ text: "one", done: true }, { text: "two", done: true }] });
  expect((await call("PATCH", item(task.id as string), { sessionID: "bob", steps: [{ text: "renamed", done: true }, { text: "two", done: true }] }))?.status).toBe(403);

  const edited = await call("PATCH", item(task.id as string), { sessionID: "alice", dueDate: "", participants: [], conclusion: "", steps: [] });
  expect(edited?.status).toBe(200);
  expect((await edited!.json() as { task: Record<string, unknown> }).task).toMatchObject({ dueDate: "", participants: [], conclusion: "", steps: [] });

  const badDate = await call("POST", collection, { sessionID: "alice", title: "bad", dueDate: "2026-02-30" });
  expect(badDate?.status).toBe(400);
  expect((await badDate!.json() as { error: string }).error).toContain("dueDate");
  const badSteps = await call("PATCH", item(task.id as string), { sessionID: "alice", steps: [{ text: "", done: false }] });
  expect(badSteps?.status).toBe(400);
  expect((await badSteps!.json() as { error: string }).error).toContain("steps");
  expect((await call("DELETE", item(task.id as string), { sessionID: "alice" }))?.status).toBe(200);
});

test("task creation enforces the configurable room limit and lists it", async () => {
  const room = await writeState((svc, registry) => {
    const created = svc.createRoom("Task limit", "Owner");
    svc.joinRoom(created.id, { id: "Alice", name: "Alice" });
    registry[created.id] = { alice: entry("Alice", "limit-alice-m") };
    return created.id;
  });
  const path = `/rooms/${room}/tasks`;
  const previous = process.env.CHAT_ROOM_MAX_ROOM_TASKS;
  process.env.CHAT_ROOM_MAX_ROOM_TASKS = "2";
  try {
    expect(await (await call("GET", `${path}?sessionID=alice`))!.json()).toEqual({ tasks: [], limit: 2 });
    const first = (await (await call("POST", path, { sessionID: "alice", title: "One" }))!.json() as { task: { id: string } }).task;
    expect((await call("POST", path, { sessionID: "alice", title: "Two" }))?.status).toBe(201);
    const rejected = await call("POST", path, { sessionID: "alice", title: "Three" });
    expect(rejected?.status).toBe(409);
    expect(await rejected!.json()).toEqual({ error: "room task limit reached (2); delete a completed task before adding another" });

    expect((await call("PATCH", `${path}/${first.id}`, { sessionID: "alice", status: "done" }))?.status).toBe(200);
    expect((await call("POST", path, { sessionID: "alice", title: "Three" }))?.status).toBe(409);
    expect((await call("DELETE", `${path}/${first.id}`, { sessionID: "alice" }))?.status).toBe(200);
    expect((await call("POST", path, { sessionID: "alice", title: "Three" }))?.status).toBe(201);
  } finally {
    if (previous === undefined) delete process.env.CHAT_ROOM_MAX_ROOM_TASKS;
    else process.env.CHAT_ROOM_MAX_ROOM_TASKS = previous;
  }
});

test("DELETE collection clears completed tasks with member scope", async () => {
  const complete = async (sessionID: string, title: string) => {
    const response = await call("POST", collection, { sessionID, title });
    const id = (await response!.json() as { task: { id: string } }).task.id;
    expect((await call("PATCH", item(id), { sessionID, status: "done" }))?.status).toBe(200);
    return id;
  };
  const bobDone = await complete("bob", "Bob done");
  const aliceDone = await complete("alice", "Alice done");
  const bobTodo = (await (await call("POST", collection, { sessionID: "bob", title: "Bob todo" }))!.json() as { task: { id: string } }).task.id;

  const bobClear = await call("DELETE", collection, { sessionID: "bob" });
  expect(bobClear?.status).toBe(200);
  expect(await bobClear!.json()).toEqual({ ok: true, count: 1 });
  const listed = await call("GET", `${collection}?sessionID=alice`);
  const ids = (await listed!.json() as { tasks: Array<{ id: string }> }).tasks.map((row) => row.id);
  expect(ids).toContain(aliceDone);
  expect(ids).toContain(bobTodo);
  expect(ids).not.toContain(bobDone);

  const adminClear = await call("DELETE", collection, { sessionID: "admin" });
  expect(await adminClear!.json()).toEqual({ ok: true, count: 1 });
  expect((await call("DELETE", item(bobTodo), { sessionID: "bob" }))?.status).toBe(200);

  expect((await call("DELETE", collection, {}))?.status).toBe(400);
  expect((await call("DELETE", collection, { sessionID: "outsider" }))?.status).toBe(403);
  expect((await call("DELETE", `/rooms/${directRoomID}/tasks`, { sessionID: "direct-a" }))?.status).toBe(409);
  expect((await call("PUT", collection, { sessionID: "alice" }))?.status).toBe(405);
});