import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(4)) delete process.env[key];
const root = mkdtempSync(path.join(tmpdir(), "chat-room-sqlite-"));
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "state-data");
const store = await import("./store");
const { pollKnownSessions } = await import("../plugin");
const { closeReceiverState } = await import("./receiver-state");

function directory(name: string) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SQLite local state", () => {
  test("migrates complete JSON history once and keeps working window bounded", async () => {
    const dir = await directory("migration");
    process.env.CHAT_ROOM_STATE_DIR = dir;
    const messages = Array.from({ length: 650 }, (_, i) => ({ id: `m${i + 1}`, roomId: "r", senderId: "alice", text: `message ${i + 1}`, createdAt: i + 1 }));
    const oldRooms = JSON.stringify([{ id: "r", name: "room", ownerId: "alice", createdAt: 1, participants: [{ id: "alice", name: "Alice", joinedAt: 1 }], messages }]);
    const oldRegistry = JSON.stringify({ r: { session: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: "owner", name: "Alice", lastReadTs: 41, lastQueuedTs: 42 } } });
    writeFileSync(path.join(dir, "rooms.json"), oldRooms);
    writeFileSync(path.join(dir, "registry.json"), oldRegistry);
    expect((await store.loadRooms())[0]!.messages.map((m) => m.id)).toEqual(messages.slice(-500).map((m) => m.id));
    expect((await store.loadRegistry()).r!.session).toMatchObject({ lastReadTs: 41, lastQueuedTs: 42, receiverOwnerID: "owner" });
    let seq: number | undefined;
    let total = 0;
    do {
      const page = await store.readHistory("r", seq, 100);
      total += page.messages.length;
      seq = page.nextBeforeSeq ?? undefined;
      if (!page.hasMore) break;
    } while (true);
    expect(total).toBe(650);
    expect(readFileSync(path.join(dir, "rooms.json"), "utf8")).toBe(oldRooms);
    expect(readFileSync(path.join(dir, "registry.json"), "utf8")).toBe(oldRegistry);
    const first = await store.readUnreadMessages("r", 0, 100);
    const second = await store.readUnreadMessages("r", 100, 100);
    expect(first.items.map((m) => m.id)).toEqual(messages.slice(0, 100).map((m) => m.id));
    expect(first.hasMore).toBe(true);
    expect(second.items[0]?.id).toBe("m101");
  });

  test("fails closed on malformed migration input and preserves originals", async () => {
    const dir = await directory("bad-migration");
    process.env.CHAT_ROOM_STATE_DIR = dir;
    writeFileSync(path.join(dir, "rooms.json"), "{broken");
    writeFileSync(path.join(dir, "registry.json"), "{}");
    await expect(store.loadRooms()).rejects.toThrow();
    expect(readFileSync(path.join(dir, "rooms.json"), "utf8")).toBe("{broken");
    const registryDir = await directory("bad-registry");
    process.env.CHAT_ROOM_STATE_DIR = registryDir;
    writeFileSync(path.join(registryDir, "rooms.json"), "[]");
    writeFileSync(path.join(registryDir, "registry.json"), "[]");
    await expect(store.loadRegistry()).rejects.toThrow();
    expect(readFileSync(path.join(registryDir, "registry.json"), "utf8")).toBe("[]");
  });

  test("rolls back room and registry changes together", async () => {
    const dir = await directory("rollback");
    process.env.CHAT_ROOM_STATE_DIR = dir;
    await expect(store.writeState((service, registry) => {
      const room = service.createRoom("temporary", "owner");
      registry[room.id] = { session: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "owner" } };
      throw Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await store.loadRooms()).toEqual([]);
    expect(await store.loadRegistry()).toEqual({});
  });

  test("excludes self traffic before the unread window and drains mention-qualified pages", async () => {
    const dir = await directory("restored-pages");
    process.env.CHAT_ROOM_STATE_DIR = dir;
    const ownerID = "123e4567-e89b-42d3-a456-426614174000";
    const sessionIDs = ["self-target", "backlog-target"];
    const roomIDs = await store.writeState((service, registry) => {
      const selfRoom = service.createRoom("self", "alice");
      for (let i = 0; i < 20; i++) service.sendMessage(selfRoom.id, "alice", `self-${i}`, sessionIDs[0]);
      service.sendMessage(selfRoom.id, "alice", "@bob direct", "sender");
      const backlogRoom = service.createRoom("backlog", "alice");
      for (let i = 0; i < 100; i++) service.sendMessage(backlogRoom.id, "alice", `ordinary-${i}`, "sender");
      service.sendMessage(backlogRoom.id, "alice", "@bob later", "sender");
      for (const [roomID, sessionID] of [[selfRoom.id, sessionIDs[0]!], [backlogRoom.id, sessionIDs[1]!]] as const) {
        registry[roomID] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "bob", lastReadTs: 0, lastQueuedTs: 0 } };
      }
      return [selfRoom.id, backlogRoom.id] as const;
    });
    const sent: Array<{ sessionID: string; text: string; delivery: string }> = [];
    let backgrounded = 0;
    const transport = {
      protocol: "v2" as const, receiverOwnerID: ownerID, mentionOnlySessions: new Set(sessionIDs),
      backgroundSession: async () => { backgrounded++; return true; },
      promptQueue: async (sessionID: string, id: string, text: string, delivery: "queue" | "steer") => {
        sent.push({ sessionID, text, delivery });
        return { id, sessionID, delivery };
      },
    };
    await pollKnownSessions(new Set(sessionIDs), transport, { center: "", token: "" });
    expect(sent[0]?.text).toContain("@bob direct");
    expect(backgrounded).toBe(1);
    for (let i = 0; i < 5; i++) await pollKnownSessions(new Set([sessionIDs[1]!]), transport, { center: "", token: "" });
    expect(sent.filter((entry) => entry.sessionID === sessionIDs[1]).length).toBe(6);
    expect(sent.at(-1)?.text).toContain("@bob later");
    expect(sent.at(-1)?.delivery).toBe("steer");
    expect(backgrounded).toBe(2);
    expect((await store.loadRegistry())[roomIDs[1]!]![sessionIDs[1]!]!.lastQueuedTs).toBeGreaterThan(0);
  });

  test("serializes concurrent process registry updates without losing rows", async () => {
    const dir = await directory("multiprocess");
    process.env.CHAT_ROOM_STATE_DIR = dir;
    const roomID = "shared";
    const original = JSON.stringify([{ id: roomID, name: "shared", ownerId: "alice", createdAt: 1,
      participants: [{ id: "alice", name: "alice", joinedAt: 1 }], messages: [] }]);
    writeFileSync(path.join(dir, "rooms.json"), original);
    writeFileSync(path.join(dir, "registry.json"), JSON.stringify({ [roomID]: {
      legacy: { serverUrl: "", apiPrefix: "/api", name: "legacy", lastReadTs: 3, lastQueuedTs: 4 },
    } }));
    const storeURL = new URL("./store.ts", import.meta.url).href;
    const source = `import { writeState } from ${JSON.stringify(storeURL)}; const prefix=process.argv[1],room=process.argv[2]; for(let i=0;i<12;i++) await writeState((svc,reg)=>{svc.sendMessage(room,"alice",prefix+i,prefix);(reg[room][prefix]??={serverUrl:"",apiPrefix:"/api",name:prefix}).lastQueuedTs=i+1;});`;
    const env = { ...process.env, CHAT_ROOM_STATE_DIR: dir };
    const children = ["one", "two"].map((prefix) => Bun.spawn([process.execPath, "-e", source, prefix, roomID], { env, stdout: "ignore", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
    const history = await store.readHistory(roomID, undefined, 30);
    expect(history.messages).toHaveLength(24);
    expect((await store.loadRegistry())[roomID]).toMatchObject({ legacy: { lastReadTs: 3, lastQueuedTs: 4 }, one: { lastQueuedTs: 12 }, two: { lastQueuedTs: 12 } });
    expect(readFileSync(path.join(dir, "rooms.json"), "utf8")).toBe(original);
  });
});

afterAll(async () => {
  closeReceiverState();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});
