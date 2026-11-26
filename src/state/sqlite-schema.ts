import { randomUUID } from "node:crypto";
import { type StateDatabase } from "./sqlite.ts";
import { immediate } from "./sqlite-transaction.ts";

const STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'group',direct_sessions TEXT,direct_pair TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS participants(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(room_id,id));
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,sender_session_id TEXT,text TEXT NOT NULL,created_at INTEGER NOT NULL,is_question INTEGER NOT NULL DEFAULT 0,answer_to TEXT,answered_by TEXT,recalled_at INTEGER,recalled_by TEXT);
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq DESC);
    CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id,created_at,seq);
    CREATE TABLE IF NOT EXISTS registry(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,session_id TEXT NOT NULL,server_url TEXT NOT NULL,api_prefix TEXT NOT NULL,protocol TEXT,name TEXT NOT NULL,last_read_ts INTEGER,last_queued_ts INTEGER,directory TEXT,host TEXT,receiver_owner_id TEXT,membership_id TEXT,work_state TEXT,last_seen_at INTEGER,PRIMARY KEY(room_id,session_id));
    CREATE TABLE IF NOT EXISTS announcements(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,name TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,name));
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL,uploader_session_id TEXT,uploader_name TEXT);
    CREATE TABLE IF NOT EXISTS room_tasks(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('todo','doing','done')),creator_name TEXT NOT NULL,creator_session_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,due_date TEXT NOT NULL DEFAULT '',participants TEXT NOT NULL DEFAULT '[]',conclusion TEXT NOT NULL DEFAULT '',steps TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS room_tasks_room_status_created ON room_tasks(room_id,status,created_at,id);`;

export async function initializeSchema(db: StateDatabase): Promise<void> {
  db.exec(STATE_SCHEMA);
  await ensureRoomColumns(db);
}

async function ensureRoomColumns(db: StateDatabase): Promise<void> {
    await immediate(db, () => {
    const messageColumns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "is_question")) db.exec("ALTER TABLE messages ADD COLUMN is_question INTEGER NOT NULL DEFAULT 0");
    if (!messageColumns.some((column) => column.name === "answer_to")) db.exec("ALTER TABLE messages ADD COLUMN answer_to TEXT");
    if (!messageColumns.some((column) => column.name === "answered_by")) db.exec("ALTER TABLE messages ADD COLUMN answered_by TEXT");
    if (!messageColumns.some((column) => column.name === "recalled_at")) db.exec("ALTER TABLE messages ADD COLUMN recalled_at INTEGER");
    if (!messageColumns.some((column) => column.name === "recalled_by")) db.exec("ALTER TABLE messages ADD COLUMN recalled_by TEXT");
    if (!messageColumns.some((column) => column.name === "client_msg_id")) db.exec("ALTER TABLE messages ADD COLUMN client_msg_id TEXT");
    // A retry after a lost response must return the first insert, not add a twin.
    db.exec("DROP INDEX IF EXISTS messages_client_id");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(room_id,sender_session_id,client_msg_id) WHERE client_msg_id IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS messages_pending_questions ON messages(room_id,is_question,answered_by,seq)");
    db.exec("CREATE INDEX IF NOT EXISTS messages_room_recalled ON messages(room_id,recalled_at)");
    const taskColumns = db.query("PRAGMA table_info(room_tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "due_date")) db.exec("ALTER TABLE room_tasks ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.some((column) => column.name === "participants")) db.exec("ALTER TABLE room_tasks ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'");
    if (!taskColumns.some((column) => column.name === "conclusion")) db.exec("ALTER TABLE room_tasks ADD COLUMN conclusion TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.some((column) => column.name === "steps")) db.exec("ALTER TABLE room_tasks ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'");
    db.exec("CREATE TABLE IF NOT EXISTS room_recall_versions(room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,version INTEGER NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS room_join_requests(
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      protocol TEXT,
      receiver_owner_id TEXT,
      directory TEXT,
      host TEXT,
      is_agent INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(room_id,session_id))`);
    const columns = db.query("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "join_policy")) db.exec("ALTER TABLE rooms ADD COLUMN join_policy TEXT");
    if (!columns.some((column) => column.name === "kind")) db.exec("ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'group'");
    if (!columns.some((column) => column.name === "direct_sessions")) db.exec("ALTER TABLE rooms ADD COLUMN direct_sessions TEXT");
    if (!columns.some((column) => column.name === "direct_pair")) db.exec("ALTER TABLE rooms ADD COLUMN direct_pair TEXT");
    if (!columns.some((column) => column.name === "description")) db.exec("ALTER TABLE rooms ADD COLUMN description TEXT");
    if (!columns.some((column) => column.name === "admin_names")) db.exec("ALTER TABLE rooms ADD COLUMN admin_names TEXT");
    if (!columns.some((column) => column.name === "admin_membership_ids")) db.exec("ALTER TABLE rooms ADD COLUMN admin_membership_ids TEXT");
    if (!columns.some((column) => column.name === "owner_membership_id")) db.exec("ALTER TABLE rooms ADD COLUMN owner_membership_id TEXT");
    if (!columns.some((column) => column.name === "successor_name")) db.exec("ALTER TABLE rooms ADD COLUMN successor_name TEXT");
    if (!columns.some((column) => column.name === "successor_membership_id")) db.exec("ALTER TABLE rooms ADD COLUMN successor_membership_id TEXT");
    const resourceColumns = db.query("PRAGMA table_info(resources)").all() as Array<{ name: string }>;
    if (!resourceColumns.some((column) => column.name === "uploader_session_id")) db.exec("ALTER TABLE resources ADD COLUMN uploader_session_id TEXT");
    if (!resourceColumns.some((column) => column.name === "uploader_name")) db.exec("ALTER TABLE resources ADD COLUMN uploader_name TEXT");
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
