import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import RoomService, { type Message, type Room, type Participant } from "./room-service";
import type { MessageReceipt, PresenceReport, ReceiptEvidence, ReceiptIdentity, ReceiptWriteResult, Registry, RegistryEntry } from "./store";
import { presenceOwnerMatches, receiptOwnerMatches } from "./member-state";

type State = { rooms: Room[]; registry: Registry };
type Page<T> = { items: T[]; hasMore: boolean };
const databases = new Map<string, Promise<Database>>();

export function openStateDatabase(file: string): Promise<Database> {
  const known = databases.get(file);
  if (known) return known;
  const pending = initialize(file);
  databases.set(file, pending);
  void pending.catch(() => databases.delete(file));
  return pending;
}

export async function withStateTransaction<T>(file: string, callback: (db: Database) => T): Promise<T> {
  const db = await openStateDatabase(file);
  return immediate(db, () => callback(db));
}

export async function initializeAdminSchema(file: string): Promise<void> {
  await withStateTransaction(file, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS admin_rooms(room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,target_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,session_id TEXT NOT NULL,receiver_owner_id TEXT NOT NULL,membership_id TEXT NOT NULL,generation INTEGER NOT NULL,enrollment_hash TEXT NOT NULL,enrollment_expires INTEGER NOT NULL,capability_hash TEXT,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_tasks(id TEXT PRIMARY KEY,admin_room_id TEXT NOT NULL REFERENCES admin_rooms(room_id) ON DELETE CASCADE,admin_generation INTEGER NOT NULL DEFAULT 1,target_room_id TEXT NOT NULL,target_session_id TEXT NOT NULL,target_owner_id TEXT NOT NULL DEFAULT '',target_membership_id TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,status TEXT NOT NULL,progress TEXT NOT NULL,delivery_token_hash TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_plans(id TEXT PRIMARY KEY,admin_room_id TEXT NOT NULL REFERENCES admin_rooms(room_id) ON DELETE CASCADE,name TEXT NOT NULL,interval_seconds INTEGER NOT NULL,text TEXT NOT NULL,paused INTEGER NOT NULL,next_run_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_deliveries(id TEXT PRIMARY KEY,admin_room_id TEXT NOT NULL REFERENCES admin_rooms(room_id) ON DELETE CASCADE,generation INTEGER NOT NULL,recipient_room_id TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL,owner_id TEXT NOT NULL,membership_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,task_id TEXT,task_token TEXT,admission_id TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,UNIQUE(admin_room_id,kind,task_id));
  CREATE INDEX IF NOT EXISTS admin_delivery_target ON admin_deliveries(session_id,owner_id,acknowledged);`);
  const taskColumns = db.query("PRAGMA table_info(admin_tasks)").all() as Array<{ name: string }>;
  if (!taskColumns.some(column => column.name === "delivery_token_hash")) db.exec("ALTER TABLE admin_tasks ADD COLUMN delivery_token_hash TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.some(column => column.name === "admin_generation")) db.exec("ALTER TABLE admin_tasks ADD COLUMN admin_generation INTEGER NOT NULL DEFAULT 1");
  if (!taskColumns.some(column => column.name === "target_owner_id")) db.exec("ALTER TABLE admin_tasks ADD COLUMN target_owner_id TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.some(column => column.name === "target_membership_id")) db.exec("ALTER TABLE admin_tasks ADD COLUMN target_membership_id TEXT NOT NULL DEFAULT ''");
  const deliveryColumns = db.query("PRAGMA table_info(admin_deliveries)").all() as Array<{ name: string }>;
  if (!deliveryColumns.some(column => column.name === "task_token")) db.exec("ALTER TABLE admin_deliveries ADD COLUMN task_token TEXT");
  if (!deliveryColumns.some(column => column.name === "recipient_room_id")) db.exec("ALTER TABLE admin_deliveries ADD COLUMN recipient_room_id TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE admin_deliveries SET admission_id='msg_' || substr(admission_id,7) WHERE admission_id LIKE 'admin:%'");
  });
}

export async function initializeReminderSchema(file: string): Promise<void> {
  await withStateTransaction(file, db => db.exec(`CREATE TABLE IF NOT EXISTS room_reminders(
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    creator_session_id TEXT NOT NULL, text TEXT NOT NULL, schedule_type TEXT NOT NULL,
    at TEXT, expression TEXT, timezone TEXT, paused INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_error TEXT);`));
  await withStateTransaction(file, db => {
    const columns = db.query("PRAGMA table_info(room_reminders)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "initiator")) db.exec("ALTER TABLE room_reminders ADD COLUMN initiator TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === "last_error")) db.exec("ALTER TABLE room_reminders ADD COLUMN last_error TEXT");
  });
}

async function initialize(file: string): Promise<Database> {
  const directory = path.dirname(file);
  const hint = "Make that directory writable by the process user; in Docker use a named volume or chown it to uid 10001.";
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new Error(`cannot create the state directory ${directory}: ${(error as Error).message}. ${hint}`); }
  // A mounted state directory may belong to another user (Docker bind mount);
  // tightening its mode is best effort, not a reason to refuse to start.
  try { chmodSync(directory, 0o700); } catch { /* keep the mounted permissions */ }
  // Create the file 0600 up front so the default umask never leaves chat history
  // readable by other users, even for the instant before the chmod below runs.
  try { writeFileSync(file, "", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`cannot create the state database ${file}: ${(error as Error).message}. ${hint}`); }
  let db: Database;
  try { db = new Database(file, { create: true }); }
  catch (error) { throw new Error(`cannot open the state database ${file}: ${(error as Error).message}. ${hint}`); }
  try { chmodSync(file, 0o600); } catch { console.warn(`[chat-room] could not tighten permissions on ${file}; check who owns the state directory`); }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
        db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'group',direct_sessions TEXT,direct_pair TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS participants(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(room_id,id));
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,sender_session_id TEXT,text TEXT NOT NULL,created_at INTEGER NOT NULL,is_question INTEGER NOT NULL DEFAULT 0,answer_to TEXT,answered_by TEXT);
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq DESC);
    CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id,created_at,seq);
    CREATE TABLE IF NOT EXISTS registry(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,session_id TEXT NOT NULL,server_url TEXT NOT NULL,api_prefix TEXT NOT NULL,protocol TEXT,name TEXT NOT NULL,last_read_ts INTEGER,last_queued_ts INTEGER,directory TEXT,host TEXT,receiver_owner_id TEXT,membership_id TEXT,work_state TEXT,last_seen_at INTEGER,PRIMARY KEY(room_id,session_id));`);
        db.exec("CREATE TABLE IF NOT EXISTS announcements(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,name TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,name))");
        db.exec("CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL)");
        await ensureRoomColumns(db);
        await migrate(db, file);
        db.exec("PRAGMA busy_timeout=50;");
        return db;
      } catch (error) {
        if (!isBusy(error) || attempt >= 7) throw error;
        await pause(Math.min(20 * 2 ** attempt, 250));
      }
    }
  } catch (error) { db.close(); throw error; }
}

