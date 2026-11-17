import RoomService, { RoomError, type Room } from "../src/rooms/room-service.ts";
import { databasePath, writeState } from "../src/state/store.ts";
import { writeSqliteStateWithDatabase } from "../src/state/sqlite-state.ts";
import { binding, enroll, exec, tx, validCurrent } from "./admin-state";
import { hasAdminCapability } from "./admin-auth";
import { roomPayload } from "./room-payload";
import { clearPendingAdmission } from "../src/center/queue.ts";
import { removeRoomResources } from "../src/rooms/resources.ts";
import { isOwnerEntry, isRoomAdmin, isUser } from "./room-owner";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const mutate = <T>(fn: (service: RoomService, registry: import("../src/state/store.ts").Registry) => T) => writeState(fn);
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
    const agentBinding = await tx(db => {
      const b = binding(db, roomId);
      return b && b.target_room_id === roomId && b.session_id === actor && validCurrent(db, b) && hasAdminCapability(req, b) ? b : undefined;
    });
    const result = await mutate((svc, registry) => {
      const room = svc.getRoom(roomId), members = registry[roomId];
      const actorEntry = members?.[actor];
      if (!actorEntry) throw new RoomError("NOT_JOINED", "actor is not a room member");
      if (room.kind === "direct") throw new RoomError("DIRECT_ROOM_FULL", "delete the direct conversation instead");
      const humanAdmin = isRoomAdmin(room, actorEntry);
      const agentAdmin = !humanAdmin && !isUser(actorEntry) && agentBinding?.membership_id === actorEntry.membershipID;
      if (!humanAdmin && !agentAdmin) throw new RoomError("NOT_OWNER", "only human room administrators or the designated agent administrator can remove members");
      const removed = members[target];
      if (!removed) throw new RoomError("ROOM_NOT_FOUND", "target session is not a room member");
      if (agentAdmin && isRoomAdmin(room, removed)) throw new RoomError("NOT_OWNER", "the designated agent administrator cannot remove human administrators");
      if (isOwnerEntry(room, removed) && !Object.entries(members).some(([sid, entry]) => sid !== target && entry.name === room.ownerId)) throw new RoomError("NOT_OWNER", "the room owner cannot be removed");
      delete members[target];
      if (!Object.values(members).some((entry) => entry.name === removed.name)) {
        svc.leaveRoom(roomId, removed.name);
        const next = (room.adminIds ?? []).filter((name) => name !== removed.name);
        if (next.length) room.adminIds = next; else delete room.adminIds;
        if (removed.membershipID && room.adminMembershipIDs?.length) {
          const ids = room.adminMembershipIDs.filter((id) => id !== removed.membershipID);
          if (ids.length) room.adminMembershipIDs = ids; else delete room.adminMembershipIDs;
        }
      }
      const message = svc.addEvent(roomId, `${removed.name} was removed from the room`);
      if (room.successorId && (room.successorMembershipID ? removed.membershipID === room.successorMembershipID : removed.name === room.successorId)) {
        delete room.successorId;
        delete room.successorMembershipID;
      }
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
    if (body.adminIds !== undefined && (!Array.isArray(body.adminIds) || body.adminIds.length > 50 || body.adminIds.some((name) => typeof name !== "string" || !name.trim() || name.trim().length > 64))) return json({ error: "adminIds must be up to 50 member names" }, 400);
    if (body.successorId !== undefined && body.successorId !== null && (typeof body.successorId !== "string" || !body.successorId.trim() || body.successorId.trim().length > 64)) return json({ error: "successorId must be a member name or null" }, 400);
    const successorId = typeof body.successorId === "string" ? body.successorId.trim() : body.successorId === null ? null : undefined;
    const adminIds = Array.isArray(body.adminIds) ? [...new Set(body.adminIds.map((name) => (name as string).trim()))] : undefined;
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const description = typeof body.description === "string" ? body.description.trim() : undefined;
    const adminSessionID = typeof body.adminSessionID === "string" ? body.adminSessionID : body.adminSessionID === null ? null : undefined;
    if (body.ownerId !== undefined && (typeof body.ownerId !== "string" || !body.ownerId.trim() || body.ownerId.trim().length > 64)) return json({ error: "ownerId must be 1-64 characters" }, 400);
    const nextOwner = typeof body.ownerId === "string" ? body.ownerId.trim() : undefined;
    const result = await writeSqliteStateWithDatabase(databasePath(), (svc, registry, db) => {
      const room = svc.getRoom(roomId);
      const actor = registry[roomId]?.[sessionID];
      if (!actor) return { status: 409 as const, error: "actor is not a room member" };
      // The owner keeps the powers that shape the room's control; delegated
      // human admins may edit its presentation and the admin roster.
      const isOwner = actor.name === room.ownerId && (!room.ownerMembershipID || actor.membershipID === room.ownerMembershipID);
      if (!isOwner && !isRoomAdmin(room, actor)) return { status: 403 as const, error: "only the room owner can edit the room" };
      if (!isOwner && (adminSessionID !== undefined || nextOwner !== undefined)) return { status: 403 as const, error: "only the room owner can change agent administrators or hand off the room" };
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
      if (adminIds !== undefined) {
        const entries = Object.values(registry[roomId] ?? {});
        for (const name of adminIds) {
          if (!entries.some((entry) => entry.name === name && isUser(entry))) return { status: 409 as const, error: "administrators must be joined humans" };
        }
        const next = adminIds.filter((name) => name !== room.ownerId);
        const ids = [...new Set(next.flatMap((name) => {
          const entry = entries.find((item) => item.name === name && isUser(item));
          return entry?.membershipID ? [entry.membershipID] : [];
        }))];
        if (JSON.stringify(next) !== JSON.stringify(room.adminIds ?? []) || JSON.stringify(ids) !== JSON.stringify(room.adminMembershipIDs ?? [])) {
          if (next.length) room.adminIds = next; else delete room.adminIds;
          if (ids.length) room.adminMembershipIDs = ids; else delete room.adminMembershipIDs;
          changes.push(`${actor.name} updated the room administrators`);
        }
      }
      if (successorId !== undefined) {
        if (successorId === null) {
          if (room.successorId) { delete room.successorId; delete room.successorMembershipID; changes.push(`${actor.name} cleared the room successor`); }
        } else {
          const target = Object.values(registry[roomId] ?? {}).find((entry) => entry.name === successorId && isUser(entry));
          if (!target) return { status: 409 as const, error: "the successor must be a joined human" };
          if (room.successorId !== target.name || room.successorMembershipID !== target.membershipID) {
            room.successorId = target.name;
            if (target.membershipID) room.successorMembershipID = target.membershipID; else delete room.successorMembershipID;
            changes.push(`${actor.name} named ${target.name} as the room successor`);
          }
        }
      }
      if (nextOwner !== undefined && nextOwner !== room.ownerId) {
        // Only a person can hold a room; an agent must never inherit it by accident.
        const target = Object.values(registry[roomId] ?? {}).find((entry) => entry.name === nextOwner && isUser(entry));
        if (!target) return { status: 409 as const, error: "the new owner must be a person in this room" };
        changes.push(`${actor.name} handed the room to ${nextOwner}`);
        room.ownerId = nextOwner;
        if (target.membershipID) room.ownerMembershipID = target.membershipID; else delete room.ownerMembershipID;
        delete room.successorId;
        delete room.successorMembershipID;
        if (room.adminIds) {
          const remaining = room.adminIds.filter((name) => name !== nextOwner);
          if (remaining.length) room.adminIds = remaining; else delete room.adminIds;
        }
        if (target.membershipID && room.adminMembershipIDs?.length) {
          const remaining = room.adminMembershipIDs.filter((id) => id !== target.membershipID);
          if (remaining.length) room.adminMembershipIDs = remaining; else delete room.adminMembershipIDs;
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
    // Dissolving the room is the owner's call; everyone else only leaves.
    const sessions = await mutate((svc, registry) => {
      const room = svc.getRoom(roomId);
      const actor = registry[roomId]?.[sessionID];
      if (!actor) throw new RoomError("NOT_JOINED", "actor is not a room member");
      if (room.ownerId && !(actor.name === room.ownerId && (!room.ownerMembershipID || actor.membershipID === room.ownerMembershipID))) throw new RoomError("NOT_OWNER", "only the room owner can delete the room");
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
