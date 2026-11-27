import { randomUUID } from "node:crypto";
import type { Message, Participant, Room } from "../rooms/room-service.ts";
import type { Registry, RegistryEntry } from "./store.ts";
import { type SQLQueryBindings, type StateDatabase } from "./sqlite.ts";

export type State = { rooms: Room[]; registry: Registry };

const ROOM_COLUMNS = "name,owner_id,created_at,kind,direct_sessions,direct_pair,description,admin_names,admin_membership_ids,owner_membership_id,successor_name,successor_membership_id,join_policy";
const ROOM_FIELDS = ROOM_COLUMNS.split(",");
const ROOM_INSERT = `INSERT INTO rooms(id,${ROOM_COLUMNS}) VALUES(?,${ROOM_FIELDS.map(() => "?").join(",")})`;
const MESSAGE_COLUMNS = "id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by,recalled_at,recalled_by";
const MESSAGE_FIELDS = MESSAGE_COLUMNS.split(",");
const MESSAGE_INSERT = `INSERT INTO messages(${MESSAGE_COLUMNS}) VALUES(${MESSAGE_FIELDS.map(() => "?").join(",")})`;
const MESSAGE_UPSERT = `${MESSAGE_INSERT} ON CONFLICT(id) DO UPDATE SET is_question=excluded.is_question,answer_to=excluded.answer_to,answered_by=excluded.answered_by,recalled_at=excluded.recalled_at,recalled_by=excluded.recalled_by`;
const MESSAGE_MUTABLE_FIELDS = ["is_question", "answer_to", "answered_by", "recalled_at", "recalled_by"];
const REGISTRY_COLUMNS = "server_url,api_prefix,protocol,name,last_read_ts,last_queued_ts,directory,host,receiver_owner_id,membership_id,work_state,last_seen_at";
const REGISTRY_FIELDS = REGISTRY_COLUMNS.split(",");
const REGISTRY_INSERT = `INSERT INTO registry(room_id,session_id,${REGISTRY_COLUMNS}) VALUES(?,?,${REGISTRY_FIELDS.map(() => "?").join(",")})`;

function roomColumns(room: Room): string | null {
  return room.adminIds?.length ? JSON.stringify([...new Set(room.adminIds)]) : null;
}
const adminBindings = (room: Room) => room.adminMembershipIDs?.length ? JSON.stringify([...new Set(room.adminMembershipIDs)]) : null;

function roomValues(room: Room): SQLQueryBindings[] {
  return [room.name, room.ownerId, room.createdAt, room.kind ?? "group",
    room.directSessionIDs ? JSON.stringify(room.directSessionIDs) : null, room.directPair ?? null,
    room.description ?? null, roomColumns(room), adminBindings(room),
    room.ownerMembershipID ?? null, room.successorId ?? null, room.successorMembershipID ?? null,
    room.joinPolicy ?? null];
}

function messageValues(message: Message): SQLQueryBindings[] {
  return [message.id, message.roomId, message.senderId, message.senderSessionID ?? null, message.text,
    message.createdAt, message.isQuestion ? 1 : 0, message.answerToMessageID ?? null,
    message.answeredByMessageID ?? null, message.recalledAt ?? null, message.recalledBy ?? null];
}

function mutableMessageValues(message: Message): SQLQueryBindings[] {
  return [message.isQuestion ? 1 : 0, message.answerToMessageID ?? null, message.answeredByMessageID ?? null,
    message.recalledAt ?? null, message.recalledBy ?? null];
}

function registryValues(entry: RegistryEntry): SQLQueryBindings[] {
  return [entry.serverUrl, entry.apiPrefix, entry.protocol ?? null, entry.name,
    entry.lastReadTs ?? null, entry.lastQueuedTs ?? null, entry.directory ?? null, entry.host ?? null,
    entry.receiverOwnerID ?? null, entry.membershipID ?? null, entry.workState ?? null, entry.lastSeenAt ?? null];
}

export function insertRoom(db: StateDatabase, room: Room): void {
  db.query(ROOM_INSERT).run(room.id, ...roomValues(room));
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
  const message = db.query(MESSAGE_INSERT);
  for (const m of room.messages) message.run(...messageValues(m));
}

