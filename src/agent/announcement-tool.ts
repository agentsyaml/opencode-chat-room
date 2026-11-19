import { deleteAnnouncement, getAnnouncement, listAnnouncements, putAnnouncement, validateAnnouncement } from "../rooms/announcements.ts";
import { loadRegistry, readState } from "../state/store.ts";

export async function runAnnouncementTool(args: { action: string; roomId?: string; announcementName?: string; content?: string }, sessionID: string): Promise<string | undefined> {
  if (!args.action.startsWith("announcement_")) return undefined;
  if (!args.roomId) return "error: roomId is required; use a room UUID from the room list, not the room name";
  if (args.action !== "announcement_list" && !args.announcementName) return "error: announcementName is required; run announcement_list, then pass one listed name exactly";
  if (args.action === "announcement_write") {
    const error = validateAnnouncement(args.announcementName, args.content, true);
    if (error) return `error: ${error}`;
  } else if (args.announcementName && validateAnnouncement(args.announcementName)) return "error: invalid announcement name";
  const exists = await readState((svc) => { try { svc.getRoom(args.roomId!); return true; } catch { return false; } });
  if (!exists) return "error: room not found; run room action list to see valid room UUIDs";
  if (args.action === "announcement_list") return (await listAnnouncements(args.roomId)).map((item) => `${item.name}: ${item.content}`).join("\n") || "no announcements";
  if (args.action === "announcement_read") {
    const item = await getAnnouncement(args.roomId, args.announcementName!);
    return item ? `${item.name}:\n${item.content}` : "error: announcement not found; run announcement_list to see saved names";
  }
  if (!(await loadRegistry())[args.roomId]?.[sessionID]) return "error: not joined; call join for this room first, and wait for approval if required";
  if (args.action === "announcement_write") {
    await putAnnouncement(args.roomId, args.announcementName!.trim(), args.content!);
    return `announcement saved: ${args.announcementName!.trim()}`;
  }
  return await deleteAnnouncement(args.roomId, args.announcementName!) ? `announcement deleted: ${args.announcementName}` : "error: announcement not found; run announcement_list to see saved names";
}