export type Announcement = { roomID: string; name: string; content: string; updatedAt: number };
export async function listAnnouncements(file: string, roomID: string): Promise<Announcement[]> {
  const db = await openStateDatabase(file);
  if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return [];
  return db.query("SELECT room_id AS roomID,name,content,updated_at AS updatedAt FROM announcements WHERE room_id=? ORDER BY name").all(roomID) as Announcement[];
}
export async function getAnnouncement(file: string, roomID: string, name: string): Promise<Announcement | undefined> {
  const db = await openStateDatabase(file);
  return db.query("SELECT room_id AS roomID,name,content,updated_at AS updatedAt FROM announcements WHERE room_id=? AND name=?").get(roomID, name) as Announcement | undefined;
}
export async function putAnnouncement(file: string, roomID: string, name: string, content: string, updatedAt: number): Promise<Announcement | undefined> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return undefined;
    db.query("INSERT INTO announcements(room_id,name,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(room_id,name) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at").run(roomID, name, content, updatedAt);
    return { roomID, name, content, updatedAt };
  });
}
export async function deleteAnnouncement(file: string, roomID: string, name: string): Promise<boolean> {
  const db = await openStateDatabase(file);
  return immediate(db, () => db.query("DELETE FROM announcements WHERE room_id=? AND name=?").run(roomID, name).changes > 0);
}

