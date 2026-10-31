import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";

const childMode = process.env.CHAT_ROOM_MANAGEMENT_CHILD === "1";
if (!childMode) {
  test("runs room management fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "room-management-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_MANAGEMENT_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_TOKEN: "management-test-token",
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
const dir = mkdtempSync(path.join(os.tmpdir(), "room-management-"));
process.env.HOME = path.join(dir, "home");
process.env.XDG_STATE_HOME = path.join(dir, "state");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.CHAT_ROOM_SERVER_TOKEN = "management-test-token";
process.env.CHAT_ROOM_STATE_DIR = dir;
const { default: server } = await import("../server/chat-server");
const store = await import("./store");

async function call(route: string, method = "GET", body?: unknown, auth = true) {
  return server.fetch(new Request(`http://local${route}`, {
    method,
    headers: { ...(auth ? { Authorization: "Bearer management-test-token" } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

describe.serial("shared-token room management", () => {
  test("creates one persistent direct conversation between session IDs", async () => {
    const source = await call("/rooms", "POST", { name: "team", ownerId: "same", sessionID: "agent-a" });
    const room = await source.json() as { id: string };
    await call(`/rooms/${room.id}/join`, "POST", { sessionID: "agent-b", participantId: "same", participantName: "same" });
    const sourceMessage = await call(`/rooms/${room.id}/messages`, "POST", { sessionID: "agent-a", text: "source read" });
    const sourceTail = (await sourceMessage.json() as { messages: Array<{ createdAt: number }> }).messages.at(-1)!.createdAt;
    await call("/read", "POST", { roomId: room.id, sessionID: "agent-a", ts: sourceTail });
    const create = () => call("/direct", "POST", { roomId: room.id, sessionID: "agent-a", targetSessionID: "agent-b" });
    const [a, b] = await Promise.all([create(), create()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const direct = await a.json() as { id: string; kind: string; directSessionIDs: string[]; participants: Array<{ id: string; name: string }> };
    expect(direct.kind).toBe("direct");
    expect(direct.directSessionIDs.sort()).toEqual(["agent-a", "agent-b"]);
    expect(direct.participants.map((p) => p.id).sort()).toEqual(["agent-a", "agent-b"]);
    expect(await store.readState((_svc, registry) => registry[direct.id]!['agent-a']!.membershipID)).not.toBe(await store.readState((_svc, registry) => registry[room.id]!['agent-a']!.membershipID));
    expect((await (await call("/rooms")).json() as Array<{ id: string }>).some((r) => r.id === direct.id)).toBe(false);
    await call(`/rooms/${room.id}/join`, "POST", { sessionID: "agent-c", participantId: "same", participantName: "same" });
    expect((await call(`/rooms/${direct.id}/join`, "POST", { sessionID: "agent-c", participantId: "same", participantName: "same" })).status).toBe(409);
    const listed = await (await call("/rooms?sessionID=agent-a")).json() as Array<{ id: string }>;
    expect(listed.some((room) => room.id === direct.id)).toBe(true);
    const sent = await call(`/rooms/${direct.id}/messages`, "POST", { sessionID: "agent-a", text: "private" });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ messages: [{ senderSessionID: "agent-a" }] });
    const received = await (await call(`/inbox?sessionID=agent-b&roomId=${direct.id}`)).json() as { items: Array<{ text: string; roomKind?: string }> };
    expect(received.items).toMatchObject([{ text: "private", roomKind: "direct" }]);
    await call(`/rooms/${direct.id}/messages`, "POST", { sessionID: "agent-b", text: "reply" });
    const reply = await (await call(`/inbox?sessionID=agent-a&roomId=${direct.id}`)).json() as { items: Array<{ text: string }> };
    expect(reply.items.some((item) => item.text === "reply")).toBe(true);
    const cursors = await store.writeState((svc, registry) => {
      const lastReadTs = svc.getMessages(direct.id)[0]!.createdAt;
      registry[direct.id]!["agent-a"]!.lastReadTs = lastReadTs;
      registry[room.id]!["agent-a"]!.host = "updated-host";
      return lastReadTs;
    });
    await call(`/rooms/${direct.id}/leave`, "POST", { sessionID: "agent-b" });
    await call("/direct", "POST", { roomId: room.id, sessionID: "agent-b", targetSessionID: "agent-a" });
    const registry = await (await call(`/rooms/${direct.id}/registry`)).json() as Record<string, { host: string; lastReadTs: number }>;
    expect(registry["agent-a"]).toMatchObject({ host: "updated-host", lastReadTs: cursors });
    const reopened = await (await call(`/rooms/${direct.id}`)).json() as { messages: Array<{ createdAt: number }> };
    expect(registry["agent-b"]!.lastReadTs).toBe(reopened.messages.at(-1)!.createdAt);
    expect((await (await call(`/inbox?sessionID=agent-b&roomId=${direct.id}`)).json() as { items: unknown[] }).items).toEqual([]);
    expect((await (await call(`/inbox?sessionID=agent-a&roomId=${direct.id}`)).json() as { items: Array<{ text: string }> }).items.some((item) => item.text === "reply")).toBe(true);
    await call(`/rooms/${direct.id}/messages`, "POST", { sessionID: "agent-a", text: "after reopen" });
    expect((await (await call(`/inbox?sessionID=agent-b&roomId=${direct.id}`)).json() as { items: Array<{ text: string }> }).items.map((item) => item.text)).toEqual(["after reopen"]);
    expect((await call(`/rooms/${direct.id}/join`, "POST", { sessionID: "agent-c", participantId: "same", participantName: "same" })).status).toBe(409);
  });

  test("kick removes only the requested same-name session; delete purges full history", async () => {
    const created = await call("/rooms", "POST", { name: "cleanup", ownerId: "same", sessionID: "member-one" });
    const { id } = await created.json() as { id: string };
    await call(`/rooms/${id}/join`, "POST", { sessionID: "member-two", participantId: "same", participantName: "same" });
    await call(`/rooms/${id}/messages`, "POST", { sessionID: "member-one", text: "from one" });
    const fromTwo = await call(`/rooms/${id}/messages`, "POST", { sessionID: "member-two", text: "from two" });
    expect((await fromTwo.json() as { messages: Array<{ senderId: string; senderSessionID?: string }> }).messages.at(-1)).toMatchObject({ senderId: "same", senderSessionID: "member-two" });
    const history = await (await call(`/rooms/${id}/history?limit=200`)).json() as { messages: Array<{ text: string; senderSessionID?: string }> };
    expect(history.messages.filter((message) => message.text.startsWith("from ")).map((message) => message.senderSessionID)).toEqual(["member-one", "member-two"]);
    const inbox = await (await call(`/inbox?sessionID=member-one&roomId=${id}`)).json() as { items: Array<{ text: string; senderSessionID?: string }> };
    expect(inbox.items.find((message) => message.text === "from two")?.senderSessionID).toBe("member-two");
    expect((await call(`/rooms/${id}/kick`, "POST", { sessionID: "outsider", targetSessionID: "member-two" })).status).toBe(409);
    expect((await call(`/rooms/${id}/kick`, "POST", { sessionID: "member-one", targetSessionID: "missing" })).status).toBe(404);
    expect((await call(`/rooms/${id}/kick`, "POST", null)).status).toBe(400);
    expect((await call(`/rooms/${id}`, "DELETE", { sessionID: "outsider" })).status).toBe(409);
    const kick = await call(`/rooms/${id}/kick`, "POST", { sessionID: "member-one", targetSessionID: "member-two" });
    expect(kick.status).toBe(200);
    expect(await (await call(`/rooms/${id}/members`)).json()).toMatchObject([{ sessionID: "member-one", name: "same", type: "human", activity: { state: "unknown", observedAt: null } }]);
    expect((await call(`/rooms/${id}/messages`, "POST", { sessionID: "member-two", text: "blocked" })).status).toBe(409);
    for (let offset = 0; offset < 520; offset += 200) {
      await store.writeState((svc) => { for (let i = offset; i < Math.min(offset + 200, 520); i++) svc.sendMessage(id, "same", `history-${i}`, "member-one"); });
    }
    expect((await call(`/rooms/${id}/history?limit=200`)).status).toBe(200);
    let before: number | undefined, historyCount = 0;
    do {
      const page = await store.readHistory(id, before, 200);
      historyCount += page.messages.length;
      before = page.nextBeforeSeq ?? undefined;
    } while (before !== undefined);
    expect(historyCount).toBe(523);
    expect((await call(`/rooms/${id}`, "DELETE", { sessionID: "member-one" })).status).toBe(200);
    expect((await call(`/rooms/${id}`)).status).toBe(404);
    expect(await store.readHistory(id)).toMatchObject({ messages: [], nextBeforeSeq: null, hasMore: false });
  });

  test("records exact message receipts and retains history across membership generations", async () => {
    const created = await call("/rooms", "POST", { name: "receipts", ownerId: "Twin", sessionID: "reader-a" });
    const { id } = await created.json() as { id: string };
    await call(`/rooms/${id}/join`, "POST", { sessionID: "reader-b", participantId: "Twin", participantName: "Twin" });
    const first = await call(`/rooms/${id}/messages`, "POST", { sessionID: "reader-a", text: "first" });
    const firstMessage = (await first.json() as { messages: Array<{ id: string; createdAt: number }> }).messages.at(-1)!;
    const second = await call(`/rooms/${id}/messages`, "POST", { sessionID: "reader-b", text: "second" });
    const secondMessage = (await second.json() as { messages: Array<{ id: string; createdAt: number }> }).messages.at(-1)!;
    const tail = secondMessage.createdAt;
    const membershipID = await store.readState((_svc, registry) => registry[id]!["reader-a"]!.membershipID!);
    const baseline = await store.writeState((_svc, registry) => {
      const entry = registry[id]!["reader-a"]!;
      entry.lastReadTs = tail + 100;
      return entry.lastReadTs;
    });
    const initialReceipts = await (await call(`/rooms/${id}/receipts`)).json() as { receipts: Array<{ messageID: string; readers: unknown[] }>; semantics: string };
    expect(initialReceipts.receipts.find((item) => item.messageID === secondMessage.id)).toEqual({ messageID: secondMessage.id, readers: [] });
    expect(initialReceipts.semantics).toBe("per-message");
    await call("/read", "POST", { roomId: id, sessionID: "reader-a", ts: tail });
    expect((await (await call(`/rooms/${id}/receipts?messageIDs=${firstMessage.id}`)).json() as { receipts: Array<{ readers: unknown[] }> }).receipts[0]!.readers).toEqual([]);
    const receipt = { roomId: id, sessionID: "reader-a", membershipID, ts: Number.MAX_SAFE_INTEGER, messageIDs: [firstMessage.id], evidence: "displayed" };
    expect((await call("/read", "POST", receipt)).status).toBe(200);
    expect((await store.readState((_svc, registry) => registry[id]!["reader-a"]!)).lastReadTs).toBe(baseline);
    await call("/queued", "POST", { roomId: id, sessionID: "reader-b", ts: tail });
    const receipts = await call(`/rooms/${id}/receipts?messageIDs=${firstMessage.id}`);
    expect(await receipts.json()).toMatchObject({ receipts: [{ messageID: firstMessage.id, readers: [{ sessionID: "reader-a", name: "Twin", evidence: "displayed", currentMember: true }] }], semantics: "per-message" });
    const readerBMembership = await store.readState((_svc, registry) => registry[id]!["reader-b"]!.membershipID!);
    expect((await call(`/rooms/${id}/receipts`, "POST", { sessionID: "reader-b", membershipID: readerBMembership, messageIDs: [firstMessage.id], evidence: "context" })).status).toBe(200);
    await call(`/rooms/${id}/kick`, "POST", { sessionID: "reader-a", targetSessionID: "reader-b" });
    const afterKick = await (await call(`/rooms/${id}/receipts?messageIDs=${firstMessage.id}`)).json() as { receipts: Array<{ messageID: string; readers: Array<{ sessionID: string; currentMember: boolean }> }> };
    expect(afterKick.receipts[0]).toMatchObject({ messageID: firstMessage.id, readers: [{ sessionID: "reader-a", currentMember: true }, { sessionID: "reader-b", currentMember: false }] });
    await call(`/rooms/${id}/leave`, "POST", { sessionID: "reader-a" });
    await call(`/rooms/${id}/join`, "POST", { sessionID: "reader-a", participantId: "Twin", participantName: "Twin" });
    const newMembershipID = await store.readState((_svc, registry) => registry[id]!["reader-a"]!.membershipID!);
    expect(newMembershipID).not.toBe(membershipID);
    expect((await call("/read", "POST", receipt)).status).toBe(409);
    const afterRejoin = await (await call(`/rooms/${id}/receipts?messageIDs=${firstMessage.id}`)).json() as { receipts: Array<{ messageID: string; readers: Array<{ sessionID: string; currentMember: boolean }> }> };
    expect(afterRejoin.receipts[0]).toMatchObject({ messageID: firstMessage.id, readers: [
      { sessionID: "reader-a", currentMember: true }, { sessionID: "reader-b", currentMember: false },
    ] });
    const storeURL = new URL("./store.ts", import.meta.url).href;
    const script = `import {readReceipts} from ${JSON.stringify(storeURL)}; console.log(JSON.stringify(await readReceipts(${JSON.stringify(id)}, [${JSON.stringify(firstMessage.id)}])))`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toHaveLength(1);
    await call(`/rooms/${id}`, "DELETE", { sessionID: "reader-a" });
    expect((await call(`/rooms/${id}/receipts`)).status).toBe(404);
    expect(await store.readReceipts(id)).toEqual([]);
    const empty = await call("/rooms", "POST", { name: "empty", ownerId: "empty", sessionID: "empty-reader" });
    const emptyID = (await empty.json() as { id: string }).id;
    await call("/read", "POST", { roomId: emptyID, sessionID: "empty-reader", ts: 1 });
    expect(await store.readReceipts(emptyID)).toEqual([]);
  });

  test("reports real presence with TTL and session-owner isolation", async () => {
    const ownerA = "123e4567-e89b-42d3-a456-426614174000", ownerB = "123e4567-e89b-42d3-a456-426614174001";
    const create = (sessionID: string, body: Record<string, unknown>) => call("/rooms", "POST", { name: sessionID, ownerId: sessionID, sessionID, ...body });
    const first = await create("presence-a", { protocol: "v2", receiverOwnerID: ownerA });
    const second = await create("presence-b", { protocol: "v2", receiverOwnerID: ownerB });
    const legacy = await create("presence-v1", { host: "legacy-host" });
    const human = await create("presence-human", {});
    const rooms = await Promise.all([first, second, legacy, human].map(async (response) => (await response.json() as { id: string }).id));
    expect(await (await call(`/rooms/${rooms[3]}/members`)).json()).toMatchObject([{ sessionID: "presence-human", type: "human", activity: { state: "unknown", observedAt: null } }]);
    const presence = await call("/presence", "POST", { ownerID: ownerA, sequence: 1, sessions: [
      { sessionID: "presence-a", receiverOwnerID: ownerA, state: "working" },
      { sessionID: "presence-b", receiverOwnerID: ownerA, state: "idle" },
      { sessionID: "presence-v1", state: "idle" },
      { sessionID: "presence-human", state: "working" },
      { sessionID: "missing", state: "working" },
    ] });
    expect(await presence.json()).toEqual({ updatedSessionIDs: ["presence-a"] });
    expect(await (await call("/presence", "POST", { sessions: [{ sessionID: "presence-v1", state: "idle" }] })).json()).toEqual({ updatedSessionIDs: ["presence-v1"] });
    const observed = await (await call(`/rooms/${rooms[0]}/members`)).json() as Array<{ activity: { state: string; observedAt: number } }>;
    expect(observed[0]!.activity.state).toBe("working");
    expect(await (await call("/presence", "POST", { ownerID: ownerA, sequence: 1, sessions: [{ sessionID: "presence-a", state: "idle" }] })).json()).toEqual({ updatedSessionIDs: [] });
    const invalid = await call("/presence", "POST", { sessions: [
      { sessionID: "presence-a", receiverOwnerID: ownerA, state: "idle" },
      { sessionID: "presence-b", receiverOwnerID: "bad-owner", state: "working" },
    ] });
    expect(invalid.status).toBe(400);
    expect(await (await call(`/rooms/${rooms[0]}/members`)).json()).toMatchObject([{ activity: { state: "working", observedAt: observed[0]!.activity.observedAt } }]);
    await store.writeState((_svc, registry) => { registry[rooms[0]!]!["presence-a"]!.lastSeenAt = Date.now() - 60_001; });
    expect(await (await call(`/rooms/${rooms[0]}/members`)).json()).toMatchObject([{ activity: { state: "offline" } }]);
  });

  test("requires the shared token and validates request JSON", async () => {
    const before = (await store.readState((svc) => svc.listRooms().length));
    expect((await call("/rooms", "POST", { name: "unauthorized", ownerId: "x" }, false)).status).toBe(401);
    const malformed = await server.fetch(new Request("http://local/direct", { method: "POST", headers: { Authorization: "Bearer management-test-token", "Content-Type": "application/json" }, body: "{" }));
    expect(malformed.status).toBe(400);
    expect(await store.readState((svc) => svc.listRooms().length)).toBe(before);
  });

  test("serializes concurrent upgrades of an existing database", async () => {
    const migrationDir = path.join(dir, "old-database");
    await fs.mkdir(migrationDir);
    const database = new Database(path.join(migrationDir, "chat-room.sqlite"));
    database.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('json-migration','done');
      CREATE TABLE rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL); INSERT INTO rooms VALUES('legacy','legacy room','owner',1);
      CREATE TABLE participants(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(room_id,id)); INSERT INTO participants VALUES('legacy','owner','owner',1);
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,sender_session_id TEXT,text TEXT NOT NULL,created_at INTEGER NOT NULL); INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at) VALUES('legacy-message','legacy','owner','legacy-session','keep history',10);
      CREATE TABLE registry(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,session_id TEXT NOT NULL,server_url TEXT NOT NULL,api_prefix TEXT NOT NULL,protocol TEXT,name TEXT NOT NULL,last_read_ts INTEGER,last_queued_ts INTEGER,directory TEXT,host TEXT,receiver_owner_id TEXT,PRIMARY KEY(room_id,session_id)); INSERT INTO registry VALUES('legacy','legacy-session','','/api','v1','legacy',8,9,NULL,'host',NULL);`);
    database.close();
    const script = `import { loadRooms } from ${JSON.stringify(path.resolve("src/store.ts"))}; await loadRooms()`;
    const children = [1, 2].map(() => Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, CHAT_ROOM_STATE_DIR: migrationDir }, stdout: "ignore", stderr: "pipe",
    }));
    for (const child of children) {
      const code = await child.exited;
      if (code !== 0) throw new Error(await new Response(child.stderr).text());
    }
    const { readSqliteState } = await import("./sqlite-state");
    const state = await readSqliteState(path.join(migrationDir, "chat-room.sqlite"));
    expect(state.rooms).toMatchObject([{ id: "legacy", name: "legacy room", kind: "group", messages: [{ id: "legacy-message", text: "keep history" }] }]);
    expect(state.registry.legacy!["legacy-session"]).toMatchObject({ lastReadTs: 8, lastQueuedTs: 9 });
    expect(await store.readReceipts("legacy")).toEqual([]);
  });
});

afterAll(async () => {
  for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  await fs.rm(dir, { recursive: true, force: true });
});
}
