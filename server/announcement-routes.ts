import { deleteAnnouncement, getAnnouncement, listAnnouncements, putAnnouncement, validateAnnouncement } from "../src/announcements";
import { readState } from "../src/store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function announcementRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/announcements(?:\/([^/]+))?$/);
  if (!match || !["GET", "PUT", "DELETE"].includes(req.method)) return undefined;
  let roomID: string, name: string | undefined;
  try { roomID = decodeURIComponent(match[1]!); name = match[2] === undefined ? undefined : decodeURIComponent(match[2]); }
  catch { return json({ error: "invalid path" }, 400); }
  const roomExists = await readState((svc) => { try { svc.getRoom(roomID); return true; } catch { return false; } });
  if (!roomExists) return json({ error: "room not found" }, 404);
  if (req.method === "GET") {
    if (!name) return json({ announcements: await listAnnouncements(roomID) });
    if (validateAnnouncement(name)) return json({ error: "invalid announcement name" }, 400);
    const announcement = await getAnnouncement(roomID, name);
    return announcement ? json({ announcement }) : json({ error: "announcement not found" }, 404);
  }
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!object(body) || typeof body.sessionID !== "string" || !body.sessionID) return json({ error: "sessionID is required" }, 400);
  const member = await readState((_svc, registry) => Boolean(registry[roomID]?.[body.sessionID as string]));
  if (!member) return json({ error: "not a room member" }, 403);
  if (req.method === "PUT") {
    const error = validateAnnouncement(name, body.content, true);
    if (error) return json({ error }, 400);
    const announcement = await putAnnouncement(roomID, name!.trim(), body.content as string);
    return announcement ? json({ announcement }) : json({ error: "room not found" }, 404);
  }
  if (!name || validateAnnouncement(name)) return json({ error: "invalid announcement name" }, 400);
  return await deleteAnnouncement(roomID, name) ? json({ ok: true }) : json({ error: "announcement not found" }, 404);
}
