import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const databases = new Map<string, Database>();
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS delivery_leases(session_id TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pending_admissions(session_id TEXT NOT NULL,room_id TEXT NOT NULL,admission TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,room_id)); CREATE INDEX IF NOT EXISTS pending_admissions_expiry ON pending_admissions(expires_at); CREATE TABLE IF NOT EXISTS watcher_claims(identity TEXT PRIMARY KEY,instance_id TEXT NOT NULL,pid INTEGER NOT NULL);");
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
  return immediate((db) => {
    db.query("DELETE FROM pending_admissions WHERE expires_at<=?").run(now);
    const row = db.query("SELECT admission FROM pending_admissions WHERE session_id=? AND room_id=?").get(sessionID, roomID) as { admission: string } | null;
    return row ? JSON.parse(row.admission) as T : undefined;
  });
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
