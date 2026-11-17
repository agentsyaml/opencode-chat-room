import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const childMode = process.env.CHAT_ROOM_AGENT_KICK_CHILD === "1";
if (!childMode) {
  test("runs agent kick fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-kick-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_AGENT_KICK_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_TOKEN: "agent-kick-token",
        CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_WAKE_SERVE_URL: "" }, stdout: "pipe", stderr: "pipe",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`);
    await fs.rm(dir, { recursive: true, force: true });
  });
} else {
const keys = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "CHAT_ROOM_STATE_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "HOME"] as const;
const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_WAKE_SERVE_URL"]) delete process.env[key];
const dir = mkdtempSync(path.join(os.tmpdir(), "agent-kick-"));
process.env.HOME = path.join(dir, "home");
process.env.XDG_STATE_HOME = path.join(dir, "state");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.CHAT_ROOM_SERVER_TOKEN = "agent-kick-token";
process.env.CHAT_ROOM_STATE_DIR = dir;
const { default: server } = await import("./chat-server");
const auth = { Authorization: "Bearer agent-kick-token" };

async function call(route: string, method = "GET", body?: unknown) {
  return server.fetch(new Request(`http://local${route}`, {
    method, headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
async function makeRoom(name: string) {
  const room = await (await call("/rooms", "POST", { name, ownerId: "alice", sessionID: "alice" })).json() as { id: string };
  return room.id;
}
async function join(roomId: string, sessionID: string, agent: boolean) {
  const response = await call(`/rooms/${roomId}/join`, "POST", { sessionID, participantId: sessionID, participantName: sessionID, ...(agent ? { protocol: "v2" } : {}) });
  expect(response.status).toBe(201);
}
const kick = (roomId: string, actor: string, target: string, agentHeaders = false) =>
  server.fetch(new Request(`http://local/rooms/${roomId}/kick`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json", ...(agentHeaders ? { "x-chat-agent-session": actor, "x-chat-agent-owner": "" } : {}) },
    body: JSON.stringify({ sessionID: actor, targetSessionID: target }),
  }));

test("designated agent admins remove members but never human administrators", async () => {
  const roomId = await makeRoom("agent-kick");
  await join(roomId, "delegate", false);
  await join(roomId, "human-member", false);
  await join(roomId, "human-two", false);
  await join(roomId, "agent-admin", true);
  await join(roomId, "agent-normal", true);
  await join(roomId, "agent-other", true);
  expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["delegate"] })).status).toBe(200);
  expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminSessionID: "agent-admin" })).status).toBe(200);
  expect((await kick(roomId, "agent-admin", "agent-other", true)).status).toBe(200);
  expect((await kick(roomId, "agent-admin", "human-two", true)).status).toBe(200);
  expect((await kick(roomId, "agent-admin", "delegate", true)).status).toBe(403);
  expect((await kick(roomId, "agent-admin", "alice", true)).status).toBe(403);
  expect((await kick(roomId, "agent-normal", "human-member", true)).status).toBe(403);
  expect((await kick(roomId, "delegate", "human-member")).status).toBe(200);
});

test("a designation does not authorize another room", async () => {
  const first = await makeRoom("designated");
  const second = await makeRoom("other");
  await join(first, "agent-admin", true);
  await join(second, "agent-admin", true);
  await join(second, "target", false);
  expect((await call(`/rooms/${first}`, "PATCH", { sessionID: "alice", adminSessionID: "agent-admin" })).status).toBe(200);
  expect((await kick(second, "agent-admin", "target", true)).status).toBe(403);
});
afterAll(() => {
  for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  rmSync(dir, { recursive: true, force: true });
});
}