export function replaceRegistry(db: StateDatabase, registry: Registry): void {
  db.exec("DELETE FROM registry");
  const insert = db.query(REGISTRY_INSERT);
  for (const [roomID, members] of Object.entries(registry)) for (const [sessionID, r] of Object.entries(members)) {
    r.membershipID ||= randomUUID();
    insert.run(roomID, sessionID, ...registryValues(r));
  }
}

// Apply only the rows that differ between the snapshot read before a write
// callback and the state the callback produced. Untouched rows are never
// deleted or rewritten, so another process's committed changes survive.
export function persistStateDiff(db: StateDatabase, before: State, after: State): void {
  const beforeRooms = new Map(before.rooms.map((room) => [room.id, room]));
  const afterRooms = new Map(after.rooms.map((room) => [room.id, room]));
  const deleteRoom = db.query("DELETE FROM rooms WHERE id=?");
  for (const room of before.rooms) if (!afterRooms.has(room.id)) deleteRoom.run(room.id);

  const insertRoomRow = db.query(ROOM_INSERT);
  const insertParticipant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  const updateParticipant = db.query("UPDATE participants SET name=?,joined_at=? WHERE room_id=? AND id=?");
  const deleteParticipant = db.query("DELETE FROM participants WHERE room_id=? AND id=?");
  const message = db.query(MESSAGE_UPSERT);

  for (const room of after.rooms) {
    const previous = beforeRooms.get(room.id);
    if (!previous) {
      insertRoomRow.run(room.id, ...roomValues(room));
      for (const p of room.participants.values()) insertParticipant.run(room.id, p.id, p.name, p.joinedAt);
      for (const m of room.messages) message.run(...messageValues(m));
      continue;
    }
    updateChanged(db, "rooms", ROOM_FIELDS, roomValues(previous), roomValues(room), "id=?", [room.id]);
    for (const [id, participant] of room.participants) {
      const prior = previous.participants.get(id);
      if (!prior) insertParticipant.run(room.id, id, participant.name, participant.joinedAt);
      else if (prior.name !== participant.name || prior.joinedAt !== participant.joinedAt) {
        updateParticipant.run(participant.name, participant.joinedAt, room.id, id);
      }
    }
    for (const id of previous.participants.keys()) if (!room.participants.has(id)) deleteParticipant.run(room.id, id);
    const previousMessages = new Map(previous.messages.map((item) => [item.id, item]));
    for (const item of room.messages) {
      const prior = previousMessages.get(item.id);
      if (!prior) message.run(...messageValues(item));
      else updateChanged(db, "messages", MESSAGE_MUTABLE_FIELDS, mutableMessageValues(prior), mutableMessageValues(item), "id=?", [item.id]);
    }
  }

  for (const members of Object.values(after.registry)) for (const entry of Object.values(members)) entry.membershipID ||= randomUUID();
  const insertRegistry = db.query(REGISTRY_INSERT);
  for (const [roomID, members] of Object.entries(after.registry)) {
    for (const [sessionID, entry] of Object.entries(members)) {
      const previous = before.registry[roomID]?.[sessionID];
      if (!previous) insertRegistry.run(roomID, sessionID, ...registryValues(entry));
      else updateChanged(db, "registry", REGISTRY_FIELDS, registryValues(previous), registryValues(entry), "room_id=? AND session_id=?", [roomID, sessionID]);
    }
  }
  const deleteRegistry = db.query("DELETE FROM registry WHERE room_id=? AND session_id=?");
  for (const [roomID, members] of Object.entries(before.registry)) {
    for (const sessionID of Object.keys(members)) {
      if (!after.registry[roomID]?.[sessionID]) deleteRegistry.run(roomID, sessionID);
    }
  }
}

function updateChanged(db: StateDatabase, table: string, fields: string[], before: SQLQueryBindings[], after: SQLQueryBindings[], where: string, key: SQLQueryBindings[]): void {
  const changed: Array<{ field: string; value: SQLQueryBindings }> = [];
  for (let index = 0; index < fields.length; index++) {
    if (before[index] === after[index]) continue;
    changed.push({ field: fields[index]!, value: after[index] });
  }
  if (!changed.length) return;
  db.query(`UPDATE ${table} SET ${changed.map(({ field }) => `${field}=?`).join(",")} WHERE ${where}`)
    .run(...changed.map(({ value }) => value), ...key);
}

