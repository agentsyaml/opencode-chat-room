import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "room-list-"));
for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_WAKE_SERVE_URL", "CHAT_ROOM_DATABASE_URL"]) delete process.env[key];
process.env.HOME = path.join(dir, "home");
process.env.XDG_STATE_HOME = path.join(dir, "state");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.CHAT_ROOM_STATE_DIR = dir;
const { roomListRoutes } = await import("../../server/routes/rooms.ts");
const store = await import("../state/store.ts");
const { closeStateDatabases, openStateDatabase } = await import("../state/sqlite-state.ts");

afterAll(async () => {
  await closeStateDatabases();
  await fs.rm(dir, { recursive: true, force: true });
});

type Summary = { id: string; name: string; latestMsgTs: number };
type RoomRow = { id: string; joined?: boolean; lastReadTs?: number; messages: Array<{ text: string }> };
type Page = { rooms: RoomRow[]; hasMore: boolean; nextOffset: number | null };

async function get(route: string): Promise<Response> {
  const url = new URL(`http://local${route}`);
  const response = await roomListRoutes(new Request(url), url);
  if (!response) throw new Error(`room list route did not handle ${route}`);
  return response;
}

test("summary matches the pre-change latest timestamp beyond the hydrated window", async () => {
  const seeded = await store.writeState((svc, registry) => {
    const empty = svc.createRoom("summary empty", "alice");
    const active = svc.createRoom("summary active", "alice");
    const recalled = svc.createRoom("summary recalled", "alice");
    const first = svc.sendMessage(active.id, "alice", "one", "alice-session");
    const last = svc.sendMessage(active.id, "alice", "two", "alice-session");
    const recalledMessage = svc.sendMessage(recalled.id, "alice", "latest", "alice-session");
    registry[recalled.id] = { "alice-session": { serverUrl: "", apiPrefix: "/api", name: "alice" } };
    return { emptyID: empty.id, activeID: active.id, first: first.createdAt, last: last.createdAt,
      recalledID: recalled.id, recalledMessageID: recalledMessage.id, recalledAt: recalledMessage.createdAt };
  });
  expect(seeded.last).toBeGreaterThan(seeded.first);
  expect((await store.recallMessage(seeded.recalledID, seeded.recalledMessageID, "alice-session"))).toMatchObject({ status: "ok", alreadyRecalled: false });

  // Six batches keep the SQLite row count above the 500-message hydration window.
  const bulk = await store.writeState((svc) => svc.createRoom("summary bulk", "alice"));
  let tail: { id: string; createdAt: number } | undefined;
  for (let batch = 0; batch < 6; batch++) {
    tail = await store.writeState((svc, registry) => {
      let last: { id: string; createdAt: number } | undefined;
      for (let index = 0; index < 100; index++) {
        const message = svc.sendMessage(bulk.id, "alice", `bulk-${batch}-${index}`, "alice-session");
        last = { id: message.id, createdAt: message.createdAt };
      }
      registry[bulk.id] = { "alice-session": { serverUrl: "", apiPrefix: "/api", name: "alice" } };
      return last!;
    });
  }
  expect(tail).toBeDefined();
  // Recall must not zero created_at, so the recalled tail still defines the summary.
  expect((await store.recallMessage(bulk.id, tail!.id, "alice-session"))).toMatchObject({ status: "ok", alreadyRecalled: false });

  const db = await openStateDatabase(store.databasePath());
  const count = db.query("SELECT COUNT(*) AS count FROM messages WHERE room_id=?").get(bulk.id) as { count: number };
  expect(Number(count.count)).toBe(600);
  const roomCount = db.query("SELECT COUNT(*) AS count FROM rooms").get() as { count: number };
  const latestRow = db.query("SELECT id,created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(bulk.id) as { id: string; created_at: number };
  expect(latestRow.id).toBe(tail!.id);
  expect(Number(latestRow.created_at)).toBe(tail!.createdAt);

  const expected = await store.readState((svc) => svc.listRooms().map((room) => ({
    id: room.id, name: room.name, latestMsgTs: room.messages.at(-1)?.createdAt ?? 0,
  })));
  const response = await get("/rooms/summary");
  expect(response.status).toBe(200);
  const summary = await response.json() as Summary[];
  expect(summary).toEqual(expected);
  expect(summary).toHaveLength(expected.length);
  expect(summary).toHaveLength(Number(roomCount.count));
  expect(summary.find((room) => room.id === seeded.emptyID)).toEqual({ id: seeded.emptyID, name: "summary empty", latestMsgTs: 0 });
  expect(summary.find((room) => room.id === seeded.activeID)).toMatchObject({ latestMsgTs: seeded.last });
  expect(summary.find((room) => room.id === seeded.recalledID)).toMatchObject({ latestMsgTs: seeded.recalledAt });
  expect(summary.find((room) => room.id === bulk.id)?.latestMsgTs).toBe(Number(latestRow.created_at));
});

test("room listing pagination is opt-in, ordered and bounded", async () => {
  const created = await store.writeState((svc, registry) => {
    const ids = Array.from({ length: 5 }, (_, index) => svc.createRoom(`page ${index}`, "alice").id);
    const withMessages = ids[0]!;
    for (let index = 0; index < 3; index++) svc.sendMessage(withMessages, "alice", `hello-${index}`, "alice-session");
    registry[withMessages] = { "alice-session": { serverUrl: "", apiPrefix: "/api", name: "alice", lastReadTs: 123 } };
    const direct = svc.createDirectRoom("direct", "alice", ["alice-session", "bob-session"]);
    return { ids, withMessages, directID: direct.id };
  });

  // No parameters keeps the legacy bare array, room order and inline messages.
  const bare = await get("/rooms");
  expect(bare.status).toBe(200);
  const list = await bare.json() as RoomRow[];
  expect(Array.isArray(list)).toBe(true);
  expect(list.some((room) => room.id === created.directID)).toBe(false);
  expect(list.find((room) => room.id === created.withMessages)?.messages.map((message) => message.text)).toEqual(["hello-0", "hello-1", "hello-2"]);

  // A caller who belongs to the direct room sees it in the same bare shape,
  // with the existing joined/read-watermark fields unchanged.
  const withCaller = await (await get("/rooms?sessionID=alice-session")).json() as RoomRow[];
  expect(Array.isArray(withCaller)).toBe(true);
  expect(withCaller.some((room) => room.id === created.directID)).toBe(true);
  expect(withCaller.find((room) => room.id === created.withMessages)).toMatchObject({ joined: true, lastReadTs: 123 });
  expect(withCaller.find((room) => room.id === created.withMessages)?.messages.map((message) => message.text)).toEqual(["hello-0", "hello-1", "hello-2"]);

  // With limit the bare list becomes an envelope; walking pages reproduces the
  // exact order with no duplicates and no hidden-direct-room phantom page.
  const ids: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = await (await get(`/rooms?limit=2&offset=${offset}`)).json() as Page;
    expect(page.rooms.length).toBeGreaterThan(0);
    expect(page.rooms.length).toBeLessThanOrEqual(2);
    for (const room of page.rooms) {
      ids.push(room.id);
      expect(room).toEqual(list.find((item) => item.id === room.id)!);
    }
    if (!page.hasMore) {
      expect(page.nextOffset).toBeNull();
      break;
    }
    expect(page.nextOffset).toBe(offset + page.rooms.length);
    offset = page.nextOffset!;
    if (guard === 99) throw new Error("pagination did not terminate");
  }
  expect(ids).toEqual(list.map((room) => room.id));
  expect(new Set(ids).size).toBe(ids.length);

  const exact = await (await get(`/rooms?limit=${list.length}`)).json() as Page;
  expect(exact.rooms).toHaveLength(list.length);
  expect(exact.hasMore).toBe(false);
  expect(exact.nextOffset).toBeNull();

  const window = await (await get("/rooms?limit=1&offset=1")).json() as Page;
  expect(window.rooms.map((room) => room.id)).toEqual(list.slice(1, 2).map((room) => room.id));
  expect(window.hasMore).toBe(list.length > 2);
  expect(window.nextOffset).toBe(list.length > 2 ? 2 : null);

  for (const past of [list.length, list.length + 5]) {
    const response = await get(`/rooms?limit=2&offset=${past}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rooms: [], hasMore: false, nextOffset: null });
  }

  const max = await (await get("/rooms?limit=200")).json() as Page;
  expect(max.rooms).toHaveLength(list.length);
  expect(max.hasMore).toBe(false);
  expect(max.nextOffset).toBeNull();
});

test("invalid pagination parameters are rejected before reading state", async () => {
  for (const query of ["limit=0", "limit=201", "limit=-1", "limit=1.5", "limit=abc", "limit=", "offset=-1", "offset=1.5", "offset=abc", "offset=1"]) {
    const response = await get(`/rooms?${query}`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  }
});