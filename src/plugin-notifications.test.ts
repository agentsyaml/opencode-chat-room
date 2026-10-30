import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { QueueTransport } from "./queue-transport";

const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(4)) delete process.env[key];
const sandbox = mkdtempSync(path.join(tmpdir(), "chat-room-notifier-"));
process.env.HOME = `${sandbox}/home`;
process.env.XDG_CONFIG_HOME = `${sandbox}/config`;
process.env.XDG_STATE_HOME = `${sandbox}/state`;
process.env.CHAT_ROOM_STATE_DIR = `${sandbox}/chat-room`;

const [{ createNotifier }, store, queue, inbox] = await Promise.all([
  import("./plugin-notifications"), import("./store"), import("./queue"), import("./center-inbox"),
]);
const { claimBackgroundAttempt, closeReceiverState } = await import("./receiver-state");

const sessionID = "notifier-session";
const roomID = `room-${crypto.randomUUID()}`;
const msg = { id: "message-1", roomId: roomID, senderId: "alice", senderSessionID: "other", text: "@bob please look", createdAt: 100 };

async function setRegistry(snapshot: import("./store").Registry) {
  await store.writeState((service, registry) => {
    for (const roomId of Object.keys(snapshot)) {
      try { service.getRoom(roomId); }
      catch { service.hydrate([{ id: roomId, name: roomId, ownerId: "test", createdAt: 0, participants: new Map(), messages: [] }]); }
    }
    for (const room of Object.keys(registry)) delete registry[room];
    Object.assign(registry, structuredClone(snapshot));
  });
}

async function registry(lastQueuedTs?: number) {
  await setRegistry({ [roomID]: { [sessionID]: {
    serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0, lastQueuedTs,
  } } });
}

function notifier(transport: QueueTransport, bumpQueued: (ts: number) => Promise<boolean>) {
  return createNotifier({ transport: () => transport, bumpQueued: (_room, _session, ts) => bumpQueued(ts) });
}

