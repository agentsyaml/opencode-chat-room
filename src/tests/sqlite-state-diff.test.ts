import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import RoomService from "../rooms/room-service.ts";
import { cloneState, persistStateDiff, readState } from "../state/sqlite-rooms.ts";
import { closeStateDatabases, openStateDatabase } from "../state/sqlite-state.ts";
import { writeSqliteState } from "../state/sqlite-state-store.ts";
import type { StateDatabase } from "../state/sqlite.ts";
import { immediate } from "../state/sqlite-transaction.ts";

const originalDatabaseUrl = process.env.CHAT_ROOM_DATABASE_URL;
delete process.env.CHAT_ROOM_DATABASE_URL;
const root = mkdtempSync(path.join(tmpdir(), "chat-room-state-diff-"));

const stateFile = (name: string) => path.join(root, `${name}.sqlite`);
const entry = (name: string) => ({ serverUrl: "", apiPrefix: "/api", name, lastReadTs: 0, lastQueuedTs: 0 });

function recordingDatabase(db: StateDatabase): { db: StateDatabase; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    db: {
      query(sql: string) { statements.push(sql); return db.query(sql); },
      prepare(sql: string) { statements.push(sql); return db.prepare(sql); },
      exec(sql: string) { statements.push(sql); db.exec(sql); },
      transaction: db.transaction.bind(db),
      close: db.close.bind(db),
    } as StateDatabase,
  };
}

