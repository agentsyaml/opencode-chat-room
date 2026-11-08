import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

if (!process.env.CHAT_ROOM_ANNOUNCEMENTS_FIXTURE) {
  test("announcement API fixtures run with isolated server configuration", async () => {
    const child = Bun.spawn([process.execPath, "test", "server/announcement-routes.test.ts"], {
      env: { ...process.env, CHAT_ROOM_ANNOUNCEMENTS_FIXTURE: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${stdout}${stderr}`);
  });
} else {
const directory = mkdtempSync(path.join(tmpdir(), "chat-room-announcement-routes-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
const previousToken = process.env.CHAT_ROOM_SERVER_TOKEN;
process.env.CHAT_ROOM_STATE_DIR = directory;
process.env.CHAT_ROOM_SERVER_TOKEN = "__Test_token";
const store = await import("../src/store");
const { announcementRoutes } = await import("./announcement-routes");
const server = (await import("./chat-server")).default;
const roomID = await store.writeState((service, registry) => {
  const room = service.createRoom("__Test_routes", "owner");
  registry[room.id] = { member: { serverUrl: "", apiPrefix: "", name: "member" } };
  return room.id;
});
const call = (method: string, path: string, body?: unknown) => announcementRoutes(new Request(`http://localhost${path}`, {
  method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), new URL(`http://localhost${path}`));

afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  if (previousToken === undefined) delete process.env.CHAT_ROOM_SERVER_TOKEN;
  else process.env.CHAT_ROOM_SERVER_TOKEN = previousToken;
  rmSync(directory, { recursive: true, force: true });
});

test("announcement routes permit cross-room reads without joining and gate writes", async () => {
  const authPath = `/rooms/${roomID}/announcements`;
  expect((await server.fetch(new Request(`http://localhost${authPath}`)))?.status).toBe(401);
  expect((await server.fetch(new Request(`http://localhost${authPath}`, { headers: { Authorization: "Bearer __Test_token" } })))?.status).toBe(200);
  expect((await server.fetch(new Request(`http://localhost${authPath}/bad`, { method: "PUT", headers: { Authorization: "Bearer __Test_token", "Content-Type": "text/plain" }, body: "{}" }))).status).toBe(415);
  expect((await call("PUT", `/rooms/${roomID}/announcements/plan`, { sessionID: "outsider", content: "x" }))?.status).toBe(403);
  expect((await call("PUT", `/rooms/${roomID}/announcements/missing`, { sessionID: "member" }))?.status).toBe(400);
  expect((await call("PUT", `/rooms/${roomID}/announcements/missing`, { sessionID: "member", content: null }))?.status).toBe(400);
  expect((await call("PUT", `/rooms/${roomID}/announcements/missing`, { sessionID: "member", content: 1 }))?.status).toBe(400);
  expect((await call("PUT", `/rooms/${roomID}/announcements/plan`, { sessionID: "member", content: "x" }))?.status).toBe(200);
  expect((await call("PUT", `/rooms/${roomID}/announcements/empty`, { sessionID: "member", content: "" }))?.status).toBe(200);
  expect((await call("GET", `/rooms/${roomID}/announcements/plan`))?.status).toBe(200);
  expect((await call("GET", `/rooms/${roomID}/announcements/%20`))?.status).toBe(400);
  expect((await call("PUT", `/rooms/${roomID}/announcements/long`, { sessionID: "member", content: "😀".repeat(5001) }))?.status).toBe(400);
  expect((await store.loadRegistry())[roomID]).toHaveProperty("member");
  expect((await call("DELETE", `/rooms/${roomID}/announcements/plan`, { sessionID: "member" }))?.status).toBe(200);
  expect((await call("DELETE", `/rooms/${roomID}/announcements/plan`, { sessionID: "member" }))?.status).toBe(404);
});
}
