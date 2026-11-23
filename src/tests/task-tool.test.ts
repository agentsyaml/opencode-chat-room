import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const directory = mkdtempSync(path.join(tmpdir(), "chat-room-task-tool-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = directory;
const store = await import("../state/store.ts");
const { runTaskTool } = await import("../agent/task-tool.ts");
const { centerAction } = await import("../center/center-client.ts");
const roomId = await store.writeState((service, registry) => {
  const room = service.createRoom("__Test_tasks", "owner");
  for (const name of ["agent", "dev", "other"]) service.joinRoom(room.id, { id: name, name });
  registry[room.id] = {
    owner: { serverUrl: "", apiPrefix: "", name: "owner" },
    member: { serverUrl: "", apiPrefix: "", name: "agent" },
    assignee: { serverUrl: "", apiPrefix: "", name: "dev" },
    other: { serverUrl: "", apiPrefix: "", name: "other" },
  };
  return room.id;
});
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("standalone task tool enforces membership and creator/assignee permissions", async () => {
  expect(await runTaskTool({ action: "send", roomId: roomId }, "member")).toBeUndefined();
  expect(await runTaskTool({ action: "task_create", title: "x" }, "member")).toContain("roomId");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x" }, "outsider")).toBe("error: not joined; call join for this room first, and wait for approval if required");
  expect(await runTaskTool({ action: "task_create", roomId: roomId }, "member")).toContain("title");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: 8 as never }, "member")).toContain("title");
  expect(await runTaskTool({ action: "task_list", roomId: roomId }, "outsider")).toBe("error: not joined; call join for this room first, and wait for approval if required");
  expect(await runTaskTool({ action: "task_list", roomId: roomId }, "member")).toBe("no tasks");

  const created = await runTaskTool({ action: "task_create", roomId: roomId, title: "Fix login", assignee: "dev" }, "member");
  expect(created).toContain("task created: Fix login");
  const listed = (await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!;
  expect(listed).toContain("[todo] Fix login (creator: agent) (assignee: dev)");
  const taskID = listed.match(/^([0-9a-f-]{36}) \[todo\]/)![1]!;

  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, status: "doing" }, "other")).toContain("only the task creator");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, title: "Hijack" }, "assignee")).toContain("only the task creator");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID }, "member")).toContain("at least one");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: "missing", status: "done" }, "member")).toContain("task not found");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, status: "later" }, "member")).toContain("status must be");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, status: "doing" }, "assignee")).toBe("task updated: Fix login (id: " + taskID + ", status: doing)");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, description: "check tokens" }, "member")).toContain("task updated");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: taskID, assignee: "" }, "member")).toContain("task updated");
  const cleared = (await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!;
  expect(cleared).toContain("check tokens");
  expect(cleared).not.toContain("(assignee: dev)");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", assignee: "x".repeat(65) }, "member")).toContain("assignee");

  expect(await runTaskTool({ action: "task_delete", roomId: roomId, taskId: taskID }, "other")).toContain("only the task creator");
  expect(await runTaskTool({ action: "task_delete", roomId: roomId, taskId: taskID }, "owner")).toBe(`task deleted: ${taskID}`);
  expect(await runTaskTool({ action: "task_list", roomId: roomId }, "member")).toBe("no tasks");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "Unassigned", assignee: "" }, "member")).toContain("task created: Unassigned");
  const unassigned = (await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!;
  expect(unassigned).toContain("[todo] Unassigned (creator: agent)");
  expect(unassigned).not.toContain("assignee:");
});

test("standalone task tool forwards due date, participants, steps, and conclusion", async () => {
  const created = await runTaskTool({ action: "task_create", roomId: roomId, title: "Plan release", dueDate: " 2026-12-31 ", participants: ["dev", "other"], steps: ["plan", { text: "code", done: true }] }, "member");
  expect(created).toContain("task created: Plan release");
  const listed = (await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!;
  expect(listed).toContain("(due: 2026-12-31) (participants: dev, other)");
  expect(listed).toContain("steps: 1/2\n  - [ ] plan\n  - [x] code");
  const id = listed.match(/^([0-9a-f-]{36}) \[todo\] Plan release/m)![1]!;
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: id, conclusion: "shipped", steps: [{ text: "plan", done: true }, "verify"] }, "member")).toContain("task updated");
  const updated = (await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!;
  expect(updated).toContain("steps: 1/2\n  - [x] plan\n  - [ ] verify");
  expect(updated).toContain("conclusion: shipped");
  expect(await runTaskTool({ action: "task_update", roomId: roomId, taskId: id, dueDate: "" }, "member")).toContain("task updated");
  expect((await runTaskTool({ action: "task_list", roomId: roomId }, "member"))!).not.toContain("(due: 2026-12-31)");
});

