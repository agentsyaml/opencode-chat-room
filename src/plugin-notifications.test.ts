import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { QueueTransport } from "./queue-transport";

delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_SERVER_TOKEN;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
const sandbox = mkdtempSync(path.join(tmpdir(), "chat-room-notifier-"));
process.env.HOME = `${sandbox}/home`;
process.env.XDG_CONFIG_HOME = `${sandbox}/config`;
process.env.XDG_STATE_HOME = `${sandbox}/state`;
process.env.CHAT_ROOM_STATE_DIR = `${sandbox}/chat-room`;

const [{ createNotifier }, store, queue] = await Promise.all([
  import("./plugin-notifications"), import("./store"), import("./queue"),
]);

const sessionID = "notifier-session";
const roomID = `room-${crypto.randomUUID()}`;
const msg = { id: "message-1", roomId: roomID, senderId: "alice", senderSessionID: "other", text: "@bob please look", createdAt: 100 };

async function registry(lastQueuedTs?: number) {
  await store.saveRegistry({ [roomID]: { [sessionID]: {
    serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0, lastQueuedTs,
  } } });
}

function notifier(transport: QueueTransport, bumpQueued: (ts: number) => Promise<boolean>) {
  return createNotifier({ transport: () => transport, bumpQueued: (_room, _session, ts) => bumpQueued(ts) });
}

describe("local V2 notification admission", () => {
  test("retries backgrounding per pending attempt and retains the admission ID", async () => {
    await registry();
    let backgrounds = 0;
    let bumps = 0;
    const ids: string[] = [];
    let send = 0;
    const transport = {
      protocol: "v2" as const,
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async (_sid: string, id: string, _text: string, delivery: "queue" | "steer") => {
        ids.push(id);
        if (send++ === 0) throw Error("temporary refusal");
        return { id, sessionID, delivery };
      },
    };
    const target = notifier(transport, async (ts) => {
      bumps++;
      const saved = await store.loadRegistry();
      saved[roomID]![sessionID]!.lastQueuedTs = ts;
      await store.saveRegistry(saved);
      queue.clearPendingAdmission(sessionID, roomID, ts);
      return true;
    });
    expect((await target.notifyTarget(sessionID, { roomId: roomID, roomName: "dev", messages: [msg] }))?.status).toBe(0);
    expect((await store.loadRegistry())[roomID]![sessionID]!.lastQueuedTs).toBeUndefined();
    expect((await target.notifyTarget(sessionID, { roomId: roomID, roomName: "dev", messages: [msg] }))?.status).toBe(200);
    expect(backgrounds).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(bumps).toBe(1);
  });

  test("serializes local delivery across notifier instances and commits only once", async () => {
    const concurrentRoom = `room-${crypto.randomUUID()}`;
    await store.saveRegistry({ [concurrentRoom]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0,
    } } });
    let backgrounds = 0;
    let sends = 0;
    let bumps = 0;
    const transport: QueueTransport = {
      protocol: "v2",
      backgroundSession: async () => { backgrounds++; await new Promise((resolve) => setTimeout(resolve, 20)); return true; },
      promptQueue: async (sid, id, _text, delivery) => {
        sends++;
        return { id, sessionID: sid, delivery };
      },
    };
    const bump = async (ts: number) => {
      bumps++;
      const saved = await store.loadRegistry();
      saved[concurrentRoom]![sessionID]!.lastQueuedTs = ts;
      await store.saveRegistry(saved);
      queue.clearPendingAdmission(sessionID, concurrentRoom, ts);
      return true;
    };
    const batch = { roomId: concurrentRoom, roomName: "dev", messages: [{ ...msg, roomId: concurrentRoom }] };
    await Promise.all([
      notifier(transport, bump).notifyTarget(sessionID, batch),
      notifier(transport, bump).notifyTarget(sessionID, batch),
    ]);
    expect(backgrounds).toBe(1);
    expect(sends).toBe(1);
    expect(bumps).toBe(1);
  });

  test("does not background for a newer mention absent from the pending prompt", async () => {
    const pendingRoom = `room-${crypto.randomUUID()}`;
    await store.saveRegistry({ [pendingRoom]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0,
    } } });
    let attempts = 0;
    let backgrounds = 0;
    const ids: string[] = [];
    const transport: QueueTransport = {
      protocol: "v2",
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async (sid, id, text, delivery) => {
        ids.push(id);
        if (attempts++ === 0) throw Error("offline");
        expect(text).not.toContain("@bob please");
        return { id, sessionID: sid, delivery };
      },
    };
    const target = notifier(transport, async () => false);
    await target.notifyTarget(sessionID, { roomId: pendingRoom, roomName: "dev", messages: [{ ...msg, roomId: pendingRoom, text: "hello" }] });
    await target.notifyTarget(sessionID, { roomId: pendingRoom, roomName: "dev", messages: [
      { ...msg, roomId: pendingRoom, text: "hello" },
      { ...msg, id: "new-message", roomId: pendingRoom, createdAt: 101, text: "@bob please" },
    ] });
    expect(backgrounds).toBe(0);
    expect(ids[0]).toBe(ids[1]);
  });
});
