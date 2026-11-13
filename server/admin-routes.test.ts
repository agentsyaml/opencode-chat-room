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
const stateDir = mkdtempSync(path.join(tmpdir(), "chat-room-admin-routes-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
process.env.CHAT_ROOM_SERVER_TOKEN = "trusted-shared-secret";
let file: string;
let dbState: typeof import("../src/sqlite-state");
let store: typeof import("../src/store");
let routes: typeof import("./admin-routes").adminRoutes;
let server: typeof import("./chat-server").default;

beforeAll(async () => {
  dbState = await import("../src/sqlite-state");
  store = await import("../src/store");
  file = store.databasePath();
  await dbState.openStateDatabase(file);
  await dbState.withStateTransaction(file, db => {
    db.query("INSERT INTO rooms(id,name,owner_id,created_at,kind) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','__Test_Admin','SupervisorAgent',1,'group'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','__Test_Same','SameAgent',2,'group'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','__Test_AdminDelete','AdminMember',3,'group'),('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_Supervisor','SupervisorAgent',4,'group'),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','__Test_Worker','WorkerAgent',5,'group'),('ffffffff-ffff-4fff-8fff-ffffffffffff','__Test_Unrelated','UnrelatedMember',6,'group')").run();
    db.query("INSERT INTO participants VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','SupervisorAgent','SupervisorAgent',1),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','WorkerAgent','WorkerAgent',1),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','SameAgent','SameAgent',1),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','AdminMember','AdminMember',1),('ffffffff-ffff-4fff-8fff-ffffffffffff','UnrelatedMember','UnrelatedMember',1)").run();
    db.query("INSERT INTO participants VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','SupervisorAgent','SupervisorAgent',1)").run();
    db.query("INSERT INTO registry(room_id,session_id,server_url,api_prefix,protocol,name,receiver_owner_id,membership_id,host,last_read_ts) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','__Test_supervisor-session','','/api','v2','SupervisorAgent','owner-s','member-s','',123),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','worker-session','','/api','v2','WorkerAgent','owner-w','member-w','',456),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','same-session','','/api','v2','SameAgent','same-owner','same-member','',789),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','admin-member','','/api',NULL,'AdminMember',NULL,'human-member','',0),('ffffffff-ffff-4fff-8fff-ffffffffffff','unrelated-member','','/api',NULL,'UnrelatedMember',NULL,'ordinary-member','',0)").run();
    db.query("UPDATE registry SET protocol='v2',receiver_owner_id='owner-c' WHERE room_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' AND session_id='admin-member'").run();
  });
  routes = (await import("./admin-routes")).adminRoutes;
  server = (await import("./chat-server")).default;
  await store.writeState((_service, registry) => {
    for (const [room, session, name, owner, member] of [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "__Test_supervisor-session", "SupervisorAgent", "owner-s", "member-s"],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "same-session", "SameAgent", "same-owner", "same-member"],
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "admin-member", "AdminMember", "owner-c", "human-member"],
    ] as const) registry[room] = { [session]: { serverUrl: "", apiPrefix: "/api", ...(owner ? { protocol: "v2" as const, receiverOwnerID: owner } : {}), name, membershipID: member } };
  });
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousStateDir;
  if (previousServerToken === undefined) delete process.env.CHAT_ROOM_SERVER_TOKEN;
  else process.env.CHAT_ROOM_SERVER_TOKEN = previousServerToken;
  rmSync(stateDir, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const result = await routes(new Request(`http://localhost${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), new URL(`http://localhost${url}`));
  if (!result) throw new Error(`route not handled: ${url}`);
  return result;
};
const designate = (roomID: string, sessionID: string) => server.fetch(new Request(`http://localhost/rooms/${roomID}`, {
  method: "PATCH", headers: { Authorization: "Bearer trusted-shared-secret", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID, adminSessionID: sessionID }),
}));
const claim = (roomId: string, enrollmentKey: string) => call("POST", `/admin/rooms/${roomId}/claim`, { sessionID: "__Test_supervisor-session", receiverOwnerID: "owner-s", enrollmentKey });
const deleteRoom = (roomID: string, body: unknown, extraHeaders: Record<string, string> = {}) => server.fetch(new Request(`http://localhost/rooms/${roomID}`, {
  method: "DELETE", headers: { Authorization: "Bearer trusted-shared-secret", "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
}));

test("owner designation authorizes only the bound agent identity and can be revoked", async () => {
  expect((await designate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "__Test_supervisor-session")).status).toBe(200);
  const headers = { "x-chat-agent-session": "__Test_supervisor-session", "x-chat-agent-owner": "owner-s" };
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/overview", undefined, headers)).status).toBe(200);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/history?targetRoomId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, headers)).status).toBe(200);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/overview", undefined, { ...headers, "x-chat-agent-session": "same-session" })).status).toBe(401);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/overview", undefined, { ...headers, "x-chat-agent-owner": "wrong-owner" })).status).toBe(401);
  expect((await designate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "__Test_supervisor-session")).status).toBe(200);
  const revoke = await server.fetch(new Request("http://localhost/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { method: "PATCH", headers: { Authorization: "Bearer trusted-shared-secret", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: "__Test_supervisor-session", adminSessionID: null }) }));
  expect(revoke.status).toBe(200);
  expect((await call("GET", "/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/overview", undefined, headers)).status).toBe(404);
});

test("legacy claim still accepts the issued enrollment key", async () => {
  await designate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "same-session");
  const { digest } = await import("./admin-state");
  await dbState.withStateTransaction(file, db => db.query("UPDATE admin_rooms SET enrollment_hash=?,enrollment_expires=? WHERE room_id=?").run(digest("legacy-key"), Date.now() + 60_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  const result = await call("POST", "/admin/rooms/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/claim", { sessionID: "same-session", receiverOwnerID: "same-owner", enrollmentKey: "legacy-key" });
  expect(result.status).toBe(200);
  expect((await result.json() as { capability: string }).capability).toBeTruthy();
});

test("room members can delete designated admin rooms and cascade bindings", async () => {
  expect((await designate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "admin-member")).status).toBe(200);
  const db = await dbState.openStateDatabase(file);
  expect(db.query("SELECT 1 FROM rooms WHERE id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'").get()).toBeTruthy();
  const adminDeleted = await deleteRoom("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { sessionID: "admin-member" });
  if (adminDeleted.status !== 200) throw new Error(`${adminDeleted.status}: ${await adminDeleted.text()}`);
  expect(db.query("SELECT 1 FROM admin_rooms WHERE room_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'").get()).toBeNull();
  expect((await deleteRoom("ffffffff-ffff-4fff-8fff-ffffffffffff", { sessionID: "outsider" })).status).toBe(409);
  expect((await deleteRoom("ffffffff-ffff-4fff-8fff-ffffffffffff", { sessionID: "unrelated-member" })).status).toBe(200);
});

test("malformed administrator JSON returns a non-cacheable client error", async () => {
  const url = new URL("http://localhost/admin/rooms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/claim");
  const response = await routes(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), url);
  expect(response?.status).toBe(400);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(await response?.text()).not.toContain("SQLITE");
});
}
