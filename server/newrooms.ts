import RoomService, { RoomError, type Room } from "../src/room-service";
import { readState, writeState } from "../src/store";
import { clearPendingAdmission } from "../src/queue";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const serializeRoom = (room: Room) => ({ ...room, participants: [...room.participants.values()], messages: room.messages, kind: room.kind ?? "group" });
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
        svc.joinRoom(direct.id, { id: sid, name: entry.name });
        const previous = members[sid];
        members[sid] = { ...entry, lastReadTs: previous ? previous.lastReadTs ?? 0 : tail, lastQueuedTs: previous?.lastQueuedTs ?? 0 };
      }
      return { room: direct, created: !existing };
    });
    return json(serializeRoom(result.room), result.created ? 201 : 200);
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
  const remove = p.match(/^\/rooms\/([^/]+)$/);
  if (remove && req.method === "DELETE") {
    const roomId = decodeURIComponent(remove[1]!);
    const body = await objectBody(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
    if (!sessionID || sessionID.length > 128) return json({ error: "sessionID is required" }, 400);
    const sessions = await mutate((svc, registry) => {
      svc.getRoom(roomId);
      if (!registry[roomId]?.[sessionID]) throw new RoomError("NOT_JOINED", "actor is not a room member");
      const removed = Object.keys(registry[roomId]);
      svc.deleteRoom(roomId);
      delete registry[roomId];
      return removed;
    });
    for (const sid of sessions) clearPendingAdmission(sid, roomId, Number.MAX_SAFE_INTEGER);
    return json({ ok: true });
  }
  const members = p.match(/^\/rooms\/([^/]+)\/members$/);
  if (members && req.method === "GET") {
    const roomId = decodeURIComponent(members[1]!);
    return json(await readState((svc, registry) => {
      svc.getRoom(roomId);
      return Object.entries(registry[roomId] ?? {}).map(([sessionID, entry]) => ({ sessionID, name: entry.name, ...(entry.protocol ? { protocol: entry.protocol } : {}), ...(entry.host ? { host: entry.host } : {}) }));
    }));
  }
  return undefined;
}
