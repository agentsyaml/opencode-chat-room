import RoomService, { RoomError, type Room } from "../src/room-service";
import { databasePath, writeState } from "../src/store";
import { writeSqliteStateWithDatabase } from "../src/sqlite-state";
import { binding, enroll, exec } from "./admin-state";
import { roomPayload } from "./room-payload";
import { clearPendingAdmission } from "../src/queue";
import { removeRoomResources } from "../src/resources";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const mutate = <T>(fn: (service: RoomService, registry: import("../src/store").Registry) => T) => writeState(fn);
async function objectBody(req: Request): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await req.json();
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function roomManagement(req: Request, url: URL): Promise<Response | undefined> {
  const p = url.pathname;
  if (req.method === "POST" && p === "/direct") {
    const body = await objectBody(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const roomId = typeof body.roomId === "string" ? body.roomId : "";
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
    const targetSessionID = typeof body.targetSessionID === "string" ? body.targetSessionID : "";
    if (!roomId || !sessionID || !targetSessionID || sessionID === targetSessionID || sessionID.length > 128 || targetSessionID.length > 128) return json({ error: "roomId and distinct sessionIDs are required" }, 400);
    const result = await mutate((svc, registry) => {
      svc.getRoom(roomId);
      const actor = registry[roomId]?.[sessionID], target = registry[roomId]?.[targetSessionID];
      if (!actor || !target) throw new RoomError("NOT_JOINED", "both sessions must belong to the source room");
      const pair = JSON.stringify([sessionID, targetSessionID].sort());
      const existing = svc.listRooms().find((room) => room.directPair === pair);
      const direct = existing ?? svc.createDirectRoom(`${actor.name} ↔ ${target.name}`, actor.name, [sessionID, targetSessionID]);
      const members = (registry[direct.id] ??= Object.create(null));
      const tail = direct.messages.at(-1)?.createdAt ?? 0;
      for (const [sid, entry] of [[sessionID, actor], [targetSessionID, target]] as const) {
        const { membershipID: _sourceMembershipID, lastSeenAt: _sourceSeenAt, workState: _sourceWorkState, ...binding } = entry;
        svc.joinRoom(direct.id, { id: sid, name: entry.name });
        const previous = members[sid];
        members[sid] = { ...binding, ...(previous?.membershipID ? { membershipID: previous.membershipID } : {}),
          ...(previous?.lastSeenAt !== undefined ? { lastSeenAt: previous.lastSeenAt } : {}),
          ...(previous?.workState !== undefined ? { workState: previous.workState } : {}),
          lastReadTs: previous ? previous.lastReadTs ?? 0 : tail, lastQueuedTs: previous?.lastQueuedTs ?? 0 };
      }
      return { room: direct, created: !existing };
    });
    return json(await roomPayload(result.room), result.created ? 201 : 200);
  }
  const kick = p.match(/^\/rooms\/([^/]+)\/kick$/);
  if (kick && req.method === "POST") {
    const roomId = decodeURIComponent(kick[1]!);
    const body = await objectBody(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const actor = typeof body.sessionID === "string" ? body.sessionID : "";
    const target = typeof body.targetSessionID === "string" ? body.targetSessionID : "";
    if (!actor || !target || actor === target || actor.length > 128 || target.length > 128) return json({ error: "distinct sessionIDs are required" }, 400);
    const result = await mutate((svc, registry) => {
      const room = svc.getRoom(roomId), members = registry[roomId];
      if (!members?.[actor]) throw new RoomError("NOT_JOINED", "actor is not a room member");
      if (room.kind === "direct") throw new RoomError("DIRECT_ROOM_FULL", "delete the direct conversation instead");
      const removed = members[target];
      if (!removed) throw new RoomError("ROOM_NOT_FOUND", "target session is not a room member");
      delete members[target];
      if (!Object.values(members).some((entry) => entry.name === removed.name)) svc.leaveRoom(roomId, removed.name);
      const message = svc.addEvent(roomId, `${removed.name} was removed from the room`);
      if (!Object.keys(members).length) delete registry[roomId];
      return { message, target };
    });
    clearPendingAdmission(result.target, roomId, Number.MAX_SAFE_INTEGER);
    return json({ ok: true, createdAt: result.message.createdAt });
  }
  const edit = p.match(/^\/rooms\/([^/]+)$/);
  if (edit && req.method === "PATCH") {
    const roomId = decodeURIComponent(edit[1]!);
    const body = await objectBody(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
    if (!sessionID || sessionID.length > 128) return json({ error: "sessionID is required" }, 400);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 64)) return json({ error: "name must be 1-64 characters" }, 400);
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000)) return json({ error: "description too long (max 2000)" }, 400);
    if (body.adminSessionID !== undefined && body.adminSessionID !== null && (typeof body.adminSessionID !== "string" || body.adminSessionID.length > 128)) return json({ error: "invalid adminSessionID" }, 400);
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const description = typeof body.description === "string" ? body.description.trim() : undefined;
    const adminSessionID = typeof body.adminSessionID === "string" ? body.adminSessionID : body.adminSessionID === null ? null : undefined;
    const result = await writeSqliteStateWithDatabase(databasePath(), (svc, registry, db) => {
      const room = svc.getRoom(roomId);
      const actor = registry[roomId]?.[sessionID];
      if (!actor) return { status: 409 as const, error: "actor is not a room member" };
      if (actor.name !== room.ownerId) return { status: 403 as const, error: "only the room owner can edit the room" };
      const changes: string[] = [];
      if (name !== undefined && name !== room.name) { changes.push(`${actor.name} renamed the room from "${room.name}" to "${name}"`); room.name = name; }
      if (description !== undefined && description !== (room.description ?? "")) { room.description = description || undefined; changes.push(`${actor.name} updated the room description`); }
      if (adminSessionID !== undefined) {
        if (!adminSessionID) {
          if (binding(db, roomId)) { exec(db, "DELETE FROM admin_rooms WHERE room_id=?", roomId); changes.push(`${actor.name} revoked the administrator designation`); }
        } else {
          const agent = registry[roomId]?.[adminSessionID];
          if (!agent?.membershipID || !(agent.protocol === "v1" || agent.protocol === "v2" || agent.receiverOwnerID || agent.host)) return { status: 409 as const, error: "administrator must be a registered agent member" };
          const previous = binding(db, roomId);
          if (previous?.session_id !== adminSessionID) {
            if (!enroll(db, roomId, roomId, adminSessionID, agent.receiverOwnerID ?? "", agent.membershipID, (previous?.generation ?? 0) + 1)) return { status: 409 as const, error: "this room cannot be designated as an admin room" };
            changes.push(`${actor.name} designated ${agent.name} as administrator`);
          }
        }
      }
      if (changes.length) svc.addEvent(roomId, changes.join("; "));
      return { room };
    });
    if ("error" in result) return json({ error: result.error }, result.status);
    return json(await roomPayload(result.room));
  }
  const remove = p.match(/^\/rooms\/([^/]+)$/);
  if (remove && req.method === "DELETE") {
    const roomId = decodeURIComponent(remove[1]!);
    const body = await objectBody(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
    if (!sessionID || sessionID.length > 128) return json({ error: "sessionID is required" }, 400);
    // Admin bindings cascade with the room (foreign keys), so members may delete.
    const sessions = await mutate((svc, registry) => {
      svc.getRoom(roomId);
      if (!registry[roomId]?.[sessionID]) throw new RoomError("NOT_JOINED", "actor is not a room member");
      const removed = Object.keys(registry[roomId] ?? {});
      svc.deleteRoom(roomId);
      delete registry[roomId];
      return removed;
    });
    await removeRoomResources(roomId).catch(() => console.error("failed to clean deleted room resources", roomId));
    for (const sid of sessions) clearPendingAdmission(sid, roomId, Number.MAX_SAFE_INTEGER);
    return json({ ok: true });
  }
  return undefined;
}
