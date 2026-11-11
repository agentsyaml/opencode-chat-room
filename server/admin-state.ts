import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { databasePath } from "../src/store";
import { initializeAdminSchema, withStateTransaction } from "../src/sqlite-state";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const row = <T>(db: Database, sql: string, ...args: SQLQueryBindings[]) => db.query(sql).get(...args) as T | null;
const all = <T>(db: Database, sql: string, ...args: SQLQueryBindings[]) => db.query(sql).all(...args) as T[];
const run = (db: Database, sql: string, ...args: SQLQueryBindings[]) => db.query(sql).run(...args);
export type AdminRoom = { roomId: string; targetRoomId: string; sessionID: string; receiverOwnerID: string; membershipID: string; generation: number; enrolled: boolean; createdAt: number };
export type Binding = { room_id: string; target_room_id: string; session_id: string; receiver_owner_id: string; membership_id: string; generation: number; enrollment_hash: string; enrollment_expires: number; capability_hash: string | null; created_at: number };
export const digest = hash;
export const newSecret = secret;
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(hash(a), "hex"), right = Buffer.from(hash(b), "hex");
  return timingSafeEqual(left, right);
}
export function matchesHash(value: string, stored: string): boolean {
  const left = Buffer.from(hash(value), "hex"), right = Buffer.from(stored, "hex");
  return right.length === 32 && timingSafeEqual(left, right);
}
export async function ensureAdminSchema() {
  const file = databasePath();
  const migrated = await withStateTransaction(file, db => {
    db.exec("CREATE TABLE IF NOT EXISTS server_admin_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)");
    return !!db.query("SELECT 1 FROM server_admin_migrations WHERE version=1").get();
  });
  if (migrated) return;
  await initializeAdminSchema(file);
  await withStateTransaction(file, db => {
    if (db.query("SELECT 1 FROM server_admin_migrations WHERE version=1").get()) return;
    // Legacy route producers used only task and supervision delivery kinds.
    db.exec("DELETE FROM admin_deliveries WHERE kind IN ('task','supervision'); DELETE FROM admin_tasks; DELETE FROM admin_plans;");
    db.query("INSERT INTO server_admin_migrations(version,applied_at) VALUES(1,?)").run(Date.now());
  });
}
export async function tx<T>(fn: (db: Database) => T) { await ensureAdminSchema(); return withStateTransaction(databasePath(), fn); }
export function publicRoom(b: Binding): AdminRoom { return { roomId: b.room_id, targetRoomId: b.target_room_id, sessionID: b.session_id, receiverOwnerID: b.receiver_owner_id, membershipID: b.membership_id, generation: b.generation, enrolled: Boolean(b.capability_hash), createdAt: b.created_at }; }
export function binding(db: Database, roomID: string) { return row<Binding>(db, "SELECT * FROM admin_rooms WHERE room_id=?", roomID); }
export function currentMember(db: Database, b: Binding) {
  return row(db, `SELECT g.membership_id,g.receiver_owner_id,g.protocol,g.host,p.id AS participant_id
    FROM registry g JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN (SELECT kind FROM rooms WHERE id=g.room_id)='direct' THEN g.session_id ELSE g.name END
    WHERE g.room_id=? AND g.session_id=?`, b.target_room_id, b.session_id) as { membership_id: string; receiver_owner_id: string | null; protocol: string | null; host: string | null; participant_id: string } | null;
}
export function validCurrent(db: Database, b: Binding): boolean {
  const m = currentMember(db, b);
  return !!m && m.membership_id === b.membership_id && (m.receiver_owner_id ?? "") === b.receiver_owner_id && (m.protocol === "v1" || m.protocol === "v2" || Boolean(m.host));
}
export function enroll(db: Database, roomID: string, targetRoomID: string, sessionID: string, ownerID: string, membershipID: string, generation: number, createdAt = Date.now()) {
  if (!row(db, "SELECT 1 FROM rooms WHERE id=? AND kind='group'", roomID) || !row(db, "SELECT 1 FROM rooms WHERE id=?", targetRoomID)) return undefined;
  const nextKey = secret(), expiresAt = Date.now() + 600_000;
  run(db, `INSERT INTO admin_rooms(room_id,target_room_id,session_id,receiver_owner_id,membership_id,generation,enrollment_hash,enrollment_expires,capability_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(room_id) DO UPDATE SET target_room_id=excluded.target_room_id,session_id=excluded.session_id,receiver_owner_id=excluded.receiver_owner_id,membership_id=excluded.membership_id,generation=excluded.generation,enrollment_hash=excluded.enrollment_hash,enrollment_expires=excluded.enrollment_expires,capability_hash=NULL`,
    roomID, targetRoomID, sessionID, ownerID, membershipID, generation, hash(nextKey), expiresAt, createdAt);
  return { enrollmentKey: nextKey, expiresAt };
}
export function isAgentMember(db: Database, roomID: string, sessionID: string, ownerID: string, membershipID: string) {
  const entry = row<{ membership_id: string; receiver_owner_id: string | null; protocol: string | null; host: string | null }>(db,
    `SELECT g.membership_id,g.receiver_owner_id,g.protocol,g.host FROM registry g JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN (SELECT kind FROM rooms WHERE id=g.room_id)='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?`, roomID, sessionID);
  return !!entry && entry.membership_id === membershipID && (entry.receiver_owner_id ?? "") === ownerID && (entry.protocol === "v1" || entry.protocol === "v2" || Boolean(entry.host));
}
export type Recipient = { roomID: string; sessionID: string; ownerID: string; membershipID: string };
export function queue(db: Database, b: Binding, kind: string, text: string, taskID: string | null = null, taskToken: string | null = null, recipient: Recipient = { roomID: b.target_room_id, sessionID: b.session_id, ownerID: b.receiver_owner_id, membershipID: b.membership_id }) {
  const id = randomUUID();
  run(db, `INSERT INTO admin_deliveries(id,admin_room_id,generation,recipient_room_id,session_id,owner_id,membership_id,kind,text,task_id,task_token,admission_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(admin_room_id,kind,task_id) DO UPDATE SET text=excluded.text,task_token=excluded.task_token,generation=excluded.generation,recipient_room_id=excluded.recipient_room_id,session_id=excluded.session_id,owner_id=excluded.owner_id,membership_id=excluded.membership_id,created_at=excluded.created_at,acknowledged=0`,
    id,b.room_id,b.generation,recipient.roomID,recipient.sessionID,recipient.ownerID,recipient.membershipID,kind,text,taskID,taskToken,`msg_${id}`,Date.now());
}
export function one<T>(db: Database, sql: string, ...args: SQLQueryBindings[]) { return row<T>(db, sql, ...args); }
export function many<T>(db: Database, sql: string, ...args: SQLQueryBindings[]) { return all<T>(db, sql, ...args); }
export { run as exec, randomUUID };