describe.serial("local V2 notification admission", () => {
  test("claims one attempt through a message watermark and permits a newer trigger", () => {
    const room = `room-${crypto.randomUUID()}`;
    expect(claimBackgroundAttempt(sessionID, room, "service", 100)).toBe(true);
    expect(claimBackgroundAttempt(sessionID, room, "service", 100)).toBe(false);
    expect(claimBackgroundAttempt(sessionID, room, "service", 99)).toBe(false);
    expect(claimBackgroundAttempt(sessionID, room, "service", 101)).toBe(true);
  });

  test("does not re-background a retried pending notification and retains its ID", async () => {
    await registry();
    let backgrounds = 0;
    let bumps = 0;
    const ids: string[] = [];
    const deliveries: string[] = [];
    let send = 0;
    const transport = {
      protocol: "v2" as const,
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async (_sid: string, id: string, _text: string, delivery: "queue" | "steer") => {
        ids.push(id);
        deliveries.push(delivery);
        if (send++ === 0) throw Error("temporary refusal");
        return { id, sessionID, delivery };
      },
    };
    const target = notifier(transport, async (ts) => {
      bumps++;
      await store.writeState((_svc, registry) => { registry[roomID]![sessionID]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(sessionID, roomID, ts);
      return true;
    });
    expect((await target.notifyTarget(sessionID, { roomId: roomID, roomName: "dev", messages: [msg] }))?.status).toBe(0);
    expect((await store.loadRegistry())[roomID]![sessionID]!.lastQueuedTs).toBeUndefined();
    expect((await target.notifyTarget(sessionID, { roomId: roomID, roomName: "dev", messages: [msg] }))?.status).toBe(200);
    expect(backgrounds).toBe(1);
    expect(ids[0]).toBe(ids[1]);
    expect(deliveries).toEqual(["steer", "steer"]);
    expect(bumps).toBe(1);
  });

  test("steers ordinary notifications and identifies the originating room", async () => {
    const room = `room-${crypto.randomUUID()}`;
    await setRegistry({ [room]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0,
    } } });
    let text = "";
    let delivery = "";
    const target = notifier({ protocol: "v2", backgroundSession: async () => false,
      promptQueue: async (sid, id, prompt, mode) => {
        text = prompt; delivery = mode;
        return { id, sessionID: sid, delivery: mode };
      },
    }, async () => true);
    await target.notifyTarget(sessionID, { roomId: room, roomName: "dev", messages: [
      { ...msg, roomId: room, text: "routine update", createdAt: 101 },
    ] });
    expect(delivery).toBe("steer");
    expect(text).toContain(`room dev (${room})`);
    expect(text).toContain("acknowledge it once per distinct request");
    expect(text).toContain("before doing the work");
    expect(text).toContain("same room");
  });

  test("steers a direct mention even when backgrounding throws", async () => {
    const room = `room-${crypto.randomUUID()}`;
    await setRegistry({ [room]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0,
    } } });
    let delivery = "";
    const target = notifier({ protocol: "v2", backgroundSession: async () => { throw Error("unavailable"); },
      promptQueue: async (sid, id, _prompt, mode) => {
        delivery = mode;
        return { id, sessionID: sid, delivery: mode };
      },
    }, async () => true);
    await target.notifyTarget(sessionID, { roomId: room, roomName: "dev", messages: [
      { ...msg, roomId: room, createdAt: 102 },
    ] });
    expect(delivery).toBe("steer");
  });

  test("accepted steer is not re-backgrounded by empty sweeps; a new admission gets one attempt", async () => {
    const room = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174099";
    await setRegistry({ [room]: { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "bob", lastReadTs: 0 } } });
    let backgrounds = 0;
    const prompts: string[] = [];
    const transport: QueueTransport = {
      protocol: "v2", receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return false; },
      promptQueue: async (sid, id, text, delivery) => { prompts.push(text); return { id, sessionID: sid, delivery }; },
    };
    const target = notifier(transport, async (ts) => {
      await store.writeState((_svc, registry) => { registry[room]![sessionID]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(sessionID, room, ts);
      return true;
    });
    const first = { ...msg, roomId: room, createdAt: 101 };
    const batch = { roomId: room, roomName: "dev", messages: [first] };
    await target.notifyTarget(sessionID, batch);
    await target.notifyTarget(sessionID, batch);
    expect(backgrounds).toBe(1);
    expect(prompts).toHaveLength(1);
    const second = { ...msg, id: "message-2", roomId: room, createdAt: 102, text: "@bob new task" };
    await target.notifyTarget(sessionID, { ...batch, messages: [first, second] });
    expect(backgrounds).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("@bob new task");
    expect(prompts[1]).not.toContain("@bob please look");
    expect((await store.loadRegistry())[room]![sessionID]!.lastQueuedTs).toBe(second.createdAt);
  });

  test("does not retry a background obligation through another receiver", async () => {
    const room = `room-${crypto.randomUUID()}`;
    await setRegistry({ [room]: { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: "owner-a", name: "bob", lastReadTs: 0 } } });
    let backgrounds = 0;
    let prompts = 0;
    const base: QueueTransport = { protocol: "v2", receiverOwnerID: "owner-a",
      backgroundSession: async () => { backgrounds++; return false; },
      promptQueue: async (sid, id, _text, delivery) => { prompts++; return { id, sessionID: sid, delivery }; },
    };
    const target = notifier(base, async () => true);
    const batch = { roomId: room, roomName: "dev", messages: [{ ...msg, roomId: room }] };
    await target.notifyTarget(sessionID, batch);
    await target.notifyTarget(sessionID, batch, { ...base, receiverOwnerID: "owner-b" });
    expect(backgrounds).toBe(1);
    expect(prompts).toBe(1);
  });

  test("broadcast aliases fan out to two peers but not the sender", async () => {
    const room = `room-${crypto.randomUUID()}`;
    await setRegistry({ [room]: {
      sender: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "alice", lastReadTs: 0 },
      peer1: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0 },
      peer2: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "carol", lastReadTs: 0 },
    } });
    const delivered: string[] = [];
    const transport: QueueTransport = { protocol: "v2", promptQueue: async (sid, id, text, delivery) => {
      delivered.push(`${sid}:${text}`); return { id, sessionID: sid, delivery };
    } };
    const target = notifier(transport, async () => true);
    const batch = { roomId: room, roomName: "dev", messages: [
      { ...msg, senderId: "sender", senderSessionID: "sender", text: "@all hello", createdAt: 201 },
      { ...msg, id: "broadcast-2", senderId: "sender", senderSessionID: "sender", text: "<at>@所有人</at> please", createdAt: 202 },
    ] };
    for (const sid of ["sender", "peer1", "peer2"]) await target.notifyTarget(sid, batch);
    expect(delivered).toHaveLength(2);
    expect(delivered.every((value) => value.includes("@all hello") && value.includes("@所有人"))).toBe(true);
    expect(delivered.some((value) => value.startsWith("sender:"))).toBe(false);
  });

  test("delivers an unmentioned direct message to the other session", async () => {
    const room = `direct-${crypto.randomUUID()}`;
    await store.writeState((service) => service.hydrate([{ id: room, name: "private", ownerId: "test", createdAt: 0, kind: "direct", participants: new Map(), messages: [] }]));
    await setRegistry({ [room]: { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0 } } });
    let prompt = "";
    const target = notifier({ protocol: "v2", promptQueue: async (sid, id, text, delivery) => {
      prompt = text; return { id, sessionID: sid, delivery };
    } }, async () => true);
    await target.notifyTarget(sessionID, { roomId: room, roomName: "private", messages: [
      { ...msg, senderId: "peer-session", senderSessionID: "peer-session", text: "can you review this?", createdAt: 203 },
    ] });
    expect(prompt).toContain("Direct conversation with bob");
    expect(prompt).toContain("can you review this?");
  });

  test("serializes local delivery across notifier instances and commits only once", async () => {
    const concurrentRoom = `room-${crypto.randomUUID()}`;
    const concurrentSession = `session-${crypto.randomUUID()}`;
    await setRegistry({ [concurrentRoom]: { [concurrentSession]: {
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
      await store.writeState((_svc, registry) => { registry[concurrentRoom]![concurrentSession]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(concurrentSession, concurrentRoom, ts);
      return true;
    };
    const batch = { roomId: concurrentRoom, roomName: "dev", messages: [{ ...msg, roomId: concurrentRoom }] };
    await Promise.all([
      notifier(transport, bump).notifyTarget(concurrentSession, batch),
      notifier(transport, bump).notifyTarget(concurrentSession, batch),
    ]);
    expect(backgrounds).toBe(1);
    expect(sends).toBe(1);
    expect(bumps).toBe(1);
  });

  test("does not background for a newer mention absent from the pending prompt", async () => {
    const pendingRoom = `room-${crypto.randomUUID()}`;
    await setRegistry({ [pendingRoom]: { [sessionID]: {
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

  test("does not commit a cursor when a host response lacks the real admission", async () => {
    const responseRoom = `room-${crypto.randomUUID()}`;
    await setRegistry({ [responseRoom]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0,
    } } });
    let bumps = 0;
    const target = notifier({ protocol: "v2", promptQueue: async () => ({ id: "wrong" }) }, async () => { bumps++; return true; });
    expect((await target.notifyTarget(sessionID, { roomId: responseRoom, roomName: "dev", messages: [{ ...msg, roomId: responseRoom }] }))?.status).toBe(400);
    expect(bumps).toBe(0);
  });

  test("keeps an owned session from receiving rooms bound to another owner", async () => {
    const otherRoom = `room-${crypto.randomUUID()}`;
    const ownerA = "123e4567-e89b-42d3-a456-426614174000";
    const ownerB = "123e4567-e89b-42d3-a456-426614174001";
    await setRegistry({ [otherRoom]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerB, name: "bob", lastReadTs: 0,
    } } });
    let sends = 0;
    let backgrounds = 0;
    const transport: QueueTransport = {
      protocol: "v2", receiverOwnerID: ownerA, mentionOnlySessions: new Set([sessionID]),
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async () => { sends++; return {}; },
    };
    const local = notifier(transport, async () => true);
    expect(await local.notifyTarget(sessionID, { roomId: otherRoom, roomName: "dev", messages: [{ ...msg, roomId: otherRoom }] })).toBeUndefined();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ [sessionID]: { protocol: "v2", receiverOwnerID: ownerB, name: "bob" } })) as unknown as typeof fetch;
    try {
      await inbox.pushItemsToSession({ center: "http://center.invalid", token: "test" }, sessionID,
        [{ ...msg, roomId: otherRoom, roomName: "dev" }], transport);
    } finally { globalThis.fetch = originalFetch; }
    expect(backgrounds).toBe(0);
    expect(sends).toBe(0);
  });

  test("a restored local mention delivers and acknowledges the complete unread batch", async () => {
    const restoreRoom = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174000";
    await setRegistry({ [restoreRoom]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "bob", lastReadTs: 0,
    } } });
    let notification = "";
    let acknowledged = 0;
    const target = notifier({ protocol: "v2", receiverOwnerID: ownerID, mentionOnlySessions: new Set([sessionID]),
      promptQueue: async (sid, id, text, delivery) => { notification = text; return { id, sessionID: sid, delivery }; },
    }, async (ts) => { acknowledged = ts; return true; });
    await target.notifyTarget(sessionID, { roomId: restoreRoom, roomName: "dev", messages: [
      { ...msg, roomId: restoreRoom, text: "ordinary note", createdAt: 10 },
      { ...msg, id: "mention", roomId: restoreRoom, text: "@bob please", createdAt: 20 },
    ] });
    expect(notification).toContain("ordinary note");
    expect(notification).toContain("@bob please");
    expect(acknowledged).toBe(20);
  });

  test("a new mention retries the original pending admission before steering its own message", async () => {
    const room = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174000";
    await setRegistry({ [room]: { [sessionID]: {
      serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "bob", lastReadTs: 0,
    } } });
    const ordinary = { ...msg, roomId: room, text: "ordinary note", createdAt: 10 };
    const mention = { ...msg, id: "new-mention", roomId: room, text: "@bob please", createdAt: 20 };
    const ids: string[] = [];
    const texts: string[] = [];
    const deliveries: string[] = [];
    let sends = 0;
    let backgrounds = 0;
    const transport: QueueTransport = { protocol: "v2", receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async (sid, id, text, delivery) => {
        ids.push(id); texts.push(text); deliveries.push(delivery);
        if (sends++ === 0) throw Error("offline");
        return { id, sessionID: sid, delivery };
      },
    };
    const target = notifier(transport, async (ts) => {
      await store.writeState((_svc, registry) => { registry[room]![sessionID]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(sessionID, room, ts);
      return true;
    });
    await target.notifyTarget(sessionID, { roomId: room, roomName: "dev", messages: [ordinary] }, transport);
    const restored = { ...transport, mentionOnlySessions: new Set([sessionID]) };
    await target.notifyTarget(sessionID, { roomId: room, roomName: "dev", messages: [ordinary, mention] }, restored);
    expect(ids[0]).toBe(ids[1]);
    expect(texts[1]).not.toContain("@bob please");
    expect(deliveries[1]).toBe("steer");
    expect(backgrounds).toBe(0);
    await target.notifyTarget(sessionID, { roomId: room, roomName: "dev", messages: [ordinary, mention] }, restored);
    expect(ids[2]).not.toBe(ids[1]);
    expect(deliveries[2]).toBe("steer");
    expect(texts[2]).toContain(`room dev (${room})`);
    expect(backgrounds).toBe(1);
  });

  test("a restored-session mention sends the whole unread room batch and acknowledges its max timestamp", async () => {
    const restoredRoom = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174000";
    const postBodies: Array<Record<string, unknown>> = [];
    let notification = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") postBodies.push(JSON.parse(String(init.body)));
      return Response.json({ [sessionID]: { protocol: "v2", receiverOwnerID: ownerID, name: "bob" } });
    }) as unknown as typeof fetch;
    try {
      await inbox.pushItemsToSession({ center: "http://center.invalid", token: "test" }, sessionID, [
        { ...msg, roomId: restoredRoom, roomName: "dev", text: "ordinary note", createdAt: 10 },
        { ...msg, id: "mention", roomId: restoredRoom, roomName: "dev", text: "@bob please", createdAt: 20 },
      ], {
        protocol: "v2", receiverOwnerID: ownerID, mentionOnlySessions: new Set([sessionID]),
        backgroundSession: async () => true,
        promptQueue: async (sid, id, text, delivery) => { notification = text; return { id, sessionID: sid, delivery }; },
      });
    } finally { globalThis.fetch = originalFetch; }
    expect(notification).toContain("ordinary note");
    expect(notification).toContain("@bob please");
    expect(postBodies.find((body) => body.sessionID === sessionID && body.ts === 20)).toBeDefined();
  });

  test("central empty-inbox sweeps do not repeat a failed background attempt", async () => {
    const room = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174099";
    const opts = { center: "http://center.invalid/api", token: "test" };
    let backgrounds = 0;
    let prompts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/registry")) return Response.json({ [sessionID]: { name: "bob", protocol: "v2", receiverOwnerID: ownerID, roomKind: "group" } });
      if (String(input).includes("/inbox")) return Response.json({ items: [], queuedTs: {}, hasMore: false });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const transport: QueueTransport = { protocol: "v2", receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return false; },
      promptQueue: async (sid, id, _text, delivery) => { prompts++; return { id, sessionID: sid, delivery }; },
    };
    try {
      expect(await inbox.pushItemsToSession(opts, sessionID, [
        { ...msg, roomId: room, roomName: "dev", text: "@bob help", createdAt: 204 },
      ], transport)).toBe("delivered");
      await inbox.checkCenterInbox(opts, sessionID, transport);
    } finally { globalThis.fetch = originalFetch; }
    expect(backgrounds).toBe(1);
    expect(prompts).toBe(1);
  });

  test("central direct inbox messages need no @ mention and keep the peer context", async () => {
    const room = `direct-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174099";
    let prompt = "";
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("/registry")
      ? Response.json({ [sessionID]: { name: "bob", protocol: "v2", receiverOwnerID: ownerID, roomKind: "direct" } })
      : Response.json({ ok: true })) as unknown as typeof fetch;
    try {
      await inbox.pushItemsToSession({ center: "http://center.invalid", token: "test" }, sessionID, [
        { ...msg, roomId: room, roomName: "private", roomKind: "direct", senderId: "peer-session", text: "please review", createdAt: 205 },
      ], { protocol: "v2", receiverOwnerID: ownerID, backgroundSession: async () => true,
        promptQueue: async (sid, id, text, delivery) => { prompt = text; return { id, sessionID: sid, delivery }; },
      });
    } finally { globalThis.fetch = oldFetch; }
    expect(prompt).toContain("Direct conversation with bob");
    expect(prompt).toContain("please review");
  });

  test("a later mention retries the original central admission before a fresh steer", async () => {
    const room = `room-${crypto.randomUUID()}`;
    const ownerID = "123e4567-e89b-42d3-a456-426614174000";
    const postBodies: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    const deliveries: string[] = [];
    let backgrounds = 0;
    let sends = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") postBodies.push(JSON.parse(String(init.body)));
      return Response.json({ [sessionID]: { protocol: "v2", receiverOwnerID: ownerID, name: "bob" } });
    }) as unknown as typeof fetch;
    const base = { protocol: "v2" as const, receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return true; },
      promptQueue: async (sid: string, id: string, text: string, delivery: "queue" | "steer") => {
        prompts.push(text); deliveries.push(delivery);
        if (sends++ === 0) throw Error("offline");
        return { id, sessionID: sid, delivery };
      },
    };
    const opts = { center: "http://center.invalid", token: "test" };
    const ordinary = { ...msg, roomId: room, roomName: "dev", text: "ordinary note", createdAt: 10 };
    const mention = { ...msg, id: "central-mention", roomId: room, roomName: "dev", text: "@bob please", createdAt: 20 };
    try {
      expect(await inbox.pushItemsToSession(opts, sessionID, [ordinary], base)).toBe("unreachable");
      expect(postBodies.some((body) => body.ts)).toBe(false);
      const restored = { ...base, mentionOnlySessions: new Set([sessionID]) };
      expect(await inbox.pushItemsToSession(opts, sessionID, [ordinary, mention], restored)).toBe("delivered");
      expect(prompts[0]).toBe(prompts[1]);
      expect(prompts[1]).not.toContain("@bob please");
      expect(deliveries[1]).toBe("steer");
      expect(postBodies.some((body) => body.ts === 10)).toBe(true);
      await inbox.pushItemsToSession(opts, sessionID, [ordinary, mention], restored, { [room]: 10 });
      expect(prompts[2]).toContain("@bob please");
      expect(deliveries[2]).toBe("steer");
      expect(prompts[2]).toContain(`room dev (${room})`);
      expect(backgrounds).toBe(1);
      expect(postBodies.some((body) => body.ts === 20)).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

afterAll(() => {
  closeReceiverState();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});
