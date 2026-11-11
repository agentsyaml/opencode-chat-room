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
let server: typeof import("./chat-server").default;

beforeAll(async () => {
  dbState = await import("../src/sqlite-state");
  file = (await import("../src/store")).databasePath();
  await dbState.openStateDatabase(file);
  await dbState.withStateTransaction(file, db => {
    db.query("INSERT INTO rooms(id,name,owner_id,created_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','__Test_Admin','op',1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','__Test_Same','op',2),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','__Test_AdminDelete','op',3),('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_Supervisor','op',4),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','__Test_Worker','op',5),('ffffffff-ffff-4fff-8fff-ffffffffffff','__Test_Unrelated','op',6)").run();
    db.query("INSERT INTO participants VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','SupervisorAgent','SupervisorAgent',1),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','WorkerAgent','WorkerAgent',1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','SameAgent','SameAgent',1),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','AdminMember','AdminMember',1),('ffffffff-ffff-4fff-8fff-ffffffffffff','UnrelatedMember','UnrelatedMember',1)").run();
    db.query("INSERT INTO registry(room_id,session_id,server_url,api_prefix,protocol,name,receiver_owner_id,membership_id,host,last_read_ts) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_supervisor-session','','/api','v2','SupervisorAgent','owner-s','member-s','',123),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','','/api','v2','WorkerAgent','owner-w','member-w','',456),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','same-session','','/api','v2','SameAgent','same-owner','same-member','',789),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','admin-member','','/api',NULL,'AdminMember',NULL,'human-member','',0),('ffffffff-ffff-4fff-8fff-ffffffffffff','unrelated-member','','/api',NULL,'UnrelatedMember',NULL,'ordinary-member','',0)").run();
  });
  routes = (await import("./admin-routes")).adminRoutes;
  server = (await import("./chat-server")).default;
});
afterAll(() => {
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

test("legacy task, plan, and delivery records are deleted once without affecting bindings", async () => {
  expect((await bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status).toBe(201);
  await dbState.initializeReminderSchema(file);
  const now = Date.now();
  await dbState.withStateTransaction(file, db => {
    db.query("DELETE FROM server_admin_migrations WHERE version=1").run();
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at) VALUES('keep-message','ffffffff-ffff-4fff-8fff-ffffffffffff','UnrelatedMember','unrelated-member','Keep',?)").run(now);
    db.query("INSERT INTO room_reminders(id,room_id,creator_session_id,text,schedule_type,at,expression,timezone,paused,next_run_at,created_at,last_error,initiator) VALUES('keep-reminder','ffffffff-ffff-4fff-8fff-ffffffffffff','unrelated-member','Keep','once',NULL,NULL,NULL,0,?,?,NULL,'unrelated-member')").run(now, now);
    db.query("INSERT INTO admin_tasks(id,admin_room_id,admin_generation,target_room_id,target_session_id,target_owner_id,target_membership_id,text,status,progress,delivery_token_hash,created_at,updated_at) VALUES('legacy-task','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','owner-w','member-w','Keep','pending','','',?,?)").run(now, now);
    db.query("INSERT INTO admin_plans VALUES('legacy-plan','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Keep',60,'Persisted',0,?,?)").run(now - 1, now);
    db.query("INSERT INTO admin_deliveries(id,admin_room_id,generation,recipient_room_id,session_id,owner_id,membership_id,kind,text,task_id,admission_id,created_at) VALUES('legacy-delivery','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','owner-w','member-w','task','Keep','legacy-task','admin:legacy',?)").run(now);
    db.query("INSERT INTO admin_deliveries(id,admin_room_id,generation,recipient_room_id,session_id,owner_id,membership_id,kind,text,task_id,admission_id,created_at) VALUES('other-delivery','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','owner-w','member-w','other','Keep',NULL,'msg_keep',?)").run(now);
  });
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", undefined, operator)).status).toBe(404);
  expect((await call("POST", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans", {}, operator)).status).toBe(404);
  expect((await call("GET", "/supervision/inbox?sessionID=worker-session&receiverOwnerID=owner-w")).status).toBe(404);
  await dbState.withStateTransaction(file, db => {
    expect(db.query("SELECT id FROM admin_tasks WHERE id='legacy-task'").get()).toBeNull();
    expect(db.query("SELECT id FROM admin_plans WHERE id='legacy-plan'").get()).toBeNull();
    expect(db.query("SELECT id FROM admin_deliveries WHERE id='legacy-delivery'").get()).toBeNull();
    expect(db.query("SELECT kind,text FROM admin_deliveries WHERE id='other-delivery'").get()).toEqual({ kind: "other", text: "Keep" });
    expect(db.query("SELECT room_id FROM admin_rooms WHERE room_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").get()).toBeTruthy();
    expect(db.query("SELECT text FROM messages WHERE id='keep-message'").get()).toEqual({ text: "Keep" });
    expect(db.query("SELECT text FROM room_reminders WHERE id='keep-reminder'").get()).toEqual({ text: "Keep" });
  });
  expect((await call("GET", "/supervision/inbox?sessionID=worker-session&receiverOwnerID=owner-w")).status).toBe(404);
});

test("rotation invalidates old capabilities and expired enrollment keys", async () => {
  const rotated = await call("PUT", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { targetRoomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", membershipID: "member-s" }, operator);
  expect(rotated.status).toBe(200);
  const next = await rotated.json() as { enrollmentKey: string };
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks", undefined, operator)).status).toBe(404);
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_rooms SET enrollment_expires=0 WHERE room_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").run());
  expect((await claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", next.enrollmentKey)).status).toBe(409);
  const reset = await call("PUT", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { targetRoomId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", membershipID: "member-s" }, operator);
  const resetKey = (await reset.json() as { enrollmentKey: string }).enrollmentKey;
  const resetClaim = await claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resetKey);
  expect(resetClaim.status).toBe(200);
  expect((await resetClaim.json() as { capability: string }).capability).toBeTruthy();
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
