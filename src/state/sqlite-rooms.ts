import { randomUUID } from "node:crypto";
import type { Message, Participant, Room } from "../rooms/room-service.ts";
import type { Registry, RegistryEntry } from "./store.ts";
import { type StateDatabase } from "./sqlite.ts";

export type State = { rooms: Room[]; registry: Registry };

function roomColumns(room: Room): string | null {
  return room.adminIds?.length ? JSON.stringify([...new Set(room.adminIds)]) : null;
}
const adminBindings = (room: Room) => room.adminMembershipIDs?.length ? JSON.stringify([...new Set(room.adminMembershipIDs)]) : null;
const roomBindings = (room: Room) => [room.ownerMembershipID ?? null, room.successorId ?? null, room.successorMembershipID ?? null];

export function insertRoom(db: StateDatabase, room: Room): void {
  db.query("INSERT INTO rooms(id,name,owner_id,created_at,kind,direct_sessions,direct_pair,description,admin_names,admin_membership_ids,owner_membership_id,successor_name,successor_membership_id,join_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(room.id, room.name, room.ownerId, room.createdAt, room.kind ?? "group", room.directSessionIDs ? JSON.stringify(room.directSessionIDs) : null, room.directPair ?? null, room.description ?? null, roomColumns(room), adminBindings(room), ...roomBindings(room), room.joinPolicy ?? null);
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
  const message = db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by,recalled_at,recalled_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt, m.isQuestion ? 1 : 0, m.answerToMessageID ?? null, m.answeredByMessageID ?? null, m.recalledAt ?? null, m.recalledBy ?? null);
}

export function replaceRegistry(db: StateDatabase, registry: Registry): void {
  db.exec("DELETE FROM registry");
  const insert = db.query("INSERT INTO registry(room_id,session_id,server_url,api_prefix,protocol,name,last_read_ts,last_queued_ts,directory,host,receiver_owner_id,membership_id,work_state,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const [roomID, members] of Object.entries(registry)) for (const [sessionID, r] of Object.entries(members)) {
    r.membershipID ||= randomUUID();
    insert.run(roomID, sessionID, r.serverUrl, r.apiPrefix, r.protocol ?? null, r.name,
      r.lastReadTs ?? null, r.lastQueuedTs ?? null, r.directory ?? null, r.host ?? null, r.receiverOwnerID ?? null,
      r.membershipID, r.workState ?? null, r.lastSeenAt ?? null);
  }
}

export function persistState(db: StateDatabase, rooms: Room[], registry: Registry): void {
  const roomRow = db.query("INSERT INTO rooms(id,name,owner_id,created_at,kind,direct_sessions,direct_pair,description,admin_names,admin_membership_ids,owner_membership_id,successor_name,successor_membership_id,join_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id,created_at=excluded.created_at,kind=excluded.kind,direct_sessions=excluded.direct_sessions,direct_pair=excluded.direct_pair,description=excluded.description,admin_names=excluded.admin_names,admin_membership_ids=excluded.admin_membership_ids,owner_membership_id=excluded.owner_membership_id,successor_name=excluded.successor_name,successor_membership_id=excluded.successor_membership_id,join_policy=excluded.join_policy");
  const participant = db.query("INSERT INTO participants VALUES(?,?,?,?)");
  const message = db.query("INSERT OR IGNORE INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by,recalled_at,recalled_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const removeParticipants = db.query("DELETE FROM participants WHERE room_id=?");
  const keep = new Set(rooms.map((room) => room.id));
  const existing = db.query("SELECT id FROM rooms").all() as Array<{ id: string }>;
  const deleteRoom = db.query("DELETE FROM rooms WHERE id=?");
  for (const row of existing) if (!keep.has(row.id)) deleteRoom.run(row.id);
  for (const room of rooms) {
    roomRow.run(room.id, room.name, room.ownerId, room.createdAt, room.kind ?? "group", room.directSessionIDs ? JSON.stringify(room.directSessionIDs) : null, room.directPair ?? null, room.description ?? null, roomColumns(room), adminBindings(room), ...roomBindings(room), room.joinPolicy ?? null);
    removeParticipants.run(room.id);
    for (const p of room.participants.values()) participant.run(room.id, p.id, p.name, p.joinedAt);
    for (const m of room.messages) message.run(m.id, room.id, m.senderId, m.senderSessionID ?? null, m.text, m.createdAt, m.isQuestion ? 1 : 0, m.answerToMessageID ?? null, m.answeredByMessageID ?? null, m.recalledAt ?? null, m.recalledBy ?? null);
  }
  replaceRegistry(db, registry);
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