export type StoredResource = { id: string; roomID: string; name: string; mimeType: string; size: number; createdAt: number };
export async function putResource(file: string, resource: StoredResource): Promise<boolean> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(resource.roomID)) return false;
    db.query("INSERT INTO resources(id,room_id,name,mime_type,size,created_at) VALUES(?,?,?,?,?,?)")
      .run(resource.id, resource.roomID, resource.name, resource.mimeType, resource.size, resource.createdAt);
    return true;
  });
}
export async function getResource(file: string, roomID: string, id: string): Promise<StoredResource | undefined> {
  const db = await openStateDatabase(file);
  const row = db.query("SELECT id,room_id AS roomID,name,mime_type AS mimeType,size,created_at AS createdAt FROM resources WHERE room_id=? AND id=?")
    .get(roomID, id) as StoredResource | null;
  return row ?? undefined;
}
async function ensureRoomColumns(db: Database): Promise<void> {
    await immediate(db, () => {
    const messageColumns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "is_question")) db.exec("ALTER TABLE messages ADD COLUMN is_question INTEGER NOT NULL DEFAULT 0");
    if (!messageColumns.some((column) => column.name === "answer_to")) db.exec("ALTER TABLE messages ADD COLUMN answer_to TEXT");
    if (!messageColumns.some((column) => column.name === "answered_by")) db.exec("ALTER TABLE messages ADD COLUMN answered_by TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS messages_pending_questions ON messages(room_id,is_question,answered_by,seq)");
    const columns = db.query("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "kind")) db.exec("ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'group'");
    if (!columns.some((column) => column.name === "direct_sessions")) db.exec("ALTER TABLE rooms ADD COLUMN direct_sessions TEXT");
    if (!columns.some((column) => column.name === "direct_pair")) db.exec("ALTER TABLE rooms ADD COLUMN direct_pair TEXT");
    const registry = db.query("PRAGMA table_info(registry)").all() as Array<{ name: string }>;
    if (!registry.some((column) => column.name === "membership_id")) db.exec("ALTER TABLE registry ADD COLUMN membership_id TEXT");
    if (!registry.some((column) => column.name === "work_state")) db.exec("ALTER TABLE registry ADD COLUMN work_state TEXT");
    if (!registry.some((column) => column.name === "last_seen_at")) db.exec("ALTER TABLE registry ADD COLUMN last_seen_at INTEGER");
    db.exec("DROP TABLE IF EXISTS read_receipts");
    db.exec("CREATE TABLE IF NOT EXISTS message_receipts(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,session_id TEXT NOT NULL,name TEXT NOT NULL,evidence TEXT NOT NULL,read_at INTEGER NOT NULL,PRIMARY KEY(room_id,message_id,session_id))");
    db.exec("CREATE TABLE IF NOT EXISTS presence_sequences(owner_id TEXT PRIMARY KEY,last_sequence INTEGER NOT NULL)");
    const missing = db.query("SELECT room_id,session_id FROM registry WHERE membership_id IS NULL OR membership_id=''").all() as Array<{ room_id: string; session_id: string }>;
    const assign = db.query("UPDATE registry SET membership_id=? WHERE room_id=? AND session_id=? AND (membership_id IS NULL OR membership_id='')");
    for (const row of missing) assign.run(randomUUID(), row.room_id, row.session_id);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS rooms_direct_pair ON rooms(direct_pair) WHERE direct_pair IS NOT NULL");
  });
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
        (["lastReadTs", "lastQueuedTs", "lastSeenAt"].some((key) => raw[key] !== undefined && !timestamp(raw[key]))) ||
        (raw.workState !== undefined && !["working", "idle", "waiting", "unknown"].includes(String(raw.workState))) ||
        (["directory", "host", "receiverOwnerID", "membershipID"].some((key) => raw[key] !== undefined && typeof raw[key] !== "string"))) {
        throw new Error("Legacy registry.json contains an invalid entry");
      }
      result[roomId]![sessionID] = { serverUrl: raw.serverUrl, apiPrefix: raw.apiPrefix, name: raw.name,
        ...(raw.protocol ? { protocol: raw.protocol } : {}),
        ...(timestamp(raw.lastReadTs) ? { lastReadTs: raw.lastReadTs } : {}),
        ...(timestamp(raw.lastQueuedTs) ? { lastQueuedTs: raw.lastQueuedTs } : {}),
        ...(typeof raw.directory === "string" ? { directory: raw.directory } : {}),
        ...(typeof raw.host === "string" ? { host: raw.host } : {}),
        ...(typeof raw.receiverOwnerID === "string" ? { receiverOwnerID: raw.receiverOwnerID } : {}),
        ...(typeof raw.membershipID === "string" ? { membershipID: raw.membershipID } : {}),
        ...(typeof raw.workState === "string" ? { workState: raw.workState as RegistryEntry["workState"] } : {}),
        ...(timestamp(raw.lastSeenAt) ? { lastSeenAt: raw.lastSeenAt } : {}) };
    }
  }
  return result;
}

