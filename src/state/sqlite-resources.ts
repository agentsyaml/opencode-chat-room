import { openStateDatabase } from "./sqlite-database.ts";
import { immediate } from "./sqlite-transaction.ts";

export type StoredResource = { id: string; roomID: string; name: string; mimeType: string; size: number; createdAt: number; uploaderSessionID?: string | null; uploaderName?: string | null };
export async function putResource(file: string, resource: StoredResource): Promise<boolean> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(resource.roomID)) return false;
    db.query("INSERT INTO resources(id,room_id,name,mime_type,size,created_at,uploader_session_id,uploader_name) VALUES(?,?,?,?,?,?,?,?)")
      .run(resource.id, resource.roomID, resource.name, resource.mimeType, resource.size, resource.createdAt, resource.uploaderSessionID ?? null, resource.uploaderName ?? null);
    return true;
  });
}
export async function listResources(file: string, roomID: string, limit = 500, offset = 0, beforeID?: string): Promise<{ items: StoredResource[]; total: number }> {
  const db = await openStateDatabase(file);
  const cursor = beforeID
    ? db.query("SELECT created_at AS createdAt,id FROM resources WHERE room_id=? AND id=?").get(roomID, beforeID) as { createdAt: number; id: string } | null
    : null;
  const items = cursor
    ? db.query("SELECT id,room_id AS roomID,name,mime_type AS mimeType,size,created_at AS createdAt,uploader_session_id AS uploaderSessionID,uploader_name AS uploaderName FROM resources WHERE room_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(roomID, cursor.createdAt, cursor.createdAt, cursor.id, limit) as StoredResource[]
    : db.query("SELECT id,room_id AS roomID,name,mime_type AS mimeType,size,created_at AS createdAt,uploader_session_id AS uploaderSessionID,uploader_name AS uploaderName FROM resources WHERE room_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(roomID, limit, offset) as StoredResource[];
  const total = Number((db.query("SELECT COUNT(*) AS count FROM resources WHERE room_id=?").get(roomID) as { count: number } | null)?.count ?? 0);
  return { items, total };
}

export async function getResource(file: string, roomID: string, id: string): Promise<StoredResource | undefined> {
  const db = await openStateDatabase(file);
  const row = db.query("SELECT id,room_id AS roomID,name,mime_type AS mimeType,size,created_at AS createdAt,uploader_session_id AS uploaderSessionID,uploader_name AS uploaderName FROM resources WHERE room_id=? AND id=?")
    .get(roomID, id) as (StoredResource & { uploaderSessionID: string | null; uploaderName: string | null }) | null;
  if (!row) return undefined;
  const { uploaderSessionID, uploaderName, ...rest } = row;
  return { ...rest, ...(uploaderSessionID ? { uploaderSessionID } : {}), ...(uploaderName ? { uploaderName } : {}) };
}
export async function removeResource(file: string, roomID: string, id: string): Promise<boolean> {
  const db = await openStateDatabase(file);
  return immediate(db, () => db.query("DELETE FROM resources WHERE room_id=? AND id=?").run(roomID, id).changes > 0);
}
