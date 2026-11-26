import { presenceOwnerMatches, receiptOwnerMatches } from "./member-state.ts";
import type { MessageReceipt, PresenceReport, ReceiptEvidence, ReceiptIdentity, ReceiptWriteResult, RegistryEntry } from "./store.ts";
import { type StateDatabase } from "./sqlite.ts";
import { openStateDatabase } from "./sqlite-database.ts";
import { immediate } from "./sqlite-transaction.ts";

// --- Pending join requests for approval-protected rooms -------------------
export type JoinRequest = {
  roomID: string;
  sessionID: string;
  participantId: string;
  name: string;
  isAgent: boolean;
  createdAt: number;
  protocol?: "v2";
  receiverOwnerID?: string;
  directory?: string;
  host?: string;
};

type JoinRequestRow = {
  sessionID: string; participantId: string; name: string; protocol: string | null;
  receiverOwnerID: string | null; directory: string | null; host: string | null;
  isAgent: number; createdAt: number;
};

const JOIN_REQUEST_COLUMNS = "session_id AS sessionID,participant_id AS participantId,name,protocol,receiver_owner_id AS receiverOwnerID,directory,host,is_agent AS isAgent,created_at AS createdAt";

function mapJoinRequest(row: JoinRequestRow, roomID: string): JoinRequest {
  return { roomID, sessionID: row.sessionID, participantId: row.participantId, name: row.name,
    isAgent: Boolean(row.isAgent), createdAt: row.createdAt,
    ...(row.protocol === "v2" ? { protocol: "v2" as const } : {}),
    ...(row.receiverOwnerID ? { receiverOwnerID: row.receiverOwnerID } : {}),
    ...(row.directory ? { directory: row.directory } : {}),
    ...(row.host ? { host: row.host } : {}) };
}

export async function readJoinRequest(file: string, roomID: string, sessionID: string): Promise<JoinRequest | undefined> {
  const db = await openStateDatabase(file);
  return findJoinRequest(db, roomID, sessionID);
}

export async function listJoinRequests(file: string, roomID: string, agentOnly = false): Promise<JoinRequest[]> {
  const db = await openStateDatabase(file);
  const rows = db.query(`SELECT ${JOIN_REQUEST_COLUMNS} FROM room_join_requests WHERE room_id=?${agentOnly ? " AND is_agent=1" : ""} ORDER BY created_at,session_id`).all(roomID) as JoinRequestRow[];
  return rows.map((row) => mapJoinRequest(row, roomID));
}

export function findJoinRequest(db: StateDatabase, roomID: string, sessionID: string): JoinRequest | undefined {
  const row = db.query(`SELECT ${JOIN_REQUEST_COLUMNS} FROM room_join_requests WHERE room_id=? AND session_id=?`).get(roomID, sessionID) as JoinRequestRow | null;
  return row ? mapJoinRequest(row, roomID) : undefined;
}

export function removeJoinRequest(db: StateDatabase, roomID: string, sessionID: string): boolean {
  return db.query("DELETE FROM room_join_requests WHERE room_id=? AND session_id=?").run(roomID, sessionID).changes > 0;
}

export function saveJoinRequest(db: StateDatabase, request: JoinRequest): void {
  db.query(`INSERT INTO room_join_requests(room_id,session_id,participant_id,name,protocol,receiver_owner_id,directory,host,is_agent,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id,session_id) DO UPDATE SET participant_id=excluded.participant_id,name=excluded.name,protocol=excluded.protocol,receiver_owner_id=excluded.receiver_owner_id,directory=excluded.directory,host=excluded.host,is_agent=excluded.is_agent,created_at=excluded.created_at`)
    .run(request.roomID, request.sessionID, request.participantId, request.name, request.protocol ?? null, request.receiverOwnerID ?? null, request.directory ?? null, request.host ?? null, request.isAgent ? 1 : 0, request.createdAt);
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
