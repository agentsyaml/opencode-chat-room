import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const envKeys = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "CHAT_ROOM_STATE_DIR", "XDG_STATE_HOME"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
process.env.CHAT_ROOM_SERVER_TOKEN = "receiver-test-token";
const stateDir = mkdtempSync(path.join(tmpdir(), "chat-room-center-owner-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
process.env.XDG_STATE_HOME = path.join(stateDir, "xdg-state");
const { default: server } = await import("../server/chat-server");
const store = await import("./store");
const { centerAction } = await import("./center-client");
const { closeReceiverState } = await import("./receiver-state");
const { checkCenterInbox } = await import("./center-inbox");
const ownerID = "123e4567-e89b-42d3-a456-426614174000";

async function call(pathname: string, method = "GET", body?: unknown) {
  return server.fetch(new Request(`http://localhost${pathname}`, {
    method, headers: { Authorization: "Bearer receiver-test-token", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

describe("central receiver membership scope", () => {
  test("returns only V2 sessions owned by the authenticated host ID", async () => {
    const created = await call("/rooms", "POST", { name: "receiver", ownerId: "alice", sessionID: "owned", protocol: "v2", receiverOwnerID: ownerID });
    expect(created.status).toBe(201);
    const room = await created.json() as { id: string };
    expect(await (await call(`/rooms/${room.id}/registry`)).json()).toMatchObject({
      owned: { protocol: "v2", receiverOwnerID: ownerID },
    });
    await call("/rooms", "POST", { name: "legacy", ownerId: "bob", sessionID: "legacy" });
    const members = await call(`/receiver/memberships?ownerID=${ownerID}`);
    expect(await members.json()).toEqual({ sessionIDs: ["owned"] });
    expect((await call("/receiver/memberships?ownerID=no")).status).toBe(400);
    const nextOwner = "123e4567-e89b-42d3-a456-426614174001";
    await call(`/rooms/${room.id}/join`, "POST", { sessionID: "owned", participantId: "alice", participantName: "alice", protocol: "v2", receiverOwnerID: nextOwner });
    expect(await (await call(`/receiver/memberships?ownerID=${ownerID}`)).json()).toEqual({ sessionIDs: [] });
    expect(await (await call(`/receiver/memberships?ownerID=${nextOwner}`)).json()).toEqual({ sessionIDs: ["owned"] });
  });

  test("rejects malformed owner IDs before mutating create or join", async () => {
    const created = await call("/rooms", "POST", { name: "bad", ownerId: "alice", sessionID: "bad", protocol: "v2", receiverOwnerID: "../path" });
    expect(created.status).toBe(400);
    const joined = await call("/rooms/not-real/join", "POST", { sessionID: "bad", participantId: "bob", participantName: "bob", protocol: "v2", receiverOwnerID: "not-a-uuid" });
    expect(joined.status).toBe(400);
  });

  test("serves authenticated keyset history pages without session metadata", async () => {
    let roomID = "";
    await store.writeState((service) => {
      const room = service.createRoom("history", "alice");
      roomID = room.id;
      for (let i = 0; i < 5; i++) service.sendMessage(room.id, "alice", `m${i}`, "private-session");
    });
    const first = await call(`/rooms/${roomID}/history?limit=2`);
    const page1 = await first.json() as { messages: Array<{ seq: number; text: string; senderSessionID?: string }>; nextBeforeSeq: number; hasMore: boolean };
    expect(page1.messages.map((message) => message.text)).toEqual(["m3", "m4"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages[0]?.senderSessionID).toBeUndefined();
    const page2 = await call(`/rooms/${roomID}/history?beforeSeq=${page1.nextBeforeSeq}&limit=2`);
    expect((await page2.json() as typeof page1).messages.map((message) => message.text)).toEqual(["m1", "m2"]);
    expect((await call(`/rooms/${roomID}/history?limit=201`)).status).toBe(400);
    const unauthorized = await server.fetch(new Request(`http://localhost/rooms/${roomID}/history`));
    expect(unauthorized.status).toBe(401);
  });

  test("bounds inbox message pages and resumes after the acknowledged timestamp", async () => {
    const created = await call("/rooms", "POST", { name: "burst", ownerId: "alice", sessionID: "target" });
    const roomID = (await created.json() as { id: string }).id;
    await store.writeState((service, registry) => {
      registry[roomID]!.target!.lastReadTs = 0;
      for (let i = 0; i < 55; i++) service.sendMessage(roomID, "alice", `burst-${i}`, "sender");
    });
    const first = await call("/inbox?sessionID=target&excludeSelf=1");
    const page1 = await first.json() as { items: Array<{ createdAt: number }>; hasMore: boolean };
    expect(page1.items).toHaveLength(20);
    expect(page1.hasMore).toBe(true);
    const ts = page1.items.at(-1)!.createdAt;
    await call("/queued", "POST", { roomId: roomID, sessionID: "target", ts });
    const second = await call("/inbox?sessionID=target&excludeSelf=1");
    const page2 = await second.json() as { items: Array<{ createdAt: number }>; hasMore: boolean };
    expect(page2.items).toHaveLength(20);
    expect(page2.items[0]!.createdAt).toBeGreaterThan(ts);
    expect(page2.hasMore).toBe(true);
  });

  test("room-filtered inbox reports only memberships in that room", async () => {
    const memberRoom = await call("/rooms", "POST", { name: "member", ownerId: "alice", sessionID: "room-filter-session" });
    const memberID = (await memberRoom.json() as { id: string }).id;
    const otherRoom = await call("/rooms", "POST", { name: "other", ownerId: "bob" });
    const otherID = (await otherRoom.json() as { id: string }).id;
    const all = await call("/inbox?sessionID=room-filter-session&excludeSelf=0");
    expect(await all.json()).toMatchObject({ member: true, queuedTs: { [memberID]: 0 } });
    const filtered = await call(`/inbox?sessionID=room-filter-session&roomId=${otherID}&excludeSelf=0`);
    expect(await filtered.json()).toEqual({ member: false, items: [], queuedTs: {}, hasMore: false });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      server.fetch(new Request(String(input), init))) as unknown as typeof fetch;
    try {
      expect(await centerAction({ center: "http://center.invalid", token: "receiver-test-token" },
        { action: "poll", roomId: otherID }, "room-filter-session")).toBe("error: not joined");
    } finally { globalThis.fetch = previousFetch; }
  });

  test("scans a bounded central backlog and drains through a later mention", async () => {
    const created = await call("/rooms", "POST", { name: "restored-burst", ownerId: "bob", sessionID: "restored", protocol: "v2", receiverOwnerID: ownerID });
    const roomID = (await created.json() as { id: string }).id;
    await store.writeState((service, registry) => {
      registry[roomID]!.restored!.lastReadTs = 0;
      service.joinRoom(roomID, { id: "alice", name: "alice" });
      for (let i = 0; i < 100; i++) service.sendMessage(roomID, "alice", `ordinary-${i}`, "sender");
      service.sendMessage(roomID, "bob", "@bob peer session", "different-session");
      service.sendMessage(roomID, "bob", "@bob own session", "restored");
    });
    const filteredHistory = await call(`/rooms/${roomID}/history?limit=200&excludeSessionID=restored`);
    const filteredMessages = (await filteredHistory.json() as { messages: Array<{ text: string }> }).messages;
    expect(filteredMessages.some((message) => message.text === "@bob peer session")).toBe(true);
    expect(filteredMessages.some((message) => message.text === "@bob own session")).toBe(false);
    const oldFetch = globalThis.fetch;
    const traced: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await server.fetch(new Request(String(input), init));
      const url = new URL(String(input));
      traced.push(`${url.pathname}${url.search} ${response.status}`);
      return response;
    }) as unknown as typeof fetch;
    const sent: Array<{ text: string; delivery: string }> = [];
    let backgrounds = 0;
    try {
      const transport = {
        protocol: "v2" as const, receiverOwnerID: ownerID, mentionOnlySessions: new Set(["restored"]),
        backgroundSession: async () => { backgrounds++; return true; },
        promptQueue: async (sessionID: string, id: string, text: string, delivery: "queue" | "steer") => {
          sent.push({ text, delivery });
          return { id, sessionID, delivery };
        },
      };
      for (let page = 0; page < 6; page++) {
        await checkCenterInbox({ center: "http://center.invalid", token: "receiver-test-token" }, "restored", transport);
      }
    } finally { globalThis.fetch = oldFetch; }
    expect(sent).toHaveLength(6);
    expect(sent[0]!.text).toContain("ordinary-0");
    expect(sent[4]!.text).toContain("ordinary-99");
    expect(sent[5]!.text).toContain("@bob peer session");
    expect(sent[5]!.text).not.toContain("@bob own session");
    expect(sent[0]!.delivery).toBe("queue");
    expect(sent[5]!.delivery).toBe("steer");
    expect(backgrounds).toBe(1);
    expect(traced.some((route) => route.includes(`/history?limit=20&excludeSessionID=restored 200`))).toBe(true);
  });
});

afterAll(async () => {
  closeReceiverState();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});
