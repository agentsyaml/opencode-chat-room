import { databasePath } from "./store";
import { deleteAnnouncement as sqliteDelete, getAnnouncement as sqliteGet, listAnnouncements as sqliteList, putAnnouncement as sqlitePut, type Announcement } from "./sqlite-state";

export type { Announcement };
export function validateAnnouncement(name: unknown, content?: unknown, requireContent = false): string | undefined {
  if (typeof name !== "string" || !name.trim() || Array.from(name.trim()).length > 64) return "announcement name must contain 1 to 64 characters";
  if ((requireContent || content !== undefined) && (typeof content !== "string" || Array.from(content).length > 5000)) return "announcement content must be a string of at most 5000 characters";
}
export const listAnnouncements = (roomID: string) => sqliteList(databasePath(), roomID);
export const getAnnouncement = (roomID: string, name: string) => sqliteGet(databasePath(), roomID, name.trim());
export function putAnnouncement(roomID: string, name: string, content: unknown) {
  const error = validateAnnouncement(name, content, true);
  if (error) throw new TypeError(error);
  return sqlitePut(databasePath(), roomID, name.trim(), content as string, Date.now());
}
export const deleteAnnouncement = (roomID: string, name: string) => sqliteDelete(databasePath(), roomID, name.trim());
