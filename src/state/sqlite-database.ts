import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database, isBusyError, type StateDatabase } from "./sqlite.ts";
import { PgDatabase } from "./pg-database.ts";
import { initializeSchema } from "./sqlite-schema.ts";
import { migrate } from "./sqlite-legacy.ts";
import { immediate, pause } from "./sqlite-transaction.ts";

const databases = new Map<string, Promise<StateDatabase>>();

// Set CHAT_ROOM_DATABASE_URL only on the server process. The PostgreSQL
// backend is experimental and single-instance in 0.8.1; the PgDatabase worker
// holds a session advisory lock and a second process fails startup.
function postgresURL(): string | undefined {
  const value = process.env.CHAT_ROOM_DATABASE_URL?.trim();
  return value || undefined;
}

export function openStateDatabase(file: string): Promise<StateDatabase> {
  const url = postgresURL();
  const key = url ? `postgres:${url}` : `sqlite:${file}`;
  const known = databases.get(key);
  if (known) return known;
  const pending = url ? initializePostgres(url) : initialize(file);
  databases.set(key, pending);
  void pending.catch(() => databases.delete(key));
  return pending;
}

// Test and shutdown hook. PgDatabase.close() waits for client.end() so the
// single-instance session lock is released before a new connection is opened.
export async function closeStateDatabases(): Promise<void> {
  const pending = [...databases.values()];
  databases.clear();
  const settled = await Promise.allSettled(pending);
  for (const result of settled) {
    if (result.status === "fulfilled") { try { result.value.close(); } catch { /* already closed */ } }
  }
}

export async function withStateTransaction<T>(file: string, callback: (db: StateDatabase) => T): Promise<T> {
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

async function initializePostgres(connectionString: string): Promise<StateDatabase> {
  const db = new PgDatabase(connectionString);
  try {
    await initializeSchema(db);
    // Legacy rooms.json/registry.json migration is SQLite-only. The migrate
    // command copies an existing SQLite state database into PostgreSQL.
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function initialize(file: string): Promise<StateDatabase> {
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
        await initializeSchema(db);
        await migrate(db, file);
        db.exec("PRAGMA busy_timeout=50;");
        return db;
      } catch (error) {
        if (!isBusyError(error) || attempt >= 7) throw error;
        await pause(Math.min(20 * 2 ** attempt, 250));
      }
    }
  } catch (error) { db.close(); throw error; }
}