function insertRoom(db: Database, room: Room): void {
  db.query("INSERT INTO rooms(id,name,owner_id,created_at,kind,direct_sessions,direct_pair) VALUES(?,?,?,?,?,?,?)").run(room.id, room.name, room.ownerId, room.createdAt, room.kind ?? "group", room.directSessionIDs ? JSON.stringify(room.directSessionIDs) : null, room.directPair ?? null);
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
  const message = db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt, m.isQuestion ? 1 : 0, m.answerToMessageID ?? null, m.answeredByMessageID ?? null);
}

function replaceRegistry(db: Database, registry: Registry): void {
  db.exec("DELETE FROM registry");
  const insert = db.query("INSERT INTO registry(room_id,session_id,server_url,api_prefix,protocol,name,last_read_ts,last_queued_ts,directory,host,receiver_owner_id,membership_id,work_state,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const [roomID, members] of Object.entries(registry)) for (const [sessionID, r] of Object.entries(members)) {
    r.membershipID ||= randomUUID();
    insert.run(roomID, sessionID, r.serverUrl, r.apiPrefix, r.protocol ?? null, r.name,
      r.lastReadTs ?? null, r.lastQueuedTs ?? null, r.directory ?? null, r.host ?? null, r.receiverOwnerID ?? null,
      r.membershipID, r.workState ?? null, r.lastSeenAt ?? null);
  }
}

function persistState(db: Database, rooms: Room[], registry: Registry): void {
  const roomRow = db.query("INSERT INTO rooms(id,name,owner_id,created_at,kind,direct_sessions,direct_pair) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id,created_at=excluded.created_at,kind=excluded.kind,direct_sessions=excluded.direct_sessions,direct_pair=excluded.direct_pair");
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  const message = db.query("INSERT OR IGNORE INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by) VALUES(?,?,?,?,?,?,?,?,?)");
  const removeParticipants = db.query("DELETE FROM participants WHERE room_id=?");
  const keep = new Set(rooms.map((room) => room.id));
  const existing = db.query("SELECT id FROM rooms").all() as Array<{ id: string }>;
  const deleteRoom = db.query("DELETE FROM rooms WHERE id=?");
  for (const row of existing) if (!keep.has(row.id)) deleteRoom.run(row.id);
  for (const room of rooms) {
    roomRow.run(room.id, room.name, room.ownerId, room.createdAt, room.kind ?? "group", room.directSessionIDs ? JSON.stringify(room.directSessionIDs) : null, room.directPair ?? null);
    removeParticipants.run(room.id);
    for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
    for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt, m.isQuestion ? 1 : 0, m.answerToMessageID ?? null, m.answeredByMessageID ?? null);
  }
  replaceRegistry(db, registry);
}

