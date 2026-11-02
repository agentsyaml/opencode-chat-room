import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const env = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"] as const;
const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
const root = mkdtempSync(path.join(os.tmpdir(), "browser-cursor-"));
for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete process.env[key];
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "rooms");
const server = (await import("../server/chat-server")).default;
const store = await import("./store");

afterAll(() => {
  for (const key of env) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  rmSync(root, { recursive: true, force: true });
});

function call(route: string, method = "GET", body?: unknown) {
  return server.fetch(new Request(`http://local${route}`, { method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }));
}

test("room listing adds authoritative joined state without changing visibility", async () => {
  const ids = await store.writeState((service, registry) => {
    const group = service.createRoom("group", "Same");
    const direct = service.createDirectRoom("direct", "Same", ["same-a", "same-b"]);
    const entry = { serverUrl: "", apiPrefix: "/api", name: "Same" };
    registry[group.id] = { "same-a": { ...entry }, "same-b": { ...entry } };
    registry[direct.id] = { "same-a": { ...entry } };
    return { groupID: group.id, directID: direct.id };
  });
  const list = async (session?: string) => await (await call(`/rooms${session ? `?sessionID=${session}` : ""}`)).json() as Array<{ id: string; joined: boolean }>;
  const sameA = await list("same-a"), sameB = await list("same-b");
  expect(sameA).toHaveLength(2);
  expect(sameA.find((room) => room.id === ids.groupID)?.joined).toBe(true);
  expect(sameA.find((room) => room.id === ids.directID)?.joined).toBe(true);
  expect(sameB).toHaveLength(2);
  expect(sameB.find((room) => room.id === ids.groupID)?.joined).toBe(true);
  expect(sameB.find((room) => room.id === ids.directID)?.joined).toBe(false);
  const outsider = await list("outsider");
  expect(outsider).toHaveLength(1);
  expect(outsider[0]).toMatchObject({ id: ids.groupID, joined: false });
  expect((await list()).every((room) => !room.joined)).toBe(true);
});

async function seedInbox() {
  return store.writeState((service, registry) => {
    const room = service.createRoom("cursor", "Other");
    service.joinRoom(room.id, { id: "Reader", name: "Reader" });
    const messages = Array.from({ length: 205 }, (_, i) => {
      const own = i % 10 === 0;
      return service.sendMessage(room.id, own ? "Reader" : "Other", `message-${i}`, own ? "reader-session" : "other-session");
    });
    registry[room.id] = { "reader-session": { serverUrl: "", apiPrefix: "/api", name: "Reader", protocol: "v2", membershipID: "cursor-generation",
      lastReadTs: messages[5]!.createdAt, lastQueuedTs: messages[7]!.createdAt } };
    return { roomID: room.id, messages, membershipID: "cursor-generation" };
  });
}

const inbox = (session: string, room: string, extra = "") => call(`/inbox?sessionID=${session}&roomId=${room}${extra}`);

test("afterTs replays and paginates a member room without mutating cursors", async () => {
  const fixture = await seedInbox();
  const initial = (await store.loadRegistry())[fixture.roomID]!["reader-session"]!;
  const ids: string[] = [], sizes: number[] = [];
  let afterTs = 0;
  while (true) {
    const response = await inbox("reader-session", fixture.roomID, `&excludeSelf=0&afterTs=${afterTs}`);
    expect(response.status).toBe(200);
    const page = await response.json() as { member: boolean; items: Array<{ id: string; createdAt: number; senderSessionID?: string }>; hasMore: boolean };
    expect(page.member).toBe(true);
    if (!page.items.length) break;
    sizes.push(page.items.length); ids.push(...page.items.map((item) => item.id));
    if (sizes.length === 1) expect(page.items.some((item) => item.senderSessionID === "reader-session")).toBe(true);
    afterTs = page.items.at(-1)!.createdAt;
    if (!page.hasMore) break;
  }
  expect(sizes).toEqual([100, 100, 5]);
  expect(ids).toEqual(fixture.messages.map((message) => message.id));
  expect(new Set(ids).size).toBe(205);
  expect(await store.loadRegistry()).toMatchObject({ [fixture.roomID]: { "reader-session": { lastReadTs: initial.lastReadTs, lastQueuedTs: initial.lastQueuedTs } } });
  const legacy = await (await inbox("reader-session", fixture.roomID, "&excludeSelf=1")).json() as { items: Array<{ senderSessionID?: string }> };
  expect(legacy.items).toHaveLength(20);
  expect(legacy.items.some((item) => item.senderSessionID === "reader-session")).toBe(false);
  const afterLegacy = (await store.loadRegistry())[fixture.roomID]!["reader-session"]!;
  expect(afterLegacy.lastReadTs).toBe(initial.lastReadTs);
  expect(afterLegacy.lastQueuedTs).toBe(initial.lastQueuedTs);
  const firstID = fixture.messages[0]!.id;
  const emptyReceipt = await (await call(`/rooms/${fixture.roomID}/receipts?messageIDs=${firstID}`)).json() as { receipts: Array<{ readers: unknown[] }> };
  expect(emptyReceipt.receipts[0]!.readers).toEqual([]);
  expect((await call("/read", "POST", { roomId: fixture.roomID, sessionID: "reader-session", ts: fixture.messages.at(-1)!.createdAt,
    messageIDs: [firstID], membershipID: fixture.membershipID, evidence: "tool" })).status).toBe(200);
  expect((await store.loadRegistry())[fixture.roomID]!["reader-session"]!.lastReadTs).toBe(fixture.messages.at(-1)!.createdAt);
  const receipt = await (await call(`/rooms/${fixture.roomID}/receipts?messageIDs=${firstID}`)).json() as { receipts: Array<{ readers: Array<{ evidence: string }> }> };
  expect(receipt.receipts[0]!.readers).toMatchObject([{ evidence: "tool" }]);
  const replay = await (await inbox("reader-session", fixture.roomID, "&excludeSelf=0&afterTs=0")).json() as { items: Array<{ id: string }> };
  expect(replay.items.map((item) => item.id)).toEqual(fixture.messages.slice(0, 100).map((message) => message.id));
  expect((await store.loadRegistry())[fixture.roomID]!["reader-session"]!.lastReadTs).toBe(fixture.messages.at(-1)!.createdAt);
  const outsider = await (await inbox("outsider", fixture.roomID, "&excludeSelf=0&afterTs=0")).json() as { member: boolean; items: unknown[]; queuedTs: Record<string, number>; hasMore: boolean };
  expect(outsider).toEqual({ member: false, items: [], queuedTs: {}, hasMore: false });
});

test("afterTs validation requires an explicit member-room echo request", async () => {
  const fixture = await seedInbox();
  const base = `/inbox?sessionID=reader-session&roomId=${fixture.roomID}&excludeSelf=0&afterTs=`;
  for (const value of ["", "NaN", "1.5", "-1", "9007199254740992", "1e3"]) {
    expect((await call(`${base}${value}`)).status).toBe(400);
  }
  expect((await call(`/inbox?sessionID=reader-session&excludeSelf=0&afterTs=0`)).status).toBe(400);
  expect((await call(`/inbox?sessionID=reader-session&roomId=${fixture.roomID}&afterTs=0`)).status).toBe(400);
  expect((await call(`/inbox?sessionID=reader-session&roomId=${fixture.roomID}&excludeSelf=1&afterTs=0`)).status).toBe(400);
});
