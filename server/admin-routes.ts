import { databasePath } from "../src/store";
import { readHistoryPage } from "../src/sqlite-state";
import { adminEnabled, hasAdminCapability, isOperator } from "./admin-auth";
import { adminPlanRoutes } from "./admin-plan-routes";
import { adminTaskRoutes } from "./admin-task-routes";
import { binding, digest, ensureAdminSchema, exec, isAgentMember, many, matchesHash, newSecret, one, publicRoom, tx, validCurrent, enroll } from "./admin-state";
import type { Binding } from "./admin-state";
import { startAdminScheduler } from "./admin-scheduler";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
startAdminScheduler();

export async function adminRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/admin/") && !url.pathname.startsWith("/supervision/")) return undefined;
  if (!adminEnabled) return json({ error: "admin API is disabled" }, 503);
  try {
    await ensureAdminSchema();
    const task = await adminTaskRoutes(request, url);
    if (task) return task;
    const plan = await adminPlanRoutes(request, url);
    if (plan) return plan;
    return await rootRoutes(request, url);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "invalid request" }, 400);
    return json({ error: "admin request failed" }, 500);
  }
}

async function rootRoutes(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/admin/rooms") return listRooms(request);
  if (request.method === "POST" && path === "/admin/rooms") return createBinding(request);
  const claim = path.match(/^\/admin\/rooms\/([^/]+)\/claim$/);
  if (claim && request.method === "POST") return claimBinding(request, decodeURIComponent(claim[1]!));
  const room = path.match(/^\/admin\/rooms\/([^/]+)(?:\/(overview|history))?$/);
  if (!room) return json({ error: "not found" }, 404);
  const roomID = decodeURIComponent(room[1]!);
  if (request.method === "PUT" && !room[2]) return rotateBinding(request, roomID);
  if (request.method === "DELETE" && !room[2]) return revokeBinding(request, roomID);
  if (request.method === "GET" && room[2] === "overview") return overview(request, roomID);
  if (request.method === "GET" && room[2] === "history") return history(request, url, roomID);
  return json({ error: "method not allowed" }, 405);
}

async function listRooms(request: Request): Promise<Response> {
  if (!isOperator(request)) return json({ error: "operator token required" }, 401);
  return json({ rooms: await tx(db => many<Binding>(db, "SELECT * FROM admin_rooms ORDER BY created_at LIMIT 200").map(publicRoom)) });
}