function readState(db: Database): State {
  const roomRows = db.query("SELECT id,name,owner_id,created_at,kind,direct_sessions,direct_pair FROM rooms ORDER BY created_at,id").all() as Array<Record<string, string | number | null>>;
  const rooms = roomRows.map((r): Room => {
    const participants = new Map<string, Participant>();
    for (const p of db.query("SELECT id,name,joined_at FROM participants WHERE room_id=?").all(String(r.id)) as Array<Record<string, string | number>>) {
      participants.set(String(p.id), { id: String(p.id), name: String(p.name), joinedAt: Number(p.joined_at) });
    }
    const messages = db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 500").all(String(r.id)) as Array<Record<string, string | number | null>>;
    return { id: String(r.id), name: String(r.name), ownerId: String(r.owner_id), createdAt: Number(r.created_at), kind: r.kind === "direct" ? "direct" : "group", ...(r.direct_sessions ? { directSessionIDs: JSON.parse(String(r.direct_sessions)) as string[] } : {}), ...(r.direct_pair ? { directPair: String(r.direct_pair) } : {}), participants,
      messages: messages.reverse().map((m) => ({ id: String(m.id), roomId: String(m.room_id), senderId: String(m.sender_id),
         text: String(m.text), createdAt: Number(m.created_at), ...(m.sender_session_id ? { senderSessionID: String(m.sender_session_id) } : {}), ...(m.is_question ? { isQuestion: true } : {}), ...(m.answer_to ? { answerToMessageID: String(m.answer_to) } : {}), ...(m.answered_by ? { answeredByMessageID: String(m.answered_by) } : {}) })) };
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
    ...(r.membership_id !== null ? { membershipID: String(r.membership_id) } : {}),
    ...(r.work_state !== null ? { workState: String(r.work_state) as RegistryEntry["workState"] } : {}),
    ...(r.last_seen_at !== null ? { lastSeenAt: Number(r.last_seen_at) } : {}),
  };
  return { rooms, registry };
}

export type HistoryMessage = Message & { seq: number };
export async function writeSqliteState<T>(file: string, callback: (service: RoomService, registry: Registry) => T): Promise<T> {
  return writeSqliteStateWithDatabase(file, (service, registry) => callback(service, registry));
}

export async function writeSqliteStateWithDatabase<T>(file: string, callback: (service: RoomService, registry: Registry, db: Database) => T): Promise<T> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    const state = readState(db);
    const service = new RoomService();
    service.hydrate(state.rooms);
    const result = callback(service, state.registry, db);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("writeState callback must be synchronous");
    persistState(db, service.listRooms(), state.registry);
    return result;
  });
}

export async function readSqliteState(file: string): Promise<State> {
  const db = await openStateDatabase(file);
  return db.transaction(() => readState(db)).deferred();
}

export async function readQuestions(file: string, roomID: string): Promise<Message[]> {
  const db = await openStateDatabase(file);
  return (db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND is_question=1 AND answered_by IS NULL ORDER BY seq").all(roomID) as Array<Record<string, string | number | null>>).map(rowMessage);
}

export async function answerQuestion(file: string, roomID: string, questionID: string, sessionID: string, text: string): Promise<{ status: "ok"; answer: Message } | { status: "missing" | "member" | "question" | "answered" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    const question = db.query("SELECT is_question,answered_by FROM messages WHERE room_id=? AND id=?").get(roomID, questionID) as { is_question: number; answered_by: string | null } | null;
    if (!question || !question.is_question) return { status: "question" };
    if (question.answered_by) return { status: "answered" };
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const answer: Message = { id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name, senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1), answerToMessageID: questionID };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to) VALUES(?,?,?,?,?,?,0,?)").run(answer.id, roomID, answer.senderId, sessionID, text, answer.createdAt, questionID);
    const update = db.query("UPDATE messages SET answered_by=? WHERE room_id=? AND id=? AND is_question=1 AND answered_by IS NULL").run(answer.id, roomID, questionID);
    if (update.changes !== 1) throw new Error("question answer race");
    return { status: "ok", answer };
  });
}

export async function appendRoomMessage(file: string, roomID: string, sessionID: string, text: string, isQuestion: boolean): Promise<{ status: "ok"; message: Message } | { status: "missing" | "member" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const message: Message = {
      id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name,
      senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1),
      ...(isQuestion ? { isQuestion: true } : {}),
    };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question) VALUES(?,?,?,?,?,?,?)")
      .run(message.id, roomID, message.senderId, sessionID, text, message.createdAt, isQuestion ? 1 : 0);
    return { status: "ok", message };
  });
}

export async function sendReply(file: string, roomID: string, targetID: string, sessionID: string, text: string): Promise<{ status: "ok"; message: Message } | { status: "missing" | "member" | "target" | "question" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    const target = db.query("SELECT is_question FROM messages WHERE room_id=? AND id=?").get(roomID, targetID) as { is_question: number } | null;
    if (!target) return { status: "target" };
    if (target.is_question) return { status: "question" };
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const message: Message = { id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name, senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1), answerToMessageID: targetID };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to) VALUES(?,?,?,?,?,?,0,?)").run(message.id, roomID, message.senderId, sessionID, text, message.createdAt, targetID);
    return { status: "ok", message };
  });
}

