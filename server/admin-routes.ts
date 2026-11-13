import { databasePath } from "../src/store";
import { readHistoryPage } from "../src/sqlite-state";
import { hasAdminCapability } from "./admin-auth";
import { binding, digest, ensureAdminSchema, exec, isAgentMember, many, matchesHash, newSecret, one, publicRoom, tx, validCurrent } from "./admin-state";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
await ensureAdminSchema();

// Designation is managed by room owners through PATCH /rooms/:id; these routes
// only serve the designated agent (overview/history) and the legacy claim flow.
export async function adminRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/admin/") && !url.pathname.startsWith("/supervision/")) return undefined;
  try {
    await ensureAdminSchema();
    return await rootRoutes(request, url);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "invalid request" }, 400);
    return json({ error: "admin request failed" }, 500);
  }
}

async function rootRoutes(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const claim = path.match(/^\/admin\/rooms\/([^/]+)\/claim$/);
  if (claim && request.method === "POST") return claimBinding(request, decodeURIComponent(claim[1]!));
  const room = path.match(/^\/admin\/rooms\/([^/]+)(?:\/(overview|history))?$/);
  if (!room) return json({ error: "not found" }, 404);
  const roomID = decodeURIComponent(room[1]!);
  if (request.method === "GET" && room[2] === "overview") return overview(request, roomID);
  if (request.method === "GET" && room[2] === "history") return history(request, url, roomID);
  return json({ error: "method not allowed" }, 405);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

async function claimBinding(request: Request, roomID: string): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || !bounded(body.sessionID, 128) || typeof body.receiverOwnerID !== "string" ||
    body.receiverOwnerID.length > 128 || !bounded(body.enrollmentKey, 256)) return json({ error: "invalid claim" }, 400);
  const { sessionID, receiverOwnerID, enrollmentKey } = body as { sessionID: string; receiverOwnerID: string; enrollmentKey: string };
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b || b.session_id !== sessionID || b.receiver_owner_id !== receiverOwnerID ||
      b.enrollment_expires <= Date.now() || !matchesHash(enrollmentKey, b.enrollment_hash) ||
      !isAgentMember(db, b.target_room_id, b.session_id, b.receiver_owner_id, b.membership_id)) return null;
    const capability = newSecret();
    const saved = exec(db, "UPDATE admin_rooms SET capability_hash=?,enrollment_hash='',enrollment_expires=0 WHERE room_id=? AND generation=? AND enrollment_hash=? AND enrollment_expires>?",
      digest(capability), roomID, b.generation, b.enrollment_hash, Date.now());
    return saved.changes === 1 ? { capability, adminRoom: publicRoom({ ...b, capability_hash: digest(capability) }) } : null;
  });
  return result ? json(result) : json({ error: "claim rejected" }, 409);
}

async function overview(request: Request, roomID: string): Promise<Response> {
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!hasAdminCapability(request, b)) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    const rooms = many<{ id: string; name: string; createdAt: number }>(db, "SELECT id,name,created_at AS createdAt FROM rooms ORDER BY created_at DESC LIMIT 200")
      .map(room => ({ ...room, members: many(db, "SELECT g.session_id AS sessionID,g.name,g.protocol,g.receiver_owner_id AS receiverOwnerID,g.work_state AS workState,g.last_seen_at AS lastSeenAt FROM registry g WHERE g.room_id=? ORDER BY g.name", room.id) }));
    return { rooms };
  });
  return "status" in result ? json({ error: result.status === 404 ? "admin room not found" : result.status === 401 ? "unauthorized" : "binding is no longer active" }, result.status) : json(result);
}

async function history(request: Request, url: URL, roomID: string): Promise<Response> {
  const targetRoomID = url.searchParams.get("targetRoomId") ?? "";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!bounded(targetRoomID, 128) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return json({ error: "invalid history request" }, 400);
  const allowed = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return 404;
    if (!hasAdminCapability(request, b)) return 401;
    if (!validCurrent(db, b)) return 409;
    return one(db, "SELECT 1 FROM rooms WHERE id=?", targetRoomID) ? 200 : 404;
  });
  if (allowed !== 200) return json({ error: allowed === 401 ? "unauthorized" : allowed === 404 ? "room not found" : "binding is no longer active" }, allowed);
  return json(await readHistoryPage(databasePath(), targetRoomID, undefined, limit));
}
