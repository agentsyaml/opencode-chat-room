import { databasePath, listJoinRequests, readJoinRequest, readState } from "../src/state/store.ts";
import { findJoinRequest, removeJoinRequest, writeSqliteStateWithDatabase } from "../src/state/sqlite-state.ts";
import { binding, tx, validCurrent } from "./admin-state";
import { hasAdminCapability } from "./admin-auth";
import { isRoomAdmin } from "./room-owner";
import { joinRoomMember } from "./room-join";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function agentReviewer(req: Request, roomID: string, actor: string): Promise<boolean> {
  return tx(db => {
    const b = binding(db, roomID);
    return Boolean(b && b.target_room_id === roomID && b.session_id === actor && validCurrent(db, b) && hasAdminCapability(req, b));
  });
}

async function humanReviewer(roomID: string, actor: string): Promise<boolean> {
  return readState((svc, registry) => {
    const entry = registry[roomID]?.[actor];
    return Boolean(entry && isRoomAdmin(svc.getRoom(roomID), entry));
  });
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

// Approval-protected joins: requests stay in SQLite until a reviewer consumes
// them; denial removes the row so the requester can try again.
export async function joinRequestRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const status = url.pathname.match(/^\/rooms\/([^/]+)\/join-requests\/status$/);
  const list = url.pathname.match(/^\/rooms\/([^/]+)\/join-requests$/);
  const action = url.pathname.match(/^\/rooms\/([^/]+)\/join-requests\/([^/]+)\/(approve|deny)$/);
  if (!status && !list && !action) return undefined;

  if (status && req.method === "GET") {
    const roomID = decodeURIComponent(status[1]!);
    const sessionID = url.searchParams.get("sessionID") ?? "";
    if (!bounded(sessionID)) return json({ error: "sessionID is required" }, 400);
    const joined = await readState((svc, registry) => {
      svc.getRoom(roomID);
      return Boolean(registry[roomID]?.[sessionID]);
    });
    if (joined) return json({ status: "joined" });
    return json({ status: await readJoinRequest(roomID, sessionID) ? "pending" : "none" });
  }

  if (list && req.method === "DELETE") {
    const roomID = decodeURIComponent(list[1]!);
    const sessionID = url.searchParams.get("sessionID") ?? "";
    if (!bounded(sessionID)) return json({ error: "sessionID is required" }, 400);
    const removed = await writeSqliteStateWithDatabase(databasePath(), (svc, _registry, db) => {
      svc.getRoom(roomID);
      return removeJoinRequest(db, roomID, sessionID);
    });
    return removed ? json({ ok: true }) : json({ error: "join request not found" }, 404);
  }

  if (list && req.method === "GET") {
    const roomID = decodeURIComponent(list[1]!);
    const actor = url.searchParams.get("sessionID") ?? "";
    if (!bounded(actor)) return json({ error: "sessionID is required" }, 400);
    const human = await humanReviewer(roomID, actor);
    const agent = !human && await agentReviewer(req, roomID, actor);
    if (!human && !agent) return json({ error: "only room administrators can review join requests" }, 403);
    const requests = await listJoinRequests(roomID, agent);
    return json({ requests: requests.map(({ sessionID, participantId, name, isAgent, createdAt }) =>
      ({ sessionID, participantId, name, isAgent, createdAt })) });
  }

  if (action && req.method === "POST") {
    const roomID = decodeURIComponent(action[1]!);
    const requestSessionID = decodeURIComponent(action[2]!);
    const decision = action[3]!;
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON object body is required" }, 400);
    const actor = typeof (body as Record<string, unknown>).sessionID === "string" ? (body as Record<string, string>).sessionID : "";
    if (!bounded(actor)) return json({ error: "sessionID is required" }, 400);
    const result = await writeSqliteStateWithDatabase(databasePath(), (svc, registry, db) => {
      const room = svc.getRoom(roomID);
      const actorEntry = registry[roomID]?.[actor];
      const human = Boolean(actorEntry && isRoomAdmin(room, actorEntry));
      const b = binding(db, roomID);
      const agent = !human && Boolean(b && b.target_room_id === roomID && b.session_id === actor && validCurrent(db, b) && hasAdminCapability(req, b));
      if (!human && !agent) return { status: 403 as const, error: "only room administrators can review join requests" };
      const request = findJoinRequest(db, roomID, requestSessionID);
      if (!request) return { status: 404 as const, error: "join request not found" };
      if (agent && !request.isAgent) return { status: 403 as const, error: "the management agent can only review agent requests" };
      if (decision === "deny") {
        removeJoinRequest(db, roomID, requestSessionID);
        return { ok: true as const };
      }
      if (registry[roomID]?.[request.sessionID]) {
        removeJoinRequest(db, roomID, requestSessionID);
        return { status: 409 as const, error: "requester already joined the room" };
      }
      if (svc.containsParticipant(roomID, request.participantId)) {
        removeJoinRequest(db, roomID, requestSessionID);
        return { status: 409 as const, error: "participant name is already in use in this room" };
      }
      removeJoinRequest(db, roomID, requestSessionID);
      joinRoomMember(svc, registry, roomID, {
        sessionID: request.sessionID,
        participantId: request.participantId,
        name: request.name,
        ...(request.protocol ? { protocol: request.protocol } : {}),
        ...(request.receiverOwnerID ? { receiverOwnerID: request.receiverOwnerID } : {}),
        ...(request.directory ? { directory: request.directory } : {}),
        ...(request.host ? { host: request.host } : {}),
        notify: true,
      });
      return { ok: true as const };
    });
    return "ok" in result ? json({ ok: true }) : json({ error: result.error }, result.status);
  }

  return json({ error: "method not allowed" }, 405);
}