describe("SQLite state diff", () => {
  test("leaves untouched rooms, participants, messages, and registry rows in place", async () => {
    const file = stateFile("untouched");
    const roomID = await writeSqliteState(file, (service, registry) => {
      const room = service.createRoom("stable", "owner");
      service.joinRoom(room.id, { id: "alice", name: "alice" });
      service.sendMessage(room.id, "owner", "hello");
      registry[room.id] = { first: entry("first"), second: entry("second") };
      return room.id;
    });
    const db = await openStateDatabase(file);
    const rowid = (table: string, where: string, ...params: string[]) =>
      (db.query(`SELECT rowid AS id FROM ${table} WHERE ${where}`).get(...params) as { id: number }).id;
    const roomRow = rowid("rooms", "id=?", roomID);
    const participantRow = rowid("participants", "room_id=? AND id=?", roomID, "alice");
    const registryRow = rowid("registry", "room_id=? AND session_id=?", roomID, "first");
    const messageRow = (db.query("SELECT seq FROM messages WHERE room_id=?").get(roomID) as { seq: number }).seq;

    const before = readState(db);
    const working = cloneState(before);
    const recorded = recordingDatabase(db);
    await immediate(db, () => persistStateDiff(recorded.db, before, { rooms: working.rooms, registry: working.registry }));

    expect(recorded.statements.some((sql) => /^\s*DELETE\s+FROM\s+registry\s*$/i.test(sql))).toBe(false);
    expect(recorded.statements.some((sql) => /^\s*DELETE\s+FROM\s+rooms\s*$/i.test(sql))).toBe(false);
    expect(recorded.statements.some((sql) => /^\s*DELETE\s+FROM\s+participants\s+WHERE\s+room_id=\?\s*$/i.test(sql))).toBe(false);
    expect(rowid("rooms", "id=?", roomID)).toBe(roomRow);
    expect(rowid("participants", "room_id=? AND id=?", roomID, "alice")).toBe(participantRow);
    expect(rowid("registry", "room_id=? AND session_id=?", roomID, "first")).toBe(registryRow);
    expect((db.query("SELECT seq FROM messages WHERE room_id=?").get(roomID) as { seq: number }).seq).toBe(messageRow);
    expect((db.query("SELECT COUNT(*) AS count FROM messages WHERE room_id=?").get(roomID) as { count: number }).count).toBe(1);
  });

  test("applies room, participant, message, and registry changes only to changed rows", async () => {
    const file = stateFile("changes");
    let roomA = "", roomB = "";
    roomA = await writeSqliteState(file, (service, registry) => {
      const room = service.createRoom("alpha", "owner");
      service.joinRoom(room.id, { id: "alice", name: "alice" });
      service.sendMessage(room.id, "owner", "m1");
      service.sendMessage(room.id, "owner", "m2");
      registry[room.id] = { keep: entry("keep"), drop: entry("drop") };
      return room.id;
    });
    const db = await openStateDatabase(file);
    const rowid = (table: string, where: string, ...params: string[]) =>
      (db.query(`SELECT rowid AS id FROM ${table} WHERE ${where}`).get(...params) as { id: number }).id;
    const roomARow = rowid("rooms", "id=?", roomA);
    const ownerRow = rowid("participants", "room_id=? AND id=?", roomA, "owner");
    const keepRow = rowid("registry", "room_id=? AND session_id=?", roomA, "keep");
    const firstSeq = (db.query("SELECT seq FROM messages WHERE room_id=? ORDER BY seq LIMIT 1").get(roomA) as { seq: number }).seq;
    db.query("UPDATE registry SET membership_id=NULL WHERE room_id=? AND session_id=?").run(roomA, "keep");

    await writeSqliteState(file, (service, registry) => {
      const room = service.getRoom(roomA);
      room.name = "alpha renamed";
      service.joinRoom(roomA, { id: "bob", name: "bob" });
      service.leaveRoom(roomA, "alice");
      service.sendMessage(roomA, "owner", "m3");
      const first = room.messages.find((message) => message.text === "m1")!;
      first.recalledAt = 1234;
      first.recalledBy = "owner";
      const second = room.messages.find((message) => message.text === "m2")!;
      second.isQuestion = true;
      second.answerToMessageID = "question-id";
      second.answeredByMessageID = "answer-id";
      registry[roomA]!.keep!.lastReadTs = 99;
      registry[roomA]!.added = entry("added");
      delete registry[roomA]!.drop;
      const created = service.createRoom("bravo", "owner");
      roomB = created.id;
      registry[roomB] = { sessionB: entry("sessionB") };
    });

    expect((db.query("SELECT name FROM rooms WHERE id=?").get(roomA) as { name: string }).name).toBe("alpha renamed");
    expect((db.query("SELECT id FROM participants WHERE room_id=? ORDER BY id").all(roomA) as Array<{ id: string }>).map((row) => row.id)).toEqual(["bob", "owner"]);
    const messages = db.query("SELECT id,text,is_question,answer_to,answered_by,recalled_at,recalled_by FROM messages WHERE room_id=? ORDER BY seq").all(roomA) as Array<Record<string, string | number | null>>;
    expect(messages.map((message) => message.text)).toEqual(["m1", "m2", "m3"]);
    expect(messages[0]).toMatchObject({ recalled_at: 1234, recalled_by: "owner" });
    expect(messages[1]).toMatchObject({ is_question: 1, answer_to: "question-id", answered_by: "answer-id" });
    const registry = readState(db).registry[roomA]!;
    expect(registry.keep).toMatchObject({ lastReadTs: 99 });
    expect(registry.keep!.membershipID).toBeTruthy();
    expect(registry.added).toMatchObject({ name: "added" });
    expect(registry.drop).toBeUndefined();
    expect(readState(db).registry[roomB]!.sessionB!.membershipID).toBeTruthy();
    expect(rowid("rooms", "id=?", roomA)).toBe(roomARow);
    expect(rowid("participants", "room_id=? AND id=?", roomA, "owner")).toBe(ownerRow);
    expect(rowid("registry", "room_id=? AND session_id=?", roomA, "keep")).toBe(keepRow);
    expect((db.query("SELECT seq FROM messages WHERE room_id=? ORDER BY seq LIMIT 1").get(roomA) as { seq: number }).seq).toBe(firstSeq);

    await writeSqliteState(file, (service, registry) => {
      service.deleteRoom(roomB);
      delete registry[roomB];
    });
    const remaining = readState(db);
    expect(remaining.rooms.map((room) => room.id)).toEqual([roomA]);
    expect(remaining.registry[roomB]).toBeUndefined();
    expect((db.query("SELECT COUNT(*) AS count FROM participants WHERE room_id=?").get(roomB) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM registry WHERE room_id=?").get(roomB) as { count: number }).count).toBe(0);
  });

  test("a stale snapshot does not delete another snapshot's rooms or registry entries", async () => {
    const file = stateFile("stale");
    const db = await openStateDatabase(file);
    const beforeA = readState(db);
    const beforeB = readState(db);

    const workingA = cloneState(beforeA);
    const serviceA = new RoomService();
    serviceA.hydrate(workingA.rooms);
    const roomA = serviceA.createRoom("instance-a", "owner-a");
    serviceA.sendMessage(roomA.id, "owner-a", "from a");
    workingA.registry[roomA.id] = { sessionA: entry("a") };
    await immediate(db, () => persistStateDiff(db, beforeA, { rooms: serviceA.listRooms(), registry: workingA.registry }));

    const workingB = cloneState(beforeB);
    const serviceB = new RoomService();
    serviceB.hydrate(workingB.rooms);
    const roomB = serviceB.createRoom("instance-b", "owner-b");
    serviceB.sendMessage(roomB.id, "owner-b", "from b");
    workingB.registry[roomB.id] = { sessionB: entry("b") };
    await immediate(db, () => persistStateDiff(db, beforeB, { rooms: serviceB.listRooms(), registry: workingB.registry }));

    const state = readState(db);
    expect(state.rooms.map((room) => room.name).sort()).toEqual(["instance-a", "instance-b"]);
    expect(Object.keys(state.registry).sort()).toEqual([roomA.id, roomB.id].sort());
    expect(state.rooms.find((room) => room.id === roomA.id)?.messages.map((message) => message.text)).toEqual(["from a"]);
    expect(state.rooms.find((room) => room.id === roomB.id)?.messages.map((message) => message.text)).toEqual(["from b"]);
  });
});

afterAll(async () => {
  await closeStateDatabases();
  rmSync(root, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.CHAT_ROOM_DATABASE_URL;
  else process.env.CHAT_ROOM_DATABASE_URL = originalDatabaseUrl;
});