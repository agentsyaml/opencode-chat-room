import { randomUUID } from "node:crypto";
import type { Message } from "../rooms/room-service.ts";
import { isRoomAdmin } from "./roles.ts";
import { type StateDatabase } from "./sqlite.ts";
import { openStateDatabase } from "./sqlite-database.ts";
import { immediate } from "./sqlite-transaction.ts";

type Page<T> = { items: T[]; hasMore: boolean };

export type HistoryMessage = Message & { seq: number };

export async function readQuestions(file: string, roomID: string): Promise<Message[]> {
  const db = await openStateDatabase(file);
  return (db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND is_question=1 AND answered_by IS NULL AND recalled_at IS NULL ORDER BY seq").all(roomID) as Array<Record<string, string | number | null>>).map(rowMessage);
}

// Open questions as seq references for catch-up; room-wide, excluding recalled.
// Capped so a room with a large question backlog cannot bloat a catch-up page.
export const MAX_OPEN_QUESTION_REFS = 200;
export async function readOpenQuestionRefs(file: string, roomID: string, limit = MAX_OPEN_QUESTION_REFS): Promise<Array<{ id: string; seq: number }>> {
  const db = await openStateDatabase(file);
  const take = Number.isSafeInteger(limit) ? Math.min(MAX_OPEN_QUESTION_REFS, Math.max(1, limit)) : MAX_OPEN_QUESTION_REFS;
  return (db.query("SELECT id,seq FROM messages WHERE room_id=? AND is_question=1 AND answered_by IS NULL AND recalled_at IS NULL ORDER BY seq LIMIT ?").all(roomID, take) as Array<{ id: string; seq: number }>)
    .map((row) => ({ id: String(row.id), seq: Number(row.seq) }));
}

export async function countOpenQuestions(file: string, roomID: string): Promise<number> {
  const db = await openStateDatabase(file);
  const row = db.query("SELECT COUNT(*) AS count FROM messages WHERE room_id=? AND is_question=1 AND answered_by IS NULL AND recalled_at IS NULL").get(roomID) as { count: number };
  return Number(row.count);
}

export async function answerQuestion(file: string, roomID: string, questionID: string, sessionID: string, text: string): Promise<{ status: "ok"; answer: Message } | { status: "missing" | "member" | "question" | "answered" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    const question = db.query("SELECT is_question,answered_by,recalled_at FROM messages WHERE room_id=? AND id=?").get(roomID, questionID) as { is_question: number; answered_by: string | null; recalled_at: number | null } | null;
    if (!question || !question.is_question || question.recalled_at !== null) return { status: "question" };
    if (question.answered_by) return { status: "answered" };
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const answer: Message = { id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name, senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1), answerToMessageID: questionID };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to) VALUES(?,?,?,?,?,?,0,?)").run(answer.id, roomID, answer.senderId, sessionID, text, answer.createdAt, questionID);
    const update = db.query("UPDATE messages SET answered_by=? WHERE room_id=? AND id=? AND is_question=1 AND answered_by IS NULL").run(answer.id, roomID, questionID);
    if (update.changes !== 1) throw new Error("question answer race");
    noteMessageInsert(db, roomID);
    return { status: "ok", answer };
  });
}

export async function appendRoomMessage(file: string, roomID: string, sessionID: string, text: string, isQuestion: boolean, clientMessageID?: string): Promise<{ status: "ok"; message: Message; duplicate?: true } | { status: "missing" | "member" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    if (clientMessageID) {
      const existing = db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND client_msg_id=? AND sender_session_id=?").get(roomID, clientMessageID, sessionID);
      if (existing) return { status: "ok", message: rowMessage(existing as Record<string, string | number | null>), duplicate: true };
    }
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const message: Message = {
      id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name,
      senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1),
      ...(isQuestion ? { isQuestion: true } : {}),
    };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,client_msg_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(message.id, roomID, message.senderId, sessionID, text, message.createdAt, isQuestion ? 1 : 0, clientMessageID ?? null);
    noteMessageInsert(db, roomID);
    return { status: "ok", message };
  });
}

