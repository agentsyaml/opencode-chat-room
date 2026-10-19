import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import RoomService, { type Message, type Room, type Participant } from "./room-service";
import type { Registry, RegistryEntry } from "./store";

type State = { rooms: Room[]; registry: Registry };
type Page<T> = { items: T[]; hasMore: boolean };
const databases = new Map<string, Promise<Database>>();

function open(file: string): Promise<Database> {
  const known = databases.get(file);
  if (known) return known;
  const pending = initialize(file);
  databases.set(file, pending);
  void pending.catch(() => databases.delete(file));
  return pending;
}

async function initialize(file: string): Promise<Database> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const db = new Database(file, { create: true });
  chmodSync(file, 0o600);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON;");
        db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS participants(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(room_id,id));
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,sender_session_id TEXT,text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq DESC);
    CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id,created_at,seq);
    CREATE TABLE IF NOT EXISTS registry(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,session_id TEXT NOT NULL,server_url TEXT NOT NULL,api_prefix TEXT NOT NULL,protocol TEXT,name TEXT NOT NULL,last_read_ts INTEGER,last_queued_ts INTEGER,directory TEXT,host TEXT,receiver_owner_id TEXT,PRIMARY KEY(room_id,session_id));`);
        await migrate(db, file);
        return db;
      } catch (error) {
        if (!isBusy(error) || attempt >= 7) throw error;
        await pause(Math.min(20 * 2 ** attempt, 250));
      }
    }
  } catch (error) { db.close(); throw error; }
}

function readLegacy(file: string): unknown | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function isBusy(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED" || /database is locked/i.test(err.message ?? "");
}

async function immediate<T>(db: Database, fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return db.transaction(fn).immediate(); }
    catch (error) {
      if (!isBusy(error) || attempt >= 7) throw error;
      await pause(Math.min(20 * 2 ** attempt, 250));
    }
  }
}

async function migrate(db: Database, file: string): Promise<void> {
  if (db.query("SELECT value FROM meta WHERE key='json-migration'").get()) return;
  const oldRooms = readLegacy(path.join(path.dirname(file), "rooms.json"));
  const oldRegistry = readLegacy(path.join(path.dirname(file), "registry.json"));
  const rooms = validateRooms(oldRooms);
  const registry = validateRegistry(oldRegistry);
  await immediate(db, () => {
    if (db.query("SELECT value FROM meta WHERE key='json-migration'").get()) return;
    for (const room of rooms) insertRoom(db, room);
    replaceRegistry(db, registry);
    db.query("INSERT INTO meta(key,value) VALUES('json-migration','done')").run();
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function validateRooms(value: unknown): Room[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Legacy rooms.json must contain an array");
  return value.map((item) => {
    if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string" ||
      typeof item.ownerId !== "string" || !timestamp(item.createdAt) || !Array.isArray(item.participants) || !Array.isArray(item.messages)) {
      throw new Error("Legacy rooms.json contains an invalid room");
    }
    const participants = new Map<string, Participant>();
    for (const p of item.participants) {
      if (!record(p) || typeof p.id !== "string" || typeof p.name !== "string" || !timestamp(p.joinedAt)) throw new Error("Legacy rooms.json contains an invalid participant");
      participants.set(p.id, { id: p.id, name: p.name, joinedAt: p.joinedAt });
    }
    let previousTs = -1;
    const messages = item.messages.map((m): Message => {
      if (!record(m) || typeof m.id !== "string" || typeof m.roomId !== "string" || m.roomId !== item.id ||
        typeof m.senderId !== "string" || typeof m.text !== "string" || !timestamp(m.createdAt) ||
        m.createdAt <= previousTs || (m.senderSessionID !== undefined && typeof m.senderSessionID !== "string")) throw new Error("Legacy rooms.json contains an invalid message");
      previousTs = m.createdAt;
      return { id: m.id, roomId: m.roomId, senderId: m.senderId, text: m.text, createdAt: m.createdAt,
        ...(m.senderSessionID !== undefined ? { senderSessionID: m.senderSessionID } : {}) };
    });
    return { id: item.id, name: item.name, ownerId: item.ownerId, createdAt: item.createdAt, participants, messages };
  });
}

function validateRegistry(value: unknown): Registry {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("Legacy registry.json must contain an object");
  const result: Registry = Object.create(null);
  for (const [roomId, members] of Object.entries(value)) {
    if (!roomId || !record(members)) throw new Error("Legacy registry.json contains an invalid room");
    result[roomId] = Object.create(null);
    for (const [sessionID, raw] of Object.entries(members)) {
      if (!sessionID || !record(raw) || typeof raw.serverUrl !== "string" || typeof raw.apiPrefix !== "string" ||
        typeof raw.name !== "string" || (raw.protocol !== undefined && raw.protocol !== "v1" && raw.protocol !== "v2") ||
        (["lastReadTs", "lastQueuedTs"].some((key) => raw[key] !== undefined && !timestamp(raw[key]))) ||
        (["directory", "host", "receiverOwnerID"].some((key) => raw[key] !== undefined && typeof raw[key] !== "string"))) {
        throw new Error("Legacy registry.json contains an invalid entry");
      }
      result[roomId]![sessionID] = { serverUrl: raw.serverUrl, apiPrefix: raw.apiPrefix, name: raw.name,
        ...(raw.protocol ? { protocol: raw.protocol } : {}),
        ...(timestamp(raw.lastReadTs) ? { lastReadTs: raw.lastReadTs } : {}),
        ...(timestamp(raw.lastQueuedTs) ? { lastQueuedTs: raw.lastQueuedTs } : {}),
        ...(typeof raw.directory === "string" ? { directory: raw.directory } : {}),
        ...(typeof raw.host === "string" ? { host: raw.host } : {}),
        ...(typeof raw.receiverOwnerID === "string" ? { receiverOwnerID: raw.receiverOwnerID } : {}) };
    }
  }
  return result;
}

function insertRoom(db: Database, room: Room): void {
  db.query("INSERT INTO rooms VALUES(?,?,?,?)").run(room.id, room.name, room.ownerId, room.createdAt);
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
  const message = db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at) VALUES(?,?,?,?,?,?)");
  for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt);
}

function replaceRegistry(db: Database, registry: Registry): void {
  db.exec("DELETE FROM registry");
  const insert = db.query("INSERT INTO registry VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const [roomID, members] of Object.entries(registry)) for (const [sessionID, r] of Object.entries(members)) {
    insert.run(roomID, sessionID, r.serverUrl, r.apiPrefix, r.protocol ?? null, r.name,
      r.lastReadTs ?? null, r.lastQueuedTs ?? null, r.directory ?? null, r.host ?? null, r.receiverOwnerID ?? null);
  }
}

function persistState(db: Database, rooms: Room[], registry: Registry): void {
  const roomRow = db.query("INSERT INTO rooms VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id,created_at=excluded.created_at");
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  const message = db.query("INSERT OR IGNORE INTO messages(id,room_id,sender_id,sender_session_id,text,created_at) VALUES(?,?,?,?,?,?)");
  const removeParticipants = db.query("DELETE FROM participants WHERE room_id=?");
  for (const room of rooms) {
    roomRow.run(room.id, room.name, room.ownerId, room.createdAt);
    removeParticipants.run(room.id);
    for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
    for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt);
  }
  replaceRegistry(db, registry);
}

function readState(db: Database): State {
  const roomRows = db.query("SELECT id,name,owner_id,created_at FROM rooms ORDER BY created_at,id").all() as Array<Record<string, string | number>>;
  const rooms = roomRows.map((r): Room => {
    const participants = new Map<string, Participant>();
    for (const p of db.query("SELECT id,name,joined_at FROM participants WHERE room_id=?").all(String(r.id)) as Array<Record<string, string | number>>) {
      participants.set(String(p.id), { id: String(p.id), name: String(p.name), joinedAt: Number(p.joined_at) });
    }
    const messages = db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 500").all(String(r.id)) as Array<Record<string, string | number | null>>;
    return { id: String(r.id), name: String(r.name), ownerId: String(r.owner_id), createdAt: Number(r.created_at), participants,
      messages: messages.reverse().map((m) => ({ id: String(m.id), roomId: String(m.room_id), senderId: String(m.sender_id),
        text: String(m.text), createdAt: Number(m.created_at), ...(m.sender_session_id ? { senderSessionID: String(m.sender_session_id) } : {}) })) };
  });
  const registry: Registry = Object.create(null);
  const rows = db.query("SELECT * FROM registry").all() as Array<Record<string, string | number | null>>;
  for (const r of rows) (registry[String(r.room_id)] ??= Object.create(null))[String(r.session_id)] = {
    serverUrl: String(r.server_url), apiPrefix: String(r.api_prefix), name: String(r.name),
    ...(r.protocol ? { protocol: r.protocol as "v1" | "v2" } : {}),
    ...(r.last_read_ts !== null ? { lastReadTs: Number(r.last_read_ts) } : {}),
    ...(r.last_queued_ts !== null ? { lastQueuedTs: Number(r.last_queued_ts) } : {}),
    ...(r.directory !== null ? { directory: String(r.directory) } : {}), ...(r.host !== null ? { host: String(r.host) } : {}),
    ...(r.receiver_owner_id !== null ? { receiverOwnerID: String(r.receiver_owner_id) } : {}),
  };
  return { rooms, registry };
}

export type HistoryMessage = Message & { seq: number };
export async function writeSqliteState<T>(file: string, callback: (service: RoomService, registry: Registry) => T): Promise<T> {
  const db = await open(file);
  return immediate(db, () => {
    const state = readState(db);
    const service = new RoomService();
    service.hydrate(state.rooms);
    const result = callback(service, state.registry);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("writeState callback must be synchronous");
    persistState(db, service.listRooms(), state.registry);
    return result;
  });
}

export async function readSqliteState(file: string): Promise<State> {
  const db = await open(file);
  return db.transaction(() => readState(db)).deferred();
}

export async function readUnreadPage(file: string, roomID: string, afterTs: number, limit = 100, sessionID?: string, senderName?: string, newest = false): Promise<Page<Message>> {
  const db = await open(file);
  const take = Math.min(200, Math.max(1, limit));
  const rows = db.query(`SELECT id,room_id,sender_id,sender_session_id,text,created_at FROM messages WHERE room_id=? AND created_at>? AND
    (? IS NULL OR (sender_session_id IS NOT NULL AND sender_session_id!=?) OR (sender_session_id IS NULL AND sender_id!=?))
    ORDER BY created_at ${newest ? "DESC" : "ASC"},seq ${newest ? "DESC" : "ASC"} LIMIT ?`)
    .all(roomID, afterTs, sessionID ?? null, sessionID ?? null, senderName ?? "", take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map(rowMessage);
  return { items: newest ? items.reverse() : items, hasMore };
}

export async function readInboxPage(file: string, sessionID: string, roomFilter: string | null, excludeSelf: boolean, limit = 100) {
  const db = await open(file);
  return db.transaction(() => {
  const take = Math.min(200, Math.max(1, limit));
  const members = db.query("SELECT room_id,last_queued_ts FROM registry WHERE session_id=? AND (? IS NULL OR room_id=?)").all(sessionID, roomFilter, roomFilter) as Array<{ room_id: string; last_queued_ts: number | null }>;
  const rows = db.query(`SELECT m.id,m.room_id,m.sender_id,m.sender_session_id,m.text,m.created_at,r.name AS room_name
    FROM messages m JOIN registry g ON g.room_id=m.room_id JOIN rooms r ON r.id=m.room_id
    WHERE g.session_id=? AND (? IS NULL OR m.room_id=?) AND
    m.created_at > CASE WHEN ? THEN max(coalesce(g.last_read_ts,0),coalesce(g.last_queued_ts,0)) ELSE coalesce(g.last_read_ts,0) END AND
    (?=0 OR (m.sender_session_id IS NOT NULL AND m.sender_session_id!=?) OR (m.sender_session_id IS NULL AND m.sender_id!=g.name))
    ORDER BY m.created_at,m.seq LIMIT ?`).all(sessionID, roomFilter, roomFilter, excludeSelf ? 1 : 0,
    excludeSelf ? 1 : 0, sessionID, take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map((row) => {
    const { senderSessionID: _sessionID, ...message } = rowMessage(row);
    return { ...message, roomName: String(row.room_name) };
  });
  const queuedTs = Object.fromEntries(members.map((member) => [member.room_id, member.last_queued_ts ?? 0]));
    return { member: members.length > 0, items, queuedTs, hasMore };
  }).deferred();
}

export async function readHistoryPage(file: string, roomID: string, beforeSeq?: number, limit = 100, excludeSessionID?: string, excludeName = ""): Promise<{ messages: HistoryMessage[]; nextBeforeSeq: number | null; hasMore: boolean }> {
  const db = await open(file);
  const take = Math.min(200, Math.max(1, limit));
  const rows = db.query(`SELECT seq,id,room_id,sender_id,sender_session_id,text,created_at FROM messages WHERE room_id=? ${beforeSeq === undefined ? "" : "AND seq<? "}AND
    (? IS NULL OR (sender_session_id IS NOT NULL AND sender_session_id!=?) OR (sender_session_id IS NULL AND sender_id!=?))
    ORDER BY seq DESC LIMIT ?`).all(...(beforeSeq === undefined ? [roomID] : [roomID, beforeSeq]),
    excludeSessionID ?? null, excludeSessionID ?? null, excludeName, take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const messages = rows.slice(0, take).reverse().map((row) => ({ ...rowMessage(row), seq: Number(row.seq) }));
  return { messages, nextBeforeSeq: hasMore ? messages[0]?.seq ?? null : null, hasMore };
}

function rowMessage(row: Record<string, string | number | null>): Message {
  return { id: String(row.id), roomId: String(row.room_id), senderId: String(row.sender_id), text: String(row.text),
    createdAt: Number(row.created_at), ...(row.sender_session_id !== null ? { senderSessionID: String(row.sender_session_id) } : {}) };
}
