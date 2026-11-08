import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.CHAT_ROOM_ADMIN_FIXTURE) {
  test("admin API fixtures use an isolated child server", async () => {
    const child = Bun.spawn([process.execPath, "test", "server/admin-routes.test.ts"], { env: { ...process.env, CHAT_ROOM_ADMIN_FIXTURE: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${stdout}${stderr}`);
  });
} else {
const previousStateDir = process.env.CHAT_ROOM_STATE_DIR;
const previousServerToken = process.env.CHAT_ROOM_SERVER_TOKEN;
const previousAdminToken = process.env.CHAT_ROOM_ADMIN_TOKEN;
const stateDir = mkdtempSync(path.join(tmpdir(), "chat-room-admin-routes-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
process.env.CHAT_ROOM_SERVER_TOKEN = "trusted-shared-secret";
process.env.CHAT_ROOM_ADMIN_TOKEN = "different-operator-secret";
const operator = { "x-chat-admin-token": process.env.CHAT_ROOM_ADMIN_TOKEN! };
let file: string;
let dbState: typeof import("../src/sqlite-state");
let routes: typeof import("./admin-routes").adminRoutes;
let scheduler: typeof import("./admin-scheduler");
let server: typeof import("./chat-server").default;
let originalCapability = "";
let currentCapability = "";

beforeAll(async () => {
  dbState = await import("../src/sqlite-state");
  file = (await import("../src/store")).databasePath();
  await dbState.openStateDatabase(file);
  await dbState.withStateTransaction(file, db => {
    db.query("INSERT INTO rooms(id,name,owner_id,created_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','__Test_Admin','op',1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','__Test_Same','op',2),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','__Test_AdminDelete','op',3),('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_Supervisor','op',4),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','__Test_Worker','op',5),('ffffffff-ffff-4fff-8fff-ffffffffffff','__Test_Unrelated','op',6)").run();
    db.query("INSERT INTO participants VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','SupervisorAgent','SupervisorAgent',1),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','WorkerAgent','WorkerAgent',1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','SameAgent','SameAgent',1),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','AdminMember','AdminMember',1),('ffffffff-ffff-4fff-8fff-ffffffffffff','UnrelatedMember','UnrelatedMember',1)").run();
    db.query("INSERT INTO registry(room_id,session_id,server_url,api_prefix,protocol,name,receiver_owner_id,membership_id,host,last_read_ts) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_supervisor-session','','/api','v2','SupervisorAgent','owner-s','member-s','',123),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','','/api','v2','WorkerAgent','owner-w','member-w','',456),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','same-session','','/api','v2','SameAgent','same-owner','same-member','',789),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','admin-member','','/api',NULL,'AdminMember',NULL,'human-member','',0),('ffffffff-ffff-4fff-8fff-ffffffffffff','unrelated-member','','/api',NULL,'UnrelatedMember',NULL,'ordinary-member','',0)").run();
  });
  scheduler = await import("./admin-scheduler");
  routes = (await import("./admin-routes")).adminRoutes;
  server = (await import("./chat-server")).default;
});
afterAll(() => {
  scheduler?.stopAdminScheduler();
  if (previousStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousStateDir;
  if (previousServerToken === undefined) delete process.env.CHAT_ROOM_SERVER_TOKEN;
  else process.env.CHAT_ROOM_SERVER_TOKEN = previousServerToken;
  if (previousAdminToken === undefined) delete process.env.CHAT_ROOM_ADMIN_TOKEN;
  else process.env.CHAT_ROOM_ADMIN_TOKEN = previousAdminToken;
  rmSync(stateDir, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const result = await routes(new Request(`http://localhost${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), new URL(`http://localhost${url}`));
  if (!result) throw new Error(`route not handled: ${url}`);
  return result;
};
const bind = (roomId: string, targetRoomId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID = "__Test_supervisor-session", receiverOwnerID = "owner-s", membershipID = "member-s") =>
  call("POST", "/admin/rooms", { roomId, targetRoomId, sessionID, receiverOwnerID, membershipID }, operator);
const claim = (roomId: string, enrollmentKey: string) => call("POST", `/admin/rooms/${roomId}/claim`, { sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", enrollmentKey });
const deleteRoom = (roomID: string, body: unknown, extraHeaders: Record<string, string> = {}) => server.fetch(new Request(`http://localhost/rooms/${roomID}`, {
  method: "DELETE", headers: { Authorization: "Bearer trusted-shared-secret", "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
}));

test("dispatches durably to another agent and progress is scoped to its membership", async () => {
  expect((await call("POST", "/admin/rooms", { roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetRoomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", membershipID: "member-s" }, { "x-chat-admin-token": "trusted-shared-secret" })).status).toBe(401);
  const created = await bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(created.status).toBe(201);
  expect(created.headers.get("Cache-Control")).toBe("no-store");
  expect((await bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status).toBe(409);
  const issued = await created.json() as { enrollmentKey: string };
  const claims = await Promise.all([claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", issued.enrollmentKey), claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", issued.enrollmentKey)]);
  expect(claims.map(response => response.status).sort()).toEqual([200, 409]);
  expect(claims.find(response => response.status === 200)!.headers.get("Cache-Control")).toBe("no-store");
  const capResponse = claims.find(response => response.status === 200)!;
  const cap = (await capResponse.json() as { capability: string }).capability;
  originalCapability = cap;
  currentCapability = cap;
  const agentHeaders = { "x-chat-admin-capability": cap, "x-chat-agent-session": "__Test_supervisor-session", "x-chat-agent-owner": "owner-s" };
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", undefined, operator)).status).toBe(200);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", undefined, { ...agentHeaders, "x-chat-agent-owner": "forged" })).status).toBe(401);
  expect((await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", { targetRoomId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", targetSessionID: "worker-session", text: "No shared-token bypass" }, { "x-chat-admin-token": "trusted-shared-secret" })).status).toBe(401);
  expect((await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans", { name: "forged", intervalSeconds: 60, text: "No" }, { ...agentHeaders, "x-chat-agent-session": "forged" })).status).toBe(401);
  const sameRoom = await bind("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "same-session", "same-owner", "same-member");
  expect(sameRoom.status).toBe(201);
  const taskResponse = await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", { targetRoomId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", targetSessionID: "worker-session", text: "Run check" }, agentHeaders);
  expect(taskResponse.status).toBe(201);
  const task = (await taskResponse.json() as { task: { id: string } }).task;
  expect((await call("PATCH", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/${task.id}`, { status: "working" }, { "x-chat-admin-capability": cap })).status).toBe(401);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/history?targetRoomId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee&limit=50", undefined, agentHeaders)).status).toBe(200);
  const workerInbox = await call("GET", "/supervision/inbox?sessionID=worker-session&receiverOwnerID=owner-w");
  const deliveries = (await workerInbox.json() as { deliveries: Array<{ id: string; taskToken: string; targetRoomId: string }> }).deliveries;
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.targetRoomId).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  expect((await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s")).status).toBe(200);
  const taskToken = deliveries[0]!.taskToken;
  expect((await call("POST", `/supervision/tasks/${task.id}/progress`, { taskToken, status: "working", progress: "Started" }, { "x-chat-agent-session": "__Test_supervisor-session", "x-chat-agent-owner": "owner-s" })).status).toBe(401);
  expect((await call("POST", `/supervision/tasks/${task.id}/progress`, { taskToken, status: "working", progress: "Started" }, { "x-chat-agent-session": "worker-session", "x-chat-agent-owner": "owner-w" })).status).toBe(200);
  expect((await call("POST", "/supervision/ack", { id: deliveries[0]!.id, sessionID: "worker-session", receiverOwnerID: "owner-w" })).status).toBe(200);
  expect((await call("PATCH", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/${task.id}`, { status: "cancelled" }, agentHeaders)).status).toBe(200);
  expect((await call("POST", `/supervision/tasks/${task.id}/progress`, { taskToken, status: "working", progress: "Resurrect" }, { "x-chat-agent-session": "worker-session", "x-chat-agent-owner": "owner-w" })).status).toBe(401);
  const secondTask = await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", { targetRoomId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", targetSessionID: "worker-session", text: "Second check" }, agentHeaders);
  const secondID = (await secondTask.json() as { task: { id: string } }).task.id;
  const cancelledTask = await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", { targetRoomId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", targetSessionID: "worker-session", text: "Cancel before poll" }, agentHeaders);
  const cancelledID = (await cancelledTask.json() as { task: { id: string } }).task.id;
  expect((await call("PATCH", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/${cancelledID}`, { status: "cancelled" }, agentHeaders)).status).toBe(200);
  await dbState.withStateTransaction(file, db => {
    expect(db.query("SELECT count(*) AS n FROM admin_deliveries WHERE task_id=? AND acknowledged=0").get(cancelledID)).toEqual({ n: 0 });
    expect(db.query("SELECT delivery_token_hash FROM admin_tasks WHERE id=?").get(cancelledID)).toEqual({ delivery_token_hash: "" });
  });
  await dbState.withStateTransaction(file, db => {
    const insert = db.query("INSERT INTO admin_deliveries(id,admin_room_id,generation,recipient_room_id,session_id,owner_id,membership_id,kind,text,task_id,task_token,admission_id,created_at) VALUES(?, ?, 1, ?, 'worker-session','owner-w',?,'task','stale',NULL,NULL,?,?)");
    for (let i = 0; i < 100; i++) insert.run(`stale-${i}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", `old-${i}`, `old-admission-${i}`, i);
  });
  const staleDelivery = await call("GET", "/supervision/inbox?sessionID=worker-session&receiverOwnerID=owner-w");
  const stale = (await staleDelivery.json() as { deliveries: Array<{ id: string }> }).deliveries[0]!;
  expect(stale.id).not.toMatch(/^stale-/);
  await dbState.withStateTransaction(file, db => db.query("UPDATE registry SET membership_id='rejoined' WHERE room_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' AND session_id='worker-session'").run());
  const staleInbox = await call("GET", "/supervision/inbox?sessionID=worker-session&receiverOwnerID=owner-w");
  expect((await staleInbox.json() as { deliveries: unknown[] }).deliveries).toHaveLength(0);
  expect(await (await call("POST", "/supervision/ack", { id: stale.id, sessionID: "worker-session", receiverOwnerID: "owner-w" })).json()).toEqual({ ok: false });
  expect((await call("POST", `/supervision/tasks/${secondID}/progress`, { taskToken: "invalid", status: "working", progress: "x" }, { "x-chat-agent-session": "worker-session", "x-chat-agent-owner": "owner-w" })).status).toBe(401);
  await dbState.withStateTransaction(file, db => {
    expect(db.query("SELECT last_read_ts FROM registry WHERE room_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'").get()).toEqual({ last_read_ts: 456 });
    expect(db.query("SELECT count(*) AS n FROM participants WHERE room_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'").get()).toEqual({ n: 1 });
  });
  const planResponse = await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans", { name: "Check", intervalSeconds: 60, text: "Review" }, agentHeaders);
  expect(planResponse.status).toBe(201);
  const plan = (await planResponse.json() as { plan: { id: string } }).plan;
  const now = Date.now();
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now - 1, plan.id));
  await scheduler.tickAdminScheduler(now);
  const discovery = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s");
  const discoveryData = await discovery.json() as { deliveries: unknown[]; supervisionRoomIds: string[] };
  expect(discoveryData.deliveries).toHaveLength(0);
  expect(discoveryData.supervisionRoomIds).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect((await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status).toBe(401);
  const firstReminder = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, agentHeaders);
  const first = (await firstReminder.json() as { deliveries: Array<{ id: string; admissionID: string }> }).deliveries[0]!;
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now + 1, plan.id));
  await scheduler.tickAdminScheduler(now + 1);
  const coalesced = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, agentHeaders);
  const coalescedDelivery = (await coalesced.json() as { deliveries: Array<{ id: string; admissionID: string }> }).deliveries[0]!;
  expect(coalescedDelivery.id).toBe(first.id);
  expect(coalescedDelivery.admissionID).toBe(first.admissionID);
  expect(await (await call("POST", "/supervision/ack", { id: first.id, sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s" })).json()).toEqual({ ok: false });
  expect((await call("POST", "/supervision/ack", { id: first.id, sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s" }, agentHeaders)).status).toBe(200);
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now + 2, plan.id));
  await scheduler.tickAdminScheduler(now + 2);
  const nextReminder = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, agentHeaders);
  const next = (await nextReminder.json() as { deliveries: Array<{ id: string; admissionID: string }> }).deliveries[0]!;
  expect(next.id).not.toBe(first.id);
  expect(next.admissionID).not.toBe(first.admissionID);
  expect((await call("PATCH", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans/${plan.id}`, { paused: true }, agentHeaders)).status).toBe(200);
  const pausedInbox = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, agentHeaders);
  expect((await pausedInbox.json() as { deliveries: unknown[] }).deliveries).toHaveLength(0);
  const resumed = await call("PATCH", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans/${plan.id}`, { paused: false }, agentHeaders);
  expect((await resumed.json() as { nextRunAt: number }).nextRunAt).toBeGreaterThan(Date.now());
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now + 3, plan.id));
  await scheduler.tickAdminScheduler(now + 3);
  expect((await call("DELETE", `/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans/${plan.id}`, undefined, agentHeaders)).status).toBe(200);
  const deletedInbox = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s");
  expect((await deletedInbox.json() as { deliveries: unknown[] }).deliveries).toHaveLength(0);
});

test("rotation invalidates old capabilities and expired enrollment keys", async () => {
  const rotated = await call("PUT", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { targetRoomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", membershipID: "member-s" }, operator);
  expect(rotated.status).toBe(200);
  const next = await rotated.json() as { enrollmentKey: string };
  const oldHeaders = { "x-chat-admin-capability": originalCapability, "x-chat-agent-session": "__Test_supervisor-session", "x-chat-agent-owner": "owner-s" };
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", undefined, oldHeaders)).status).toBe(401);
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_rooms SET enrollment_expires=0 WHERE room_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").run());
  expect((await claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", next.enrollmentKey)).status).toBe(409);
  const reset = await call("PUT", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { targetRoomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", membershipID: "member-s" }, operator);
  const resetKey = (await reset.json() as { enrollmentKey: string }).enrollmentKey;
  const resetClaim = await claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resetKey);
  expect(resetClaim.status).toBe(200);
  currentCapability = (await resetClaim.json() as { capability: string }).capability;
});

test("a new scheduler process delivers a persisted due timer", async () => {
  const now = Date.now();
  await dbState.withStateTransaction(file, db => db.query("INSERT INTO admin_plans VALUES('restart-plan','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Restart',60,'Persisted',0,?,?)").run(now - 1, now));
  const script = `import('./server/admin-scheduler.ts').then(async s => { await s.tickAdminScheduler(); process.exit(0); }).catch(() => process.exit(1))`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const response = await call("GET", "/supervision/inbox?sessionID=__Test_supervisor-session&receiverOwnerID=owner-s&adminRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, { "x-chat-admin-capability": currentCapability, "x-chat-agent-session": "__Test_supervisor-session", "x-chat-agent-owner": "owner-s" });
  expect((await response.json() as { deliveries: Array<{ text: string }> }).deliveries.some(item => item.text.startsWith("Persisted"))).toBe(true);
});

test("room deletion protects admin anchors but preserves ordinary member deletion", async () => {
  expect((await bind("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).status).toBe(201);
  expect((await deleteRoom("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { sessionID: "admin-member" })).status).toBe(403);
  expect((await deleteRoom("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { sessionID: "admin-member" }, { "X-Chat-Admin-Token": "trusted-shared-secret" })).status).toBe(403);
  expect((await deleteRoom("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { sessionID: "__Test_supervisor-session" })).status).toBe(403);
  const db = await dbState.openStateDatabase(file);
  expect(db.query("SELECT 1 FROM rooms WHERE id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'").get()).toBeTruthy();
  expect(db.query("SELECT 1 FROM rooms WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'").get()).toBeTruthy();
  const adminDeleted = await deleteRoom("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {}, operator);
  if (adminDeleted.status !== 200) throw new Error(`${adminDeleted.status}: ${await adminDeleted.text()}`);
  expect((await deleteRoom("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {}, operator)).status).toBe(200);
  expect(db.query("SELECT 1 FROM admin_rooms WHERE room_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").get()).toBeNull();
  expect((await deleteRoom("ffffffff-ffff-4fff-8fff-ffffffffffff", { sessionID: "outsider" })).status).toBe(409);
  expect((await deleteRoom("ffffffff-ffff-4fff-8fff-ffffffffffff", { sessionID: "unrelated-member" })).status).toBe(200);
});

test("malformed administrator JSON returns a non-cacheable client error", async () => {
  const url = new URL("http://localhost/admin/rooms");
  const response = await routes(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...operator }, body: "{" }), url);
  expect(response?.status).toBe(400);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(await response?.text()).not.toContain("SQLITE");
});
}