export async function sendReply(file: string, roomID: string, targetID: string, sessionID: string, text: string, clientMessageID?: string): Promise<{ status: "ok"; message: Message; duplicate?: true } | { status: "missing" | "member" | "target" | "recalled" | "question" }> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return { status: "missing" };
    const member = db.query("SELECT g.name,r.kind FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?").get(roomID, sessionID) as { name: string; kind: string } | null;
    if (!member) return { status: "member" };
    if (clientMessageID) {
      const existing = db.query("SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND client_msg_id=? AND sender_session_id=?").get(roomID, clientMessageID, sessionID);
      if (existing) return { status: "ok", message: rowMessage(existing as Record<string, string | number | null>), duplicate: true };
    }
    const target = db.query("SELECT is_question,recalled_at FROM messages WHERE room_id=? AND id=?").get(roomID, targetID) as { is_question: number; recalled_at: number | null } | null;
    if (!target) return { status: "target" };
    if (target.recalled_at !== null) return { status: "recalled" };
    if (target.is_question) return { status: "question" };
    const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(roomID) as { created_at: number } | null;
    const message: Message = { id: randomUUID(), roomId: roomID, senderId: member.kind === "direct" ? sessionID : member.name, senderSessionID: sessionID, text, createdAt: Math.max(Date.now(), (tail?.created_at ?? 0) + 1), answerToMessageID: targetID };
    db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,client_msg_id) VALUES(?,?,?,?,?,?,0,?,?)").run(message.id, roomID, message.senderId, sessionID, text, message.createdAt, targetID, clientMessageID ?? null);
    noteMessageInsert(db, roomID);
    return { status: "ok", message };
  });
}

// Soft recall keeps the row (and its original text) for member reveal while every
// regular read path treats it as gone. Permissions mirror message authorship:
// the sending session, or a human room administrator for any message.
export type RecallMessageResult =
  | { status: "ok"; messageID: string; recalledAt: number; recalledBy: string; alreadyRecalled: boolean }
  | { status: "missing" | "member" | "forbidden" };

export type RevealMessageResult =
  | { status: "ok"; messageID: string; text: string; senderId: string; createdAt: number; recalledAt: number }
  | { status: "missing" | "member" | "hidden" };

type RecallMemberRow = { name: string; protocol: string | null; host: string | null; receiver_owner_id: string | null; membership_id: string | null };

export async function recallMessage(file: string, roomID: string, messageID: string, sessionID: string): Promise<RecallMessageResult> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    const roomRow = db.query("SELECT owner_id,owner_membership_id,admin_names,admin_membership_ids FROM rooms WHERE id=?").get(roomID) as
      { owner_id: string; owner_membership_id: string | null; admin_names: string | null; admin_membership_ids: string | null } | null;
    if (!roomRow) return { status: "missing" };
    const member = db.query("SELECT name,protocol,host,receiver_owner_id,membership_id FROM registry WHERE room_id=? AND session_id=?")
      .get(roomID, sessionID) as RecallMemberRow | null;
    if (!member) return { status: "member" };
    const message = db.query("SELECT sender_id,sender_session_id,recalled_at,recalled_by FROM messages WHERE room_id=? AND id=?")
      .get(roomID, messageID) as { sender_id: string; sender_session_id: string | null; recalled_at: number | null; recalled_by: string | null } | null;
    if (!message) return { status: "missing" };
    if (message.sender_id === "system") return { status: "forbidden" };
    const room = {
      ownerId: roomRow.owner_id,
      ...(roomRow.owner_membership_id ? { ownerMembershipID: roomRow.owner_membership_id } : {}),
      ...(roomRow.admin_names ? { adminIds: JSON.parse(roomRow.admin_names) as string[] } : {}),
      ...(roomRow.admin_membership_ids ? { adminMembershipIDs: JSON.parse(roomRow.admin_membership_ids) as string[] } : {}),
    };
    const entry = { name: member.name, ...(member.protocol ? { protocol: member.protocol } : {}), ...(member.host ? { host: member.host } : {}),
      ...(member.receiver_owner_id ? { receiverOwnerID: member.receiver_owner_id } : {}), ...(member.membership_id ? { membershipID: member.membership_id } : {}) };
    if (message.sender_session_id !== sessionID && !isRoomAdmin(room, entry)) return { status: "forbidden" };
    if (message.recalled_at !== null) {
      return { status: "ok", messageID, recalledAt: Number(message.recalled_at), recalledBy: String(message.recalled_by ?? ""), alreadyRecalled: true };
    }
    const recalledAt = Date.now();
    const recalledBy = member.name;
    db.query("UPDATE messages SET recalled_at=?,recalled_by=? WHERE room_id=? AND id=?").run(recalledAt, recalledBy, roomID, messageID);
    db.query("INSERT INTO room_recall_versions(room_id,version) VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET version=version+1").run(roomID);
    return { status: "ok", messageID, recalledAt, recalledBy, alreadyRecalled: false };
  });
}

