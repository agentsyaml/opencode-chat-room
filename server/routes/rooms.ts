// Room listing, creation, room snapshots and the session registry.
import { randomUUID } from "node:crypto";
import { readRoomSummaries, readState, writeState, type RegistryEntry } from "../../src/state/store.ts";
import { isReceiverOwnerID } from "../../src/state/receiver-owner.ts";
import { jsonObject } from "../json-body.ts";
import { roomPayload } from "../room-payload.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Only canonical non-negative decimal integers are accepted; URLSearchParams
// keeps values as strings, so "1.5", "1e2" and "" must not be coerced.
const integerParam = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export async function roomListRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/rooms/summary") {
    // Lightweight room summary without messages: wakeSessions polls this every
    // 10s to compute the latest sequence without downloading full histories.
    return json(await readRoomSummaries());
  }
  if (req.method === "GET" && p === "/receiver/memberships") {
    const ownerID = url.searchParams.get("ownerID");
    if (!isReceiverOwnerID(ownerID)) return json({ error: "invalid ownerID" }, 400);
    const sessionIDs = await readState((_svc, registry) => {
      return [...new Set(Object.values(registry).flatMap((entries) =>
        Object.entries(entries).filter(([, entry]) => entry.protocol === "v2" && entry.receiverOwnerID === ownerID).map(([id]) => id),
      ))];
    });
    return json({ sessionIDs });
  }
  if (req.method === "GET" && p === "/rooms") {
    const caller = url.searchParams.get("sessionID");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");
    // No page size with an offset; reject rather than silently ignoring it.
    if (limitParam === null && offsetParam !== null) return json({ error: "offset requires limit" }, 400);
    let limit: number | undefined;
    let offset = 0;
    if (limitParam !== null) {
      limit = integerParam(limitParam);
      if (limit === undefined || limit < 1 || limit > 200) return json({ error: "limit must be an integer between 1 and 200" }, 400);
      if (offsetParam !== null) {
        offset = integerParam(offsetParam) ?? -1;
        if (offset < 0) return json({ error: "offset must be a non-negative integer" }, 400);
      }
    }
    const rows = await readState((svc, registry) => svc.listRooms()
      .filter((room) => room.kind !== "direct" ? true : !!caller && room.directSessionIDs?.includes(caller))
      .map((room) => ({ room, entry: caller ? registry[room.id]?.[caller] : undefined })));
    // Without limit keep the legacy bare array and full list; with limit only
    // hydrate the room payloads on the requested page.
    const page = limit === undefined ? rows : rows.slice(offset, offset + limit);
    const rooms = [];
    for (const { room, entry } of page) {
      // The browser keeps its watermark per tab; a new tab starts from this one.
      rooms.push({ ...await roomPayload(room), joined: Boolean(entry), ...(entry?.lastReadTs ? { lastReadTs: entry.lastReadTs } : {}) });
    }
    if (limit === undefined) return json(rooms);
    const nextOffset = offset + rooms.length < rows.length ? offset + rooms.length : null;
    return json({ rooms, hasMore: nextOffset !== null, nextOffset });
  }
  return undefined;
}

export async function roomCreateRoute(req: Request, url: URL): Promise<Response | undefined> {
  if (!(req.method === "POST" && url.pathname === "/rooms")) return undefined;
  const body = await jsonObject<Record<string, string>>(req);
  if (!body) return json({ error: "JSON object body is required" }, 400);
  if (body.protocol !== undefined && body.protocol !== "v2" || body.receiverOwnerID !== undefined && !isReceiverOwnerID(body.receiverOwnerID)) {
    return json({ error: "invalid receiver ownership" }, 400);
  }
  const name = body.name?.trim();
  if (!name) {
    return json({ error: "name is required" }, 400);
  }
  if (name.length > 64) {
    return json({ error: "name too long (max 64)" }, 400);
  }
  const owner = (body.ownerId ?? "").trim() || "访客";
  if (owner.length > 64) {
    return json({ error: "ownerId too long (max 64)" }, 400);
  }
  if (body.joinPolicy !== undefined && body.joinPolicy !== "open" && body.joinPolicy !== "approval") {
    return json({ error: "joinPolicy must be open or approval" }, 400);
  }
  const joinPolicy = body.joinPolicy === "approval" ? "approval" : body.joinPolicy === "open" ? "open" : undefined;
  const room = await writeState((svc, reg) => {
    const created = svc.createRoom(name, owner, joinPolicy);
    if (body.sessionID) {
      const regRoom = (reg[created.id] =
        reg[created.id] ?? Object.create(null) as Record<string, RegistryEntry>);
      regRoom[body.sessionID] = {
        // ponytail: central mode self-pulls the inbox; no cross-host URL
        serverUrl: "",
        apiPrefix: "/api",
        membershipID: randomUUID(),
        ...(body.protocol === "v2" ? { protocol: "v2" as const } : {}),
        ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
        name: owner,
        directory: body.directory || undefined,
        // Owning host: cross-machine @-wake is executed only by the owner.
        host: body.host ?? "",
        lastReadTs: Math.max(
          Date.now(),
          created.messages.at(-1)?.createdAt ?? 0,
        ),
        lastQueuedTs: 0,
      };
      created.ownerMembershipID = regRoom[body.sessionID]!.membershipID;
    }
    return created;
  });
  return json(await roomPayload(room), 201);
}

export async function roomDetailRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const g = url.pathname.match(/^\/rooms\/([^/]+)$/);
  if (g && req.method === "GET") {
    const room = await readState((svc) =>
      svc.getRoom(decodeURIComponent(g[1]!)),
    );
    return json(await roomPayload(room));
  }
  const r = url.pathname.match(/^\/rooms\/([^/]+)\/registry$/);
  if (r && req.method === "GET") {
    // ponytail: session registry for the in-plugin wake watcher — lets the
    // plugin find which sessions have unread messages without polling every
    // session's inbox; host is included for the @-wake ownership gate
    const roomId = decodeURIComponent(r[1]!);
    const reg = await readState((svc, registry) => {
      const entries = registry[roomId] ?? {};
      return Object.fromEntries(
        Object.entries(entries).map(([sid, e]) => [
          sid,
          {
            name: e.name,
            membershipID: e.membershipID,
            protocol: e.protocol,
            receiverOwnerID: e.receiverOwnerID,
            lastReadTs: e.lastReadTs ?? 0,
            lastQueuedTs: e.lastQueuedTs ?? 0,
            host: e.host ?? "",
            directory: e.directory,
            roomKind: svc.getRoom(roomId).kind ?? "group",
          },
        ]),
      );
    });
    return json(reg);
  }
  return undefined;
}