function cloneRoom(room: Room): Room {
  return {
    ...room,
    ...(room.adminIds ? { adminIds: [...room.adminIds] } : {}),
    ...(room.adminMembershipIDs ? { adminMembershipIDs: [...room.adminMembershipIDs] } : {}),
    ...(room.directSessionIDs ? { directSessionIDs: [...room.directSessionIDs] } : {}),
    participants: new Map([...room.participants].map(([id, p]) => [id, { ...p }])),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

// The write path hydrates this copy so the pre-callback snapshot stays
// untouched for diffing. Registry entries are copied too: callbacks mutate them
// in place.
export function cloneState(state: State): State {
  const registry: Registry = Object.create(null);
  for (const [roomID, members] of Object.entries(state.registry)) {
    registry[roomID] = Object.create(null);
    for (const [sessionID, entry] of Object.entries(members)) registry[roomID]![sessionID] = { ...entry };
  }
  return { rooms: state.rooms.map(cloneRoom), registry };
}

export type RoomSummary = { id: string; name: string; latestMsgTs: number };

// Latest message timestamp per room for the wake summary. Recalled messages keep
// their created_at, so they still count as the room tail. Rooms without messages
// fall back to 0, matching the hydrated last-message read this replaces.
export function readRoomSummaries(db: StateDatabase): RoomSummary[] {
  const rows = db.query("SELECT r.id,r.name,COALESCE(MAX(m.created_at),0) AS latestMsgTs FROM rooms r LEFT JOIN messages m ON m.room_id=r.id GROUP BY r.id,r.name,r.created_at ORDER BY r.created_at,r.id").all() as Array<{ id: string; name: string; latestMsgTs: number | string }>;
  return rows.map((row) => ({ id: String(row.id), name: String(row.name), latestMsgTs: Number(row.latestMsgTs) }));
}

export function readState(db: StateDatabase): State {
  const roomRows = db.query("SELECT id,name,owner_id,created_at,kind,direct_sessions,direct_pair,description,admin_names,admin_membership_ids,owner_membership_id,successor_name,successor_membership_id,join_policy FROM rooms ORDER BY created_at,id").all() as Array<Record<string, string | number | null>>;
  const rooms = roomRows.map((r): Room => {
    const participants = new Map<string, Participant>();
    for (const p of db.query("SELECT id,name,joined_at FROM participants WHERE room_id=?").all(String(r.id)) as Array<Record<string, string | number>>) {
      participants.set(String(p.id), { id: String(p.id), name: String(p.name), joinedAt: Number(p.joined_at) });
    }
    const messages = db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by,recalled_at,recalled_by FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 500").all(String(r.id)) as Array<Record<string, string | number | null>>;
    return { id: String(r.id), name: String(r.name), ownerId: String(r.owner_id), createdAt: Number(r.created_at), kind: r.kind === "direct" ? "direct" : "group", ...(r.description ? { description: String(r.description) } : {}), ...(r.admin_names ? { adminIds: JSON.parse(String(r.admin_names)) as string[] } : {}), ...(r.admin_membership_ids ? { adminMembershipIDs: JSON.parse(String(r.admin_membership_ids)) as string[] } : {}), ...(r.owner_membership_id ? { ownerMembershipID: String(r.owner_membership_id) } : {}), ...(r.successor_name ? { successorId: String(r.successor_name) } : {}), ...(r.successor_membership_id ? { successorMembershipID: String(r.successor_membership_id) } : {}), ...(r.join_policy ? { joinPolicy: String(r.join_policy) as Room["joinPolicy"] } : {}), ...(r.direct_sessions ? { directSessionIDs: JSON.parse(String(r.direct_sessions)) as string[] } : {}), ...(r.direct_pair ? { directPair: String(r.direct_pair) } : {}), participants,
      messages: messages.reverse().map((m) => ({ id: String(m.id), roomId: String(m.room_id), senderId: String(m.sender_id),
         text: String(m.text), createdAt: Number(m.created_at), ...(m.sender_session_id ? { senderSessionID: String(m.sender_session_id) } : {}), ...(m.is_question ? { isQuestion: true } : {}), ...(m.answer_to ? { answerToMessageID: String(m.answer_to) } : {}), ...(m.answered_by ? { answeredByMessageID: String(m.answered_by) } : {}), ...(m.recalled_at !== null ? { recalledAt: Number(m.recalled_at), ...(m.recalled_by ? { recalledBy: String(m.recalled_by) } : {}) } : {}) })) };
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