export async function revealMessageContent(file: string, roomID: string, messageID: string, sessionID: string): Promise<RevealMessageResult> {
  const db = await openStateDatabase(file);
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM registry WHERE room_id=? AND session_id=?").get(roomID, sessionID)) {
      return db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID) ? { status: "member" as const } : { status: "missing" as const };
    }
    const message = db.query("SELECT text,sender_id,created_at,recalled_at FROM messages WHERE room_id=? AND id=?")
      .get(roomID, messageID) as { text: string; sender_id: string; created_at: number; recalled_at: number | null } | null;
    if (!message) return { status: "missing" as const };
    if (message.recalled_at === null) return { status: "hidden" as const };
    return { status: "ok" as const, messageID, text: message.text, senderId: message.sender_id,
      createdAt: Number(message.created_at), recalledAt: Number(message.recalled_at) };
  }).deferred();
}

function recallVersion(db: StateDatabase, roomID: string): number {
  const row = db.query("SELECT version FROM room_recall_versions WHERE room_id=?").get(roomID) as { version: number } | null;
  return row ? Number(row.version) : 0;
}

export async function isMessageRecalled(file: string, roomID: string, messageID: string): Promise<boolean> {
  const db = await openStateDatabase(file);
  return Boolean(db.query("SELECT 1 FROM messages WHERE room_id=? AND id=? AND recalled_at IS NOT NULL").get(roomID, messageID));
}

// Authoritative recall lookup that does not depend on the 500-message in-memory
// window: used to trim pending notification batches, including old messages.
export async function recalledMessageIDs(file: string, roomID: string, messageIDs: string[]): Promise<string[]> {
  const ids = [...new Set(messageIDs.filter((id) => typeof id === "string" && id))];
  const db = await openStateDatabase(file);
  const found: string[] = [];
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = db.query(`SELECT id FROM messages WHERE room_id=? AND id IN (${chunk.map(() => "?").join(",")}) AND recalled_at IS NOT NULL`)
      .all(roomID, ...chunk) as Array<{ id: string }>;
    found.push(...rows.map((row) => String(row.id)));
  }
  return found;
}

// Per-room retention bound. Trimming runs lazily (every 1024 inserts) so the
// hot insert path stays a single statement.
export const MAX_RETAINED_MESSAGES = 1_000_000;
const retentionCounters = new Map<string, number>();

export function enforceRetention(db: StateDatabase, roomID: string, limit = MAX_RETAINED_MESSAGES): void {
  db.query("DELETE FROM messages WHERE room_id=? AND seq <= (SELECT seq FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)").run(roomID, roomID, limit);
}

function noteMessageInsert(db: StateDatabase, roomID: string): void {
  const count = (retentionCounters.get(roomID) ?? 0) + 1;
  if (count < 1024) { retentionCounters.set(roomID, count); return; }
  retentionCounters.set(roomID, 0);
  enforceRetention(db, roomID);
}

function questionExcerpt(text: string): string {
  const chars = Array.from(text);
  return chars.length <= 200 ? text : `${chars.slice(0, 100).join("")}…${chars.slice(-100).join("")}`;
}

export async function readQuestionExcerpt(file: string, roomID: string, questionID: string): Promise<string | undefined> {
  const db = await openStateDatabase(file);
  const row = db.query("SELECT text FROM messages WHERE room_id=? AND id=? AND is_question=1 AND recalled_at IS NULL").get(roomID, questionID) as { text: string } | null;
  return row ? questionExcerpt(row.text) : undefined;
}

