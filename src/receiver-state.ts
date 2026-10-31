import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const databases = new Map<string, Database>();
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function initialize(db: Database): void {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS delivery_leases(session_id TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pending_admissions(session_id TEXT NOT NULL,room_id TEXT NOT NULL,admission TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,room_id)); CREATE INDEX IF NOT EXISTS pending_admissions_expiry ON pending_admissions(expires_at); CREATE TABLE IF NOT EXISTS background_attempted_through(session_id TEXT NOT NULL,room_id TEXT NOT NULL,service TEXT NOT NULL,through_ts INTEGER NOT NULL,PRIMARY KEY(session_id,room_id,service)); CREATE TABLE IF NOT EXISTS watcher_claims(identity TEXT PRIMARY KEY,instance_id TEXT NOT NULL,pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS presence_sequences(owner_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS presence_throttle(owner_id TEXT NOT NULL,target TEXT NOT NULL,last_report_at INTEGER NOT NULL,PRIMARY KEY(owner_id,target)); CREATE TABLE IF NOT EXISTS receipt_candidates(candidate_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,admission_id TEXT NOT NULL,destination TEXT NOT NULL,owner_id TEXT NOT NULL,candidate TEXT NOT NULL,ready INTEGER NOT NULL,expires_at INTEGER NOT NULL);");
      migrateLegacyBackgroundAttempts(db);
      db.exec("COMMIT");
      return;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* No transaction remained open. */ }
      const err = error as { code?: string };
      if (!/SQLITE_(BUSY|LOCKED)/.test(err.code ?? "") || attempt >= 7) throw error;
      pause(Math.min(20 * 2 ** attempt, 250));
    }
  }
}

function migrateLegacyBackgroundAttempts(db: Database): void {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));
  if (names.has("background_attempts")) {
    const rows = db.query("SELECT session_id,room_id,service,admission_id FROM background_attempts").all() as Array<{ session_id: string; room_id: string; service: string; admission_id: string }>;
    for (const row of rows) {
      const pending = db.query("SELECT admission FROM pending_admissions WHERE session_id=? AND room_id=?").get(row.session_id, row.room_id) as { admission: string } | null;
      let through = Number.MAX_SAFE_INTEGER;
      try {
        const value = pending ? JSON.parse(pending.admission) as { id?: string; maxTs?: number } : undefined;
        if (value?.id === row.admission_id && Number.isSafeInteger(value.maxTs) && value.maxTs! > 0) through = value.maxTs!;
      } catch { /* Ambiguous old claims stay fail-closed. */ }
      saveBackgroundWatermark(db, row.session_id, row.room_id, row.service, through);
    }
    db.exec("DROP TABLE background_attempts");
  }
  if (names.has("background_retries")) {
    const columns = db.query("PRAGMA table_info(background_retries)").all() as Array<{ name: string }>;
    const hasTrigger = columns.some((column) => column.name === "trigger_ts");
    const query = hasTrigger
      ? "SELECT session_id,room_id,service,trigger_ts AS trigger FROM background_retries"
      : "SELECT session_id,room_id,service,0 AS trigger FROM background_retries";
    const rows = db.query(query).all() as Array<{ session_id: string; room_id: string; service: string; trigger: number }>;
    for (const row of rows) saveBackgroundWatermark(db, row.session_id, row.room_id, row.service,
      Number.isSafeInteger(row.trigger) && row.trigger > 0 ? row.trigger : Number.MAX_SAFE_INTEGER);
    db.exec("DROP TABLE background_retries");
  }
}

function saveBackgroundWatermark(db: Database, sessionID: string, roomID: string, service: string, throughTs: number): void {
  db.query("INSERT INTO background_attempted_through VALUES(?,?,?,?) ON CONFLICT(session_id,room_id,service) DO UPDATE SET through_ts=max(through_ts,excluded.through_ts)")
    .run(sessionID, roomID, service, throughTs);
}