function questionExcerpt(text: string): string {
  const chars = Array.from(text);
  return chars.length <= 200 ? text : `${chars.slice(0, 100).join("")}…${chars.slice(-100).join("")}`;
}

export async function readQuestionExcerpt(file: string, roomID: string, questionID: string): Promise<string | undefined> {
  const db = await openStateDatabase(file);
  const row = db.query("SELECT text FROM messages WHERE room_id=? AND id=? AND is_question=1").get(roomID, questionID) as { text: string } | null;
  return row ? questionExcerpt(row.text) : undefined;
}

export async function readUnreadPage(file: string, roomID: string, afterTs: number, limit = 100, sessionID?: string, senderName?: string, newest = false): Promise<Page<Message>> {
  const db = await openStateDatabase(file);
  const take = Math.min(200, Math.max(1, limit));
  const rows = db.query(`SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND created_at>? AND
    (? IS NULL OR (sender_session_id IS NOT NULL AND sender_session_id!=?) OR (sender_session_id IS NULL AND sender_id!=?))
    ORDER BY created_at ${newest ? "DESC" : "ASC"},seq ${newest ? "DESC" : "ASC"} LIMIT ?`)
    .all(roomID, afterTs, sessionID ?? null, sessionID ?? null, senderName ?? "", take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map(rowMessage);
  return { items: newest ? items.reverse() : items, hasMore };
}

export async function readInboxPage(file: string, sessionID: string, roomFilter: string | null, excludeSelf: boolean, limit = 100, afterTs?: number) {
  const db = await openStateDatabase(file);
  return db.transaction(() => {
  const take = Math.min(200, Math.max(1, limit));
  const members = db.query("SELECT room_id,last_queued_ts FROM registry WHERE session_id=? AND (? IS NULL OR room_id=?)").all(sessionID, roomFilter, roomFilter) as Array<{ room_id: string; last_queued_ts: number | null }>;
  const rows = db.query(`SELECT m.id,m.room_id,m.sender_id,m.sender_session_id,m.text,m.created_at,m.is_question,m.answer_to,m.answered_by,r.name AS room_name,r.kind AS room_kind,q.text AS answer_question_text
    FROM messages m JOIN registry g ON g.room_id=m.room_id JOIN rooms r ON r.id=m.room_id LEFT JOIN messages q ON q.room_id=m.room_id AND q.id=m.answer_to AND q.is_question=1
    WHERE g.session_id=? AND (? IS NULL OR m.room_id=?) AND
    m.created_at > coalesce(?,CASE WHEN ? THEN max(coalesce(g.last_read_ts,0),coalesce(g.last_queued_ts,0)) ELSE coalesce(g.last_read_ts,0) END) AND
    (?=0 OR (m.sender_session_id IS NOT NULL AND m.sender_session_id!=?) OR (m.sender_session_id IS NULL AND m.sender_id!=g.name))
    ORDER BY m.created_at,m.seq LIMIT ?`).all(sessionID, roomFilter, roomFilter, afterTs ?? null, excludeSelf ? 1 : 0,
    excludeSelf ? 1 : 0, sessionID, take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map((row) => {
    const message = rowMessage(row);
    return { ...message, ...(row.answer_question_text !== null ? { answerQuestionExcerpt: questionExcerpt(String(row.answer_question_text)) } : {}), roomName: String(row.room_name), roomKind: (row.room_kind === "direct" ? "direct" : "group") as "direct" | "group" };
  });
  const queuedTs = Object.fromEntries(members.map((member) => [member.room_id, member.last_queued_ts ?? 0]));
    return { member: members.length > 0, items, queuedTs, hasMore };
  }).deferred();
}

export async function readHistoryPage(file: string, roomID: string, beforeSeq?: number, limit = 100, excludeSessionID?: string, excludeName = ""): Promise<{ messages: HistoryMessage[]; nextBeforeSeq: number | null; hasMore: boolean }> {
  const db = await openStateDatabase(file);
  const take = Math.min(200, Math.max(1, limit));
  const rows = db.query(`SELECT seq,id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? ${beforeSeq === undefined ? "" : "AND seq<? "}AND
    (? IS NULL OR (sender_session_id IS NOT NULL AND sender_session_id!=?) OR (sender_session_id IS NULL AND sender_id!=?))
    ORDER BY seq DESC LIMIT ?`).all(...(beforeSeq === undefined ? [roomID] : [roomID, beforeSeq]),
    excludeSessionID ?? null, excludeSessionID ?? null, excludeName, take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const messages = rows.slice(0, take).reverse().map((row) => ({ ...rowMessage(row), seq: Number(row.seq) }));
  return { messages, nextBeforeSeq: hasMore ? messages[0]?.seq ?? null : null, hasMore };
}

export async function readMessageReceipts(file: string, roomID: string, messageIDs?: string[]): Promise<MessageReceipt[] | undefined> {
  const db = await openStateDatabase(file);
  return db.transaction(() => {
    if (messageIDs && (!messageIDs.length || messageIDs.length > 500 || messageIDs.some((id) => !id))) return undefined;
    const requested = messageIDs ? [...new Set(messageIDs)] : undefined;
    const selected = requested
      ? db.query(`SELECT id FROM messages WHERE room_id=? AND id IN (${requested.map(() => "?").join(",")}) ORDER BY seq`).all(roomID, ...requested) as Array<{ id: string }>
      : db.query("SELECT id FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 500").all(roomID) as Array<{ id: string }>;
    if (requested && selected.length !== requested.length) return undefined;
    const ids = (requested ? selected : selected.reverse()).map((row) => row.id);
    const rows = ids.length ? db.query(`SELECT message_id,session_id,name,evidence,read_at FROM message_receipts WHERE room_id=? AND message_id IN (${ids.map(() => "?").join(",")}) ORDER BY read_at,session_id`).all(roomID, ...ids) as Array<Record<string, string | number>> : [];
    const grouped = new Map<string, MessageReceipt["readers"]>(ids.map((id) => [id, []]));
    for (const row of rows) grouped.get(String(row.message_id))?.push({ sessionID: String(row.session_id), name: String(row.name), evidence: String(row.evidence) as ReceiptEvidence, readAt: Number(row.read_at) });
    return ids.map((messageID) => ({ messageID, readers: grouped.get(messageID)! }));
  }).deferred();
}

export async function acknowledgeQueued(file: string, roomID: string, sessionID: string, ts: number): Promise<number | null> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM registry WHERE room_id=? AND session_id=?").get(roomID, sessionID)) return null;
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const capped = Math.min(ts, tail?.created_at ?? 0);
    db.query("UPDATE registry SET last_queued_ts=max(coalesce(last_queued_ts,0),?) WHERE room_id=? AND session_id=?").run(capped, roomID, sessionID);
    return capped;
  });
}