export async function readUnreadPage(file: string, roomID: string, afterTs: number, limit = 100, sessionID?: string, senderName?: string, newest = false): Promise<Page<Message>> {
  const db = await openStateDatabase(file);
  const take = Math.min(200, Math.max(1, limit));
  const rows = db.query(`SELECT id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by FROM messages WHERE room_id=? AND created_at>? AND recalled_at IS NULL AND
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
    FROM messages m JOIN registry g ON g.room_id=m.room_id JOIN rooms r ON r.id=m.room_id LEFT JOIN messages q ON q.room_id=m.room_id AND q.id=m.answer_to AND q.is_question=1 AND q.recalled_at IS NULL
    WHERE g.session_id=? AND (? IS NULL OR m.room_id=?) AND m.recalled_at IS NULL AND
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
    const versionRows = db.query("SELECT coalesce(v.version,0) AS version FROM registry g LEFT JOIN room_recall_versions v ON v.room_id=g.room_id WHERE g.session_id=? AND (? IS NULL OR g.room_id=?)")
      .all(sessionID, roomFilter, roomFilter) as Array<{ version: number }>;
    const version = roomFilter ? Number(versionRows[0]?.version ?? 0) : versionRows.reduce((max, row) => Math.max(max, Number(row.version)), 0);
    return { member: members.length > 0, items, queuedTs, hasMore, recallVersion: version };
  }).deferred();
}

const HISTORY_COLUMNS = "seq,id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to,answered_by,recalled_at,recalled_by";

function historyRowMessage(row: Record<string, string | number | null>): HistoryMessage {
  const message = rowMessage(row);
  const recalledAt = row.recalled_at === null || row.recalled_at === undefined ? undefined : Number(row.recalled_at);
  // Recalled rows keep their original text in storage for member reveal; history
  // surfaces only a tombstone.
  return { ...message, ...(recalledAt !== undefined ? { text: "", recalledAt, ...(row.recalled_by ? { recalledBy: String(row.recalled_by) } : {}) } : {}), seq: Number(row.seq) };
}

// afterSeq switches the page to ascending order, exclusive cursor semantics,
// for catch-up from a persisted seq. beforeSeq is ignored in that branch.
export async function readHistoryPage(file: string, roomID: string, beforeSeq?: number, limit = 100, excludeSessionID?: string, excludeName = "", afterSeq?: number): Promise<{ messages: HistoryMessage[]; nextBeforeSeq: number | null; hasMore: boolean; recallVersion: number }> {
  const db = await openStateDatabase(file);
  return db.transaction(() => {
  const take = Math.min(200, Math.max(1, limit));
  const exclude = `(? IS NULL OR (sender_session_id IS NOT NULL AND sender_session_id!=?) OR (sender_session_id IS NULL AND sender_id!=?))`;
  if (afterSeq !== undefined) {
    const rows = db.query(`SELECT ${HISTORY_COLUMNS} FROM messages WHERE room_id=? AND seq>? AND ${exclude} ORDER BY seq ASC LIMIT ?`)
      .all(roomID, afterSeq, excludeSessionID ?? null, excludeSessionID ?? null, excludeName, take + 1) as Array<Record<string, string | number | null>>;
    const hasMore = rows.length > take;
    return { messages: rows.slice(0, take).map(historyRowMessage), nextBeforeSeq: null, hasMore, recallVersion: recallVersion(db, roomID) };
  }
  const rows = db.query(`SELECT ${HISTORY_COLUMNS} FROM messages WHERE room_id=? ${beforeSeq === undefined ? "" : "AND seq<? "}AND
    ${exclude} ORDER BY seq DESC LIMIT ?`).all(...(beforeSeq === undefined ? [roomID] : [roomID, beforeSeq]),
    excludeSessionID ?? null, excludeSessionID ?? null, excludeName, take + 1) as Array<Record<string, string | number | null>>;
  const hasMore = rows.length > take;
  const messages = rows.slice(0, take).reverse().map(historyRowMessage);
  return { messages, nextBeforeSeq: hasMore ? messages[0]?.seq ?? null : null, hasMore, recallVersion: recallVersion(db, roomID) };
  }).deferred();
}

export async function readMessage(file: string, roomID: string, messageID: string): Promise<HistoryMessage | undefined> {
  const db = await openStateDatabase(file);
  const row = db.query(`SELECT ${HISTORY_COLUMNS} FROM messages WHERE room_id=? AND id=?`).get(roomID, messageID) as Record<string, string | number | null> | null;
  return row ? historyRowMessage(row) : undefined;
}

function rowMessage(row: Record<string, string | number | null>): Message {
  return { id: String(row.id), roomId: String(row.room_id), senderId: String(row.sender_id), text: String(row.text),
    createdAt: Number(row.created_at), ...(row.sender_session_id !== null ? { senderSessionID: String(row.sender_session_id) } : {}), ...(row.is_question ? { isQuestion: true } : {}), ...(row.answer_to ? { answerToMessageID: String(row.answer_to) } : {}), ...(row.answered_by ? { answeredByMessageID: String(row.answered_by) } : {}) };
}
