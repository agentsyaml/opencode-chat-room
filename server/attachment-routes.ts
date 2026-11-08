// Image storage for the chat server.
//
// Bytes live beside the SQLite database, one directory per room, and are only
// reachable through this server: there is no public object URL and no
// remote-fetch feature. A message stores the ids, so deleting a room can delete
// its files without guessing which messages referenced them.
import {
  MAX_IMAGE_BYTES,
  readAttachment,
  storeAttachment,
} from "../src/attachments";
import { readState } from "../src/store";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function memberOf(roomID: string, sessionID: string): Promise<boolean> {
  if (!sessionID) return false;
  return readState((_service, registry) => Boolean(registry[roomID]?.[sessionID]));
}

/**
 * POST /attachments/<roomID>?sessionID=... with the image as the body.
 * GET  /attachments/<roomID>/<id>
 */
export { deleteRoomAttachments, readAttachment } from "../src/attachments";

export async function attachmentRoutes(req: Request, url: URL): Promise<Response | null> {
  const upload = url.pathname.match(/^\/attachments\/([^/]+)$/);
  if (upload) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const roomID = decodeURIComponent(upload[1]!);
    const sessionID = url.searchParams.get("sessionID") ?? "";
    if (!(await memberOf(roomID, sessionID))) return json({ error: "session is not a room member" }, 403);
    const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_IMAGE_BYTES + 1024) return json({ error: "image too large" }, 413);
    const data = new Uint8Array(await req.arrayBuffer());
    try {
      const ref = await storeAttachment(roomID, mime, data, url.searchParams.get("name") ?? undefined);
      return json(ref, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "upload failed";
      return json({ error: message }, message === "image too large" ? 413 : 400);
    }
  }
  const read = url.pathname.match(/^\/attachments\/([^/]+)\/([^/]+)$/);
  if (read) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const found = await readAttachment(decodeURIComponent(read[1]!), decodeURIComponent(read[2]!));
    if (!found) return json({ error: "not found" }, 404);
    return new Response(new Uint8Array(found.data), {
      headers: {
        "Content-Type": found.mime,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return null;
}
