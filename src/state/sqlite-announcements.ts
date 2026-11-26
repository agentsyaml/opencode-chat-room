import { openStateDatabase } from "./sqlite-database.ts";
import { immediate } from "./sqlite-transaction.ts";

export type Announcement = { roomID: string; name: string; content: string; updatedAt: number };
export async function listAnnouncements(file: string, roomID: string): Promise<Announcement[]> {
  const db = await openStateDatabase(file);
  if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return [];
  return db.query("SELECT room_id AS roomID,name,content,updated_at AS updatedAt FROM announcements WHERE room_id=? ORDER BY name").all(roomID) as Announcement[];
}
export async function getAnnouncement(file: string, roomID: string, name: string): Promise<Announcement | undefined> {
  const db = await openStateDatabase(file);
  return db.query("SELECT room_id AS roomID,name,content,updated_at AS updatedAt FROM announcements WHERE room_id=? AND name=?").get(roomID, name) as Announcement | undefined;
}
export async function putAnnouncement(file: string, roomID: string, name: string, content: string, updatedAt: number): Promise<Announcement | undefined> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM rooms WHERE id=?").get(roomID)) return undefined;
    db.query("INSERT INTO announcements(room_id,name,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(room_id,name) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at").run(roomID, name, content, updatedAt);
    return { roomID, name, content, updatedAt };
  });
}
export async function deleteAnnouncement(file: string, roomID: string, name: string): Promise<boolean> {
  const db = await openStateDatabase(file);
  return immediate(db, () => db.query("DELETE FROM announcements WHERE room_id=? AND name=?").run(roomID, name).changes > 0);
}
