import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-poll-own-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_SERVER_TOKEN;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
const { server } = await import("../plugin");
const { writeState } = await import("./store");

afterAll(async () => {
  delete process.env.CHAT_ROOM_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

test("standalone room poll excludes the agent's own messages", async () => {
  const roomID = await writeState((service, registry) => {
    const room = service.createRoom("poll-own", "agent");
    service.joinRoom(room.id, { id: "agent", name: "agent" });
    service.joinRoom(room.id, { id: "alice", name: "alice" });
    service.sendMessage(room.id, "alice", "peer message", "alice-session");
    service.sendMessage(room.id, "agent", "own message", "agent-session");
    registry[room.id] = {
      "agent-session": { serverUrl: "", apiPrefix: "/api", protocol: "v1", name: "agent", lastReadTs: 0, lastQueuedTs: 0 },
      "alice-session": { serverUrl: "", apiPrefix: "/api", protocol: "v1", name: "alice", lastReadTs: 0, lastQueuedTs: 0 },
    };
    return room.id;
  });
  const hooks = await server({ serverUrl: new URL("http://v1.example"), directory: stateDir } as any);
  try {
    const result = await hooks.tool!.room!.execute(
      { action: "poll", roomId: roomID },
      { sessionID: "agent-session" } as any,
    );
    expect(result).toContain("peer message");
    expect(result).not.toContain("own message");
  } finally {
    await hooks.dispose?.();
  }
}, 30000);