async function createBinding(request: Request): Promise<Response> {
  if (!isOperator(request)) return json({ error: "operator token required" }, 401);
  const body: unknown = await request.json();
  if (!object(body) || !bounded(body.roomId, 128) || !bounded(body.targetRoomId, 128) ||
    !bounded(body.sessionID, 128) || typeof body.receiverOwnerID !== "string" || body.receiverOwnerID.length > 128 ||
    !bounded(body.membershipID, 128)) return json({ error: "invalid admin binding" }, 400);
  const { roomId, targetRoomId, sessionID, receiverOwnerID, membershipID } = body as {
    roomId: string; targetRoomId: string; sessionID: string; receiverOwnerID: string; membershipID: string;
  };
  const result = await tx(db => {
    const admin = one<{ kind: string }>(db, "SELECT kind FROM rooms WHERE id=?", roomId);
    if (!admin) return { status: 404 as const, error: "admin room not found" };
    if (admin.kind !== "group") return { status: 400 as const, error: "admin room must be a group room" };
    if (one(db, "SELECT 1 FROM admin_rooms WHERE room_id=?", roomId)) return { status: 409 as const, error: "admin room already designated; use PUT to rotate" };
    if (!one(db, "SELECT 1 FROM rooms WHERE id=?", targetRoomId)) return { status: 404 as const, error: "target room not found" };
    if (!isAgentMember(db, targetRoomId, sessionID, receiverOwnerID, membershipID)) return { status: 409 as const, error: "target agent binding is not active" };
    const issued = enroll(db, roomId, targetRoomId, sessionID, receiverOwnerID, membershipID, 1);
    const adminBinding = binding(db, roomId);
    return issued && adminBinding ? { status: 201 as const, issued, adminRoom: publicRoom(adminBinding) } : { status: 409 as const, error: "admin room cannot be designated" };
  });
  return "issued" in result ? json({ adminRoom: result.adminRoom, ...result.issued }, result.status) : json({ error: result.error }, result.status);
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

async function rotateBinding(request: Request, roomID: string): Promise<Response> {
  if (!isOperator(request)) return json({ error: "operator token required" }, 401);
  const body: unknown = await request.json();
  if (!object(body) || !bounded(body.targetRoomId, 128) || !bounded(body.sessionID, 128) ||
    typeof body.receiverOwnerID !== "string" || body.receiverOwnerID.length > 128 || !bounded(body.membershipID, 128)) return json({ error: "invalid binding" }, 400);
  const { targetRoomId, sessionID, receiverOwnerID, membershipID } = body as {
    targetRoomId: string; sessionID: string; receiverOwnerID: string; membershipID: string;
  };
  const result = await tx(db => {
    const old = binding(db, roomID);
    if (!old) return null;
    if (!isAgentMember(db, targetRoomId, sessionID, receiverOwnerID, membershipID)) return null;
    const issued = enroll(db, roomID, targetRoomId, sessionID, receiverOwnerID, membershipID, old.generation + 1);
    const current = binding(db, roomID);
    return issued && current ? { issued, adminRoom: publicRoom(current) } : null;
  });
  return result ? json({ adminRoom: result.adminRoom, ...result.issued }) : json({ error: "admin room or active agent binding not found" }, 409);
}

async function revokeBinding(request: Request, roomID: string): Promise<Response> {
  if (!isOperator(request)) return json({ error: "operator token required" }, 401);
  const deleted = await tx(db => exec(db, "DELETE FROM admin_rooms WHERE room_id=?", roomID).changes);
  return deleted ? json({ ok: true }) : json({ error: "admin room not found" }, 404);
}

async function overview(request: Request, roomID: string): Promise<Response> {
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!authorized(request, b)) return { status: 401 as const };
    if (!isOperator(request) && !validCurrent(db, b)) return { status: 409 as const };
    const rooms = many<{ id: string; name: string; createdAt: number }>(db, "SELECT id,name,created_at AS createdAt FROM rooms ORDER BY created_at DESC LIMIT 200")
      .map(room => ({ ...room, members: many(db, "SELECT g.session_id AS sessionID,g.name,g.protocol,g.receiver_owner_id AS receiverOwnerID,g.work_state AS workState,g.last_seen_at AS lastSeenAt FROM registry g WHERE g.room_id=? ORDER BY g.name", room.id) }));
    const tasks = many(db, "SELECT id,admin_room_id AS adminRoomId,admin_generation AS generation,target_room_id AS targetRoomId,target_session_id AS targetSessionID,text,status,progress,created_at AS createdAt,updated_at AS updatedAt FROM admin_tasks WHERE admin_room_id=? ORDER BY created_at DESC LIMIT 200", roomID);
    const plans = many(db, "SELECT id,admin_room_id AS adminRoomId,name,interval_seconds AS intervalSeconds,text,paused,next_run_at AS nextRunAt,created_at AS createdAt FROM admin_plans WHERE admin_room_id=? ORDER BY created_at DESC LIMIT 200", roomID);
    return { rooms, tasks, plans };
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
    if (!authorized(request, b)) return 401;
    if (!isOperator(request) && !validCurrent(db, b)) return 409;
    return one(db, "SELECT 1 FROM rooms WHERE id=?", targetRoomID) ? 200 : 404;
  });
  if (allowed !== 200) return json({ error: allowed === 401 ? "unauthorized" : allowed === 404 ? "room not found" : "binding is no longer active" }, allowed);
  return json(await readHistoryPage(databasePath(), targetRoomID, undefined, limit));
}

function authorized(request: Request, b: import("./admin-state").Binding): boolean {
  return isOperator(request) || hasAdminCapability(request, b);
}