test("standalone task tool validates new task fields", async () => {
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", dueDate: "2026-02-30" }, "member")).toContain("dueDate");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", dueDate: "31/12/2026" }, "member")).toContain("dueDate");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", participants: ["dev", ""] }, "member")).toContain("participants");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", conclusion: "x".repeat(5001) }, "member")).toContain("conclusion");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", steps: Array.from({ length: 31 }, (_, index) => `step ${index}`) }, "member")).toContain("steps");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", steps: [{ text: "ok", done: "yes" } as never] }, "member")).toContain("steps");
  expect(await runTaskTool({ action: "task_create", roomId: roomId, title: "x", steps: ["x".repeat(301)] }, "member")).toContain("steps");
});

test("central task actions use the task routes and keep request bodies", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(input), method: init?.method ?? "GET", body });
    const task = { id: "t1", roomId: "r", title: "Fix", description: "d", assignee: "dev", status: "todo", creatorName: "agent",
      dueDate: "2026-12-31", participants: ["dev", "other"], conclusion: "later", steps: ["write", { text: "ship", done: true }] };
    if (init?.method === "POST") return Response.json({ task }, { status: 201 });
    if (init?.method === "PATCH") return Response.json({ task: { ...task, status: "doing" } });
    if (init?.method === "DELETE") return Response.json({ ok: true });
    return Response.json({ tasks: [task] });
  }, { preconnect: originalFetch.preconnect });
  const opts = { center: "http://__Test_center", token: "token" };
  const listed = (await centerAction(opts, { action: "task_list", roomId: "r" }, "s"))!;
  expect(listed).toContain("t1 [todo] Fix (creator: agent) (assignee: dev) (due: 2026-12-31) (participants: dev, other)");
  expect(listed).toContain("steps: 1/2");
  expect(listed).toContain("[x] ship");
  expect(listed).toContain("conclusion: later");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: " Fix ", assignee: "", dueDate: " 2026-12-31 ", participants: [" dev ", "other"], conclusion: " done ", steps: [" write ", { text: " ship ", done: true }, { text: " verify ", done: false }, { text: " review " }] }, "s")).toBe("task created: Fix (id: t1, status: todo)");
  expect(await centerAction(opts, { action: "task_update", roomId: "r", taskId: "t1", status: "doing", dueDate: "", participants: [], conclusion: "", steps: [] }, "s")).toBe("task updated: Fix (id: t1, status: doing)");
  expect(await centerAction(opts, { action: "task_delete", roomId: "r", taskId: "t1" }, "s")).toBe("task deleted: t1");
  expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "PATCH", "DELETE"]);
  expect(requests[0]?.url).toBe("http://__Test_center/rooms/r/tasks?sessionID=s");
  expect(requests[1]?.body).toEqual({ sessionID: "s", title: "Fix", assignee: "", dueDate: "2026-12-31", participants: ["dev", "other"], conclusion: " done ", steps: ["write", { text: "ship", done: true }, { text: "verify", done: false }, { text: "review", done: false }] });
  expect(requests[2]?.body).toEqual({ sessionID: "s", status: "doing", dueDate: "", participants: [], conclusion: "", steps: [] });
  expect(requests[3]?.body).toEqual({ sessionID: "s" });

  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", assignee: "x".repeat(65) }, "s")).toContain("assignee");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", dueDate: "2026-02-30" }, "s")).toContain("dueDate");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", participants: [""] }, "s")).toContain("participants");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", conclusion: "x".repeat(5001) }, "s")).toContain("conclusion");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", steps: Array.from({ length: 31 }, (_, index) => `step ${index}`) }, "s")).toContain("steps");
  expect(await centerAction(opts, { action: "task_create", roomId: "r", title: "x", steps: [{ text: "ok", done: "yes" as never }] }, "s")).toContain("steps");

  expect(await centerAction(opts, { action: "task_create", roomId: "r" }, "s")).toContain("title");
  expect(await centerAction(opts, { action: "task_update", roomId: "r", status: "doing" }, "s")).toContain("taskId");
  expect(await centerAction(opts, { action: "task_update", roomId: "r", taskId: "t1" }, "s")).toContain("at least one");
  expect(requests).toHaveLength(4);
  globalThis.fetch = originalFetch;
});

test("v1 and v2 task schemas accept the new fields", async () => {
  const { roomArgs } = await import("../../plugin");
  const { roomSchema } = await import("../runtime/v2-plugin.ts");
  const input = { action: "task_create" as const, roomId: "r", title: "T", dueDate: "2026-12-31", participants: ["dev"], conclusion: "c", steps: ["first", { text: "second", done: true }] };
  for (const schema of [roomArgs, roomSchema()]) {
    const parsed = schema.parse(input);
    expect(parsed.dueDate).toBe("2026-12-31");
    expect(parsed.participants).toEqual(["dev"]);
    expect(parsed.conclusion).toBe("c");
    expect(parsed.steps).toEqual(input.steps);
    expect(schema.safeParse({ action: "task_update", roomId: "r", taskId: "t", steps: [{}] }).success).toBe(false);
  }
});