export async function acknowledgeRead(file: string, roomID: string, sessionID: string, ts: number): Promise<number | null> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM registry WHERE room_id=? AND session_id=?").get(roomID, sessionID)) return null;
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const actualTs = Math.min(ts, tail?.created_at ?? 0);
    if (actualTs > 0) db.query("UPDATE registry SET last_read_ts=max(coalesce(last_read_ts,0),?) WHERE room_id=? AND session_id=?").run(actualTs, roomID, sessionID);
    return actualTs;
  });
}

export async function writeMessageReceipts(file: string, roomID: string, sessionID: string, messageIDs: string[], evidence: ReceiptEvidence, identity: ReceiptIdentity, readAt: number, readThroughTs?: number): Promise<ReceiptWriteResult> {
  if (!messageIDs.length || messageIDs.length > 500 || messageIDs.some((id) => typeof id !== "string" || !id || id.length > 128) || !["displayed", "tool", "context"].includes(evidence)) return { status: "messageIDs", acceptedIDs: [] };
  const ids = [...new Set(messageIDs)];
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    const member = db.query("SELECT membership_id,server_url,api_prefix,protocol,name,receiver_owner_id,host FROM registry WHERE room_id=? AND session_id=?").get(roomID, sessionID) as Record<string, string | null> | null;
    if (!member || member.membership_id !== identity.membershipID || !receiptOwnerMatches({
      serverUrl: String(member.server_url), apiPrefix: String(member.api_prefix), name: String(member.name),
      ...(member.protocol ? { protocol: member.protocol as "v1" | "v2" } : {}),
      ...(member.receiver_owner_id ? { receiverOwnerID: member.receiver_owner_id } : {}),
      ...(member.host ? { host: member.host } : {}),
    }, identity.receiverOwnerID)) return { status: "membership", acceptedIDs: [] };
    const found = db.query(`SELECT id FROM messages WHERE room_id=? AND id IN (${ids.map(() => "?").join(",")})`).all(roomID, ...ids) as Array<{ id: string }>;
    if (found.length !== ids.length) return { status: "messageIDs", acceptedIDs: [] };
    let actualReadThrough: number | undefined;
    if (readThroughTs !== undefined) {
      const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
      actualReadThrough = Math.min(readThroughTs, tail?.created_at ?? 0);
      if (actualReadThrough > 0) db.query("UPDATE registry SET last_read_ts=max(coalesce(last_read_ts,0),?) WHERE room_id=? AND session_id=?").run(actualReadThrough, roomID, sessionID);
    }
    const insert = db.query(`INSERT INTO message_receipts VALUES(?,?,?,?,?,?) ON CONFLICT(room_id,message_id,session_id) DO UPDATE SET
      name=excluded.name,evidence=CASE WHEN message_receipts.evidence='displayed' OR excluded.evidence='displayed' THEN 'displayed' WHEN message_receipts.evidence='tool' OR excluded.evidence='tool' THEN 'tool' ELSE 'context' END,
      read_at=max(message_receipts.read_at,excluded.read_at)`);
    for (const messageID of ids) insert.run(roomID, messageID, sessionID, String(member.name), evidence, readAt);
    return { status: "ok", acceptedIDs: ids, ...(actualReadThrough !== undefined ? { readThroughTs: actualReadThrough } : {}) };
  });
}

