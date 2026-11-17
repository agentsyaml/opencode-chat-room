import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const childMode = process.env.CHAT_ROOM_ADMINS_CHILD === "1";
if (!childMode) {
  test("runs room admin fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "room-admins-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_ADMINS_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_TOKEN: "admins-test-token",
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
const dir = mkdtempSync(path.join(os.tmpdir(), "room-admins-"));
process.env.HOME = path.join(dir, "home");
process.env.XDG_STATE_HOME = path.join(dir, "state");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.CHAT_ROOM_SERVER_TOKEN = "admins-test-token";
process.env.CHAT_ROOM_STATE_DIR = dir;
const { default: server } = await import("../../server/chat-server");

const auth = { Authorization: "Bearer admins-test-token" };
async function call(route: string, method = "GET", body?: unknown) {
  return server.fetch(new Request(`http://local${route}`, {
    method, headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
const makeRoom = async (name: string, ...members: Array<[string, string, boolean]>) => {
  const created = await (await call("/rooms", "POST", { name, ownerId: "alice", sessionID: "alice" })).json() as { id: string };
  for (const [sessionID, memberName, agent] of members) {
    await call(`/rooms/${created.id}/join`, "POST", { sessionID, participantId: sessionID, participantName: memberName, ...(agent ? { protocol: "v2" } : {}) });
  }
  return created.id;
};
const upload = (roomId: string, sessionID: string, name: string) => server.fetch(new Request(`http://local/rooms/${roomId}/resources`, {
  method: "POST", headers: { ...auth, "x-session-id": sessionID, "x-file-name": encodeURIComponent(name) }, body: new Blob(["hello"]),
}));

describe.serial("human room administrators", () => {
  test("delegated humans edit and remove members; agents cannot", async () => {
    const roomId = await makeRoom("admins", ["bob", "bob", false], ["carol", "carol", false], ["agent-1", "agent-1", true], ["agent-2", "agent-2", true]);
    expect((await call(`/rooms/${roomId}/kick`, "POST", { sessionID: "agent-1", targetSessionID: "agent-2" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "agent-1", description: "agent edit" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", description: "human edit" })).status).toBe(403);
    const promote = await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob"] });
    expect(promote.status).toBe(200);
    expect(await promote.json()).toMatchObject({ ownerId: "alice", adminIds: ["bob"] });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", description: "human edit" })).status).toBe(200);
    const delegated = await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", adminIds: ["bob", "carol"] });
    expect(delegated.status).toBe(200);
    expect(await delegated.json()).toMatchObject({ adminIds: ["bob", "carol"] });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "carol", description: "delegated edit" })).status).toBe(200);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", successorId: "carol" })).status).toBe(200);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", ownerId: "bob" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", adminSessionID: "agent-1" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["agent-1"] })).status).toBe(409);
    expect((await call(`/rooms/${roomId}/kick`, "POST", { sessionID: "bob", targetSessionID: "alice" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}/kick`, "POST", { sessionID: "bob", targetSessionID: "agent-1" })).status).toBe(200);
    expect((await call(`/rooms/${roomId}`, "DELETE", { sessionID: "bob" })).status).toBe(403);
  });

  test("admins follow the people left in the room", async () => {
    const roomId = await makeRoom("succession", ["bob", "bob", false], ["agent-3", "agent-3", true]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob"] });
    await call(`/rooms/${roomId}/leave`, "POST", { sessionID: "alice" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ ownerId: "bob", adminIds: [] });
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", adminIds: [] });
    const agentEdit = await call(`/rooms/${roomId}`, "PATCH", { sessionID: "agent-3", description: "still an agent" });
    expect(agentEdit.status).toBe(403);
  });

  test("a departing admin drops out of the roster", async () => {
    const roomId = await makeRoom("admin-leave", ["bob", "bob", false], ["carol", "carol", false]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob", "carol"] });
    await call(`/rooms/${roomId}/leave`, "POST", { sessionID: "bob" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ ownerId: "alice", adminIds: ["carol"] });
  });

  test("an explicit successor takes the room before the earliest human", async () => {
    const roomId = await makeRoom("successor", ["bob", "bob", false], ["carol", "carol", false]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", successorId: "carol" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ successorId: "carol" });
    await call(`/rooms/${roomId}/leave`, "POST", { sessionID: "alice" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ ownerId: "carol", successorId: null });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", description: "not owner" })).status).toBe(403);
  });

  test("a same-name session does not inherit ownership or delegation", async () => {
    const roomId = await makeRoom("binding", ["bob", "bob", false]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob"] });
    await call(`/rooms/${roomId}/join`, "POST", { sessionID: "mallory", participantId: "alice", participantName: "alice" });
    await call(`/rooms/${roomId}/join`, "POST", { sessionID: "eve", participantId: "bob", participantName: "bob" });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "mallory", description: "spoofed owner" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "eve", description: "spoofed admin" })).status).toBe(403);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", description: "real owner" })).status).toBe(200);
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "bob", description: "real admin" })).status).toBe(200);
    expect((await call(`/rooms/${roomId}`, "DELETE", { sessionID: "mallory" })).status).toBe(403);
  });

  test("owner membership follows a rename on the same session", async () => {
    const roomId = await makeRoom("rename");
    await call(`/rooms/${roomId}/join`, "POST", { sessionID: "alice", participantId: "alice-2", participantName: "alice-2" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ ownerId: "alice-2" });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", description: "still owner" })).status).toBe(200);
  });

  test("a delegated admin passes the role to the explicit successor", async () => {
    const roomId = await makeRoom("admin-successor", ["bob", "bob", false], ["carol", "carol", false]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob"] });
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", successorId: "carol" });
    await call(`/rooms/${roomId}/leave`, "POST", { sessionID: "bob" });
    expect(await (await call(`/rooms/${roomId}`)).json()).toMatchObject({ ownerId: "alice", adminIds: ["carol"] });
    expect((await call(`/rooms/${roomId}`, "PATCH", { sessionID: "carol", description: "successor edit" })).status).toBe(200);
  });

  test("resources are deletable by their uploader or a human admin only", async () => {
    const roomId = await makeRoom("resources", ["bob", "bob", false], ["dave", "dave", false], ["agent-4", "agent-4", true], ["agent-5", "agent-5", true]);
    await call(`/rooms/${roomId}`, "PATCH", { sessionID: "alice", adminIds: ["bob"] });
    const first = await (await upload(roomId, "agent-4", "first.txt")).json() as { resource: { id: string } };
    const remove = (id: string, sessionID: string) => server.fetch(new Request(`http://local/rooms/${roomId}/resources/${id}`, {
      method: "DELETE", headers: { ...auth, "Content-Type": "application/json", "x-session-id": sessionID }, body: "{}",
    }));
    expect((await remove(first.resource.id, "agent-5")).status).toBe(403);
    expect((await remove(first.resource.id, "bob")).status).toBe(200);
    expect((await call(`/rooms/${roomId}/resources/${first.resource.id}`)).status).toBe(404);
    const second = await (await upload(roomId, "agent-4", "second.txt")).json() as { resource: { id: string } };
    expect((await remove(second.resource.id, "agent-4")).status).toBe(200);
    const humanFile = await (await upload(roomId, "dave", "human.txt")).json() as { resource: { id: string } };
    expect((await remove(humanFile.resource.id, "dave")).status).toBe(403);
    expect((await remove(humanFile.resource.id, "bob")).status).toBe(200);
  });
});

afterAll(async () => {
  for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  await fs.rm(dir, { recursive: true, force: true });
});
}