export function receiverStateDirectory(): string {
  const configured = process.env.XDG_STATE_HOME;
  const base = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opencode", "chat-room");
}
function database(): Database {
  const file = path.join(receiverStateDirectory(), "receiver.sqlite");
  let db = databases.get(file);
  if (db) return db;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  db = new Database(file, { create: true });
  chmodSync(file, 0o600);
  try { db.exec("PRAGMA busy_timeout=100"); initialize(db); }
  catch (error) { db.close(); throw error; }
  databases.set(file, db);
  return db;
}
function immediate<T>(fn: (db: Database) => T): T {
  const db = database();
  for (let attempt = 0; ; attempt++) {
    try { return db.transaction(() => fn(db)).immediate(); }
    catch (error) {
      const err = error as { code?: string };
      if (!/SQLITE_(BUSY|LOCKED)/.test(err.code ?? "") || attempt >= 7) throw error;
      pause(Math.min(20 * 2 ** attempt, 250));
    }
  }
}

export function readPendingAdmission<T>(sessionID: string, roomID: string, now: number): T | undefined {
  // Keep notification reads lock-free; saves reclaim expired rows.
  const row = database().query("SELECT admission FROM pending_admissions WHERE session_id=? AND room_id=? AND expires_at>?")
    .get(sessionID, roomID, now) as { admission: string } | null;
  return row ? JSON.parse(row.admission) as T : undefined;
}
export function savePendingAdmission(sessionID: string, roomID: string, value: unknown, expiresAt: number, now: number): void {
  immediate((db) => {
    db.query("DELETE FROM pending_admissions WHERE expires_at<=?").run(now);
    db.query("INSERT INTO pending_admissions VALUES(?,?,?,?,?) ON CONFLICT(session_id,room_id) DO UPDATE SET admission=excluded.admission,expires_at=excluded.expires_at,updated_at=excluded.updated_at")
      .run(sessionID, roomID, JSON.stringify(value), expiresAt, now);
    db.query("DELETE FROM pending_admissions WHERE rowid IN (SELECT rowid FROM pending_admissions ORDER BY updated_at DESC LIMIT -1 OFFSET 1024)").run();
  });
}
export function deletePendingAdmission(sessionID: string, roomID: string): void {
  immediate((db) => db.query("DELETE FROM pending_admissions WHERE session_id=? AND room_id=?").run(sessionID, roomID));
}

export function saveReceiptCandidate(id: string, value: unknown, expiresAt: number): void {
  immediate((db) => {
    db.query("DELETE FROM receipt_candidates WHERE ready=0 AND expires_at<=?").run(Date.now());
    const item = value as { sessionID: string; admissionID: string; destination: string; receiverOwnerID?: string };
    db.query("INSERT INTO receipt_candidates VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(candidate_id) DO UPDATE SET candidate=excluded.candidate")
      .run(id, item.sessionID, item.admissionID, item.destination, item.receiverOwnerID ?? "", JSON.stringify(value), expiresAt);
  });
}
export function receiptCandidates<T>(sessionID: string, admissionID: string, destination: string, ownerID: string, now: number): T[] {
  return immediate((db) => {
    db.query("DELETE FROM receipt_candidates WHERE ready=0 AND expires_at<=?").run(now);
    return (db.query("SELECT candidate FROM receipt_candidates WHERE session_id=? AND admission_id=? AND destination=? AND owner_id=?").all(sessionID, admissionID, destination, ownerID) as Array<{ candidate: string }>).map((row) => JSON.parse(row.candidate) as T);
  });
}
export function markReceiptCandidateReady(id: string): boolean {
  return immediate((db) => db.query("UPDATE receipt_candidates SET ready=1,expires_at=? WHERE candidate_id=? AND ready=0")
    .run(Number.MAX_SAFE_INTEGER, id).changes === 1);
}
export function readyReceiptCandidates<T>(destination: string, ownerID: string | undefined, now: number, limit?: number): Array<{ id: string; value: T }> {
  return immediate((db) => {
    db.query("DELETE FROM receipt_candidates WHERE ready=0 AND expires_at<=?").run(now);
    const query = "SELECT candidate_id,candidate FROM receipt_candidates WHERE ready=1 AND destination=? AND owner_id=?" + (limit ? " LIMIT ?" : "");
    const rows = (limit ? db.query(query).all(destination, ownerID ?? "", limit) : db.query(query).all(destination, ownerID ?? "")) as Array<{ candidate_id: string; candidate: string }>;
    return rows.map((row) => ({ id: row.candidate_id, value: JSON.parse(row.candidate) as T }));
  });
}
export function deleteReceiptCandidate(id: string): void {
  immediate((db) => db.query("DELETE FROM receipt_candidates WHERE candidate_id=?").run(id));
}

export function claimBackgroundAttempt(sessionID: string, roomID: string, service: string, throughTs: number): boolean {
  return immediate((db) => Number.isSafeInteger(throughTs) && throughTs > 0 &&
    db.query("INSERT INTO background_attempted_through VALUES(?,?,?,?) ON CONFLICT(session_id,room_id,service) DO UPDATE SET through_ts=excluded.through_ts WHERE excluded.through_ts>background_attempted_through.through_ts")
      .run(sessionID, roomID, service, throughTs).changes === 1);
}

export function nextPresenceSequence(ownerID: string): number {
  return immediate((db) => {
    db.query("INSERT INTO presence_sequences VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET sequence=sequence+1").run(ownerID);
    return (db.query("SELECT sequence FROM presence_sequences WHERE owner_id=?").get(ownerID) as { sequence: number }).sequence;
  });
}

export function claimPresenceReport(ownerID: string, target: string, now: number, interval: number): boolean {
  return immediate((db) => {
    const row = db.query("SELECT last_report_at FROM presence_throttle WHERE owner_id=? AND target=?").get(ownerID, target) as { last_report_at: number } | null;
    if (row && now - row.last_report_at < interval) return false;
    db.query("INSERT INTO presence_throttle VALUES(?,?,?) ON CONFLICT(owner_id,target) DO UPDATE SET last_report_at=excluded.last_report_at").run(ownerID, target, now);
    return true;
  });
}

export function acquireDeliveryLease(sessionID: string, holder: string, now: number, expiresAt: number): boolean {
  return immediate((db) => {
    db.query("DELETE FROM delivery_leases WHERE expires_at<=?").run(now);
    return db.query("INSERT INTO delivery_leases VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE delivery_leases.expires_at<=?")
      .run(sessionID, holder, expiresAt, now).changes === 1;
  });
}
export function renewDeliveryLease(sessionID: string, holder: string, now: number, expiresAt: number): boolean {
  return immediate((db) => db.query("UPDATE delivery_leases SET expires_at=? WHERE session_id=? AND holder=? AND expires_at>?")
    .run(expiresAt, sessionID, holder, now).changes === 1);
}
export function ownsDeliveryLease(sessionID: string, holder: string, now: number): boolean {
  const row = database().query("SELECT 1 AS owned FROM delivery_leases WHERE session_id=? AND holder=? AND expires_at>?").get(sessionID, holder, now);
  return Boolean(row);
}
export function releaseDeliveryLease(sessionID: string, holder: string): void {
  immediate((db) => db.query("DELETE FROM delivery_leases WHERE session_id=? AND holder=?").run(sessionID, holder));
}
export function watcherProcessMayExist(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function claimWatcher(identity: string, instanceID: string, pid: number): boolean {
  return immediate((db) => {
    const row = db.query("SELECT instance_id,pid FROM watcher_claims WHERE identity=?").get(identity) as { instance_id: string; pid: number } | null;
    if (row && row.instance_id !== instanceID && watcherProcessMayExist(row.pid)) return false;
    db.query("INSERT INTO watcher_claims VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET instance_id=excluded.instance_id,pid=excluded.pid")
      .run(identity, instanceID, pid);
    return true;
  });
}
export function releaseWatcherClaim(identity: string, instanceID: string): void {
  immediate((db) => db.query("DELETE FROM watcher_claims WHERE identity=? AND instance_id=?").run(identity, instanceID));
}
export function closeReceiverState(): void {
  for (const [file, db] of databases) { db.close(); databases.delete(file); }
}