export async function writePresenceState(file: string, reports: PresenceReport[], ownerID: string | undefined, sequence: number | undefined, now: number): Promise<{ stale: boolean; updatedSessionIDs: string[] }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (ownerID && sequence !== undefined) {
      const current = db.query("SELECT last_sequence FROM presence_sequences WHERE owner_id=?").get(ownerID) as { last_sequence: number } | null;
      if (current && sequence <= current.last_sequence) return { stale: true, updatedSessionIDs: [] };
      db.query("INSERT INTO presence_sequences VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET last_sequence=excluded.last_sequence").run(ownerID, sequence);
    }
    const entries = db.query("SELECT room_id,protocol,receiver_owner_id,server_url,api_prefix,name,host FROM registry WHERE session_id=?");
    const update = db.query("UPDATE registry SET work_state=?,last_seen_at=? WHERE room_id=? AND session_id=?");
    const updatedSessionIDs: string[] = [];
    for (const report of reports) {
      let matched = false;
      for (const entry of entries.all(report.sessionID) as Array<Record<string, string | null>>) {
        const value: RegistryEntry = { serverUrl: String(entry.server_url), apiPrefix: String(entry.api_prefix), name: String(entry.name),
          ...(entry.protocol ? { protocol: entry.protocol as "v1" | "v2" } : {}), ...(entry.receiver_owner_id ? { receiverOwnerID: entry.receiver_owner_id } : {}), ...(entry.host ? { host: entry.host } : {}) };
        if (!presenceOwnerMatches(value, ownerID)) continue;
        update.run(report.state, now, String(entry.room_id), report.sessionID);
        matched = true;
      }
      if (matched) updatedSessionIDs.push(report.sessionID);
    }
    return { stale: false, updatedSessionIDs };
  });
}

function rowMessage(row: Record<string, string | number | null>): Message {
  return { id: String(row.id), roomId: String(row.room_id), senderId: String(row.sender_id), text: String(row.text),
    createdAt: Number(row.created_at), ...(row.sender_session_id !== null ? { senderSessionID: String(row.sender_session_id) } : {}), ...(row.is_question ? { isQuestion: true } : {}), ...(row.answer_to ? { answerToMessageID: String(row.answer_to) } : {}), ...(row.answered_by ? { answeredByMessageID: String(row.answered_by) } : {}) };
}
