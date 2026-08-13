// ponytail: central chat-room server. Single HTTP service holding the
// authoritative rooms.json/registry.json; plugins (central mode) talk to it
// via CHAT_ROOM_SERVER_URL. Optional bearer token (CHAT_ROOM_SERVER_TOKEN).
import RoomService, { RoomError, type Room } from "../src/room-service";
import {
  enqueue,
  loadRegistry,
  loadRooms,
  saveRegistry,
  saveRooms,
} from "../src/store";

const port = Number(process.env.CHAT_ROOM_SERVER_PORT ?? 4399);
const token = process.env.CHAT_ROOM_SERVER_TOKEN;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const serializeRoom = (r: Room) => ({
  id: r.id,
  name: r.name,
  ownerId: r.ownerId,
  createdAt: r.createdAt,
  participants: [...r.participants.values()],
  messages: r.messages,
});

async function mutate<T>(
  fn: (svc: RoomService) => T | Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const svc = new RoomService();
    svc.hydrate(await loadRooms());
    const result = await fn(svc);
    await saveRooms(svc);
    return result;
  });
}

async function read<T>(fn: (svc: RoomService) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const svc = new RoomService();
    svc.hydrate(await loadRooms());
    return fn(svc);
  });
}

async function handle(req: Request): Promise<Response> {
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/rooms") {
      const rooms = await read((svc) => svc.listRooms());
      return json(rooms.map(serializeRoom));
    }
    if (req.method === "POST" && p === "/rooms") {
      const body = (await req.json()) as Record<string, string>;
      const name = body.name?.trim();
      if (!name) {
        return json({ error: "name is required" }, 400);
      }
      const owner = body.ownerId ?? "owner";
      const room = await mutate(async (svc) => {
        const created = svc.createRoom(name, owner);
        if (body.sessionID) {
          const reg = await loadRegistry();
          const regRoom = (reg[created.id] = reg[created.id] ?? {});
          regRoom[body.sessionID] = {
            // ponytail: central mode self-pulls the inbox; no cross-host URL
            serverUrl: "",
            apiPrefix: "/api",
            name: owner,
            lastReadTs: Date.now(),
          };
          await saveRegistry(reg);
        }
        return created;
      });
      return json(serializeRoom(room), 201);
    }
    if (req.method === "GET" && p === "/inbox") {
      const sessionID = url.searchParams.get("sessionID") ?? "";
      const roomFilter = url.searchParams.get("roomId");
      const items = await read(async (svc) => {
        const reg = await loadRegistry();
        const out: unknown[] = [];
        for (const room of svc.listRooms()) {
          if (roomFilter && room.id !== roomFilter) {
            continue;
          }
          const entry = reg[room.id]?.[sessionID];
          if (!entry) {
            continue;
          }
          const lastRead = entry.lastReadTs ?? 0;
          for (const m of room.messages) {
            if (m.createdAt > lastRead && m.senderId !== entry.name) {
              out.push({
                roomId: room.id,
                roomName: room.name,
                senderId: m.senderId,
                text: m.text,
                createdAt: m.createdAt,
              });
            }
          }
        }
        return out;
      });
      return json(items);
    }
    if (req.method === "POST" && p === "/read") {
      const body = (await req.json()) as Record<string, unknown>;
      const ts = Number(body.ts ?? 0);
      await enqueue(async () => {
        const reg = await loadRegistry();
        const entry = reg[String(body.roomId)]?.[String(body.sessionID)];
        // ponytail: NaN would poison the watermark (all comparisons false)
        if (entry && Number.isFinite(ts)) {
          entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
          await saveRegistry(reg);
        }
      });
      return json({ ok: true });
    }
    const m = p.match(/^\/rooms\/([^/]+)\/(join|leave|messages)$/);
    if (m) {
      const roomId = decodeURIComponent(m[1]!);
      const body = (await req.json()) as Record<string, string>;
      const sessionID = body.sessionID ?? "";
      if (req.method === "POST" && m[2] === "join") {
        const room = await mutate(async (svc) => {
          const id = body.participantId ?? sessionID;
          const name = body.participantName ?? sessionID;
          svc.joinRoom(roomId, { id, name });
          const reg = await loadRegistry();
          const regRoom = (reg[roomId] = reg[roomId] ?? {});
          regRoom[sessionID] = {
            // ponytail: central mode self-pulls the inbox; no cross-host URL.
            // Re-join must not rewind the read watermark (unread messages
            // would be silently dropped); a first join starts at join time.
            serverUrl: "",
            apiPrefix: "/api",
            name,
            lastReadTs: regRoom[sessionID]?.lastReadTs ?? Date.now(),
          };
          await saveRegistry(reg);
          return svc.getRoom(roomId);
        });
        return json(serializeRoom(room), 201);
      }
      if (req.method === "POST" && m[2] === "leave") {
        await mutate(async (svc) => {
          const reg = await loadRegistry();
          const entry = reg[roomId]?.[sessionID];
          const participantId = entry?.name ?? sessionID;
          svc.leaveRoom(roomId, participantId);
          if (reg[roomId]) {
            delete reg[roomId][sessionID];
            if (Object.keys(reg[roomId]).length === 0) {
              delete reg[roomId];
            }
          }
          await saveRegistry(reg);
        });
        return json({ ok: true });
      }
      if (req.method === "POST" && m[2] === "messages") {
        const room = await mutate(async (svc) => {
          const reg = await loadRegistry();
          const sender = reg[roomId]?.[sessionID]?.name ?? sessionID;
          svc.sendMessage(roomId, sender, body.text ?? "");
          return svc.getRoom(roomId);
        });
        return json(serializeRoom(room), 201);
      }
    }
    const g = p.match(/^\/rooms\/([^/]+)$/);
    if (g && req.method === "GET") {
      const room = await read((svc) =>
        svc.getRoom(decodeURIComponent(g[1]!)),
      );
      return json(serializeRoom(room));
    }
    return json({ error: "not found" }, 404);
  } catch (err) {
    if (err instanceof RoomError) {
      return json(
        { error: err.message },
        err.code === "ROOM_NOT_FOUND" ? 404 : 409,
      );
    }
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default {
  port,
  fetch: handle,
};

console.log(
  `chat-room center listening on http://localhost:${port}${token ? " (token auth on)" : ""}`,
);
if (!token) {
  // ponytail: default is open — anyone who can reach the port can read/write
  // rooms; set CHAT_ROOM_SERVER_TOKEN before exposing beyond localhost
  console.warn(
    "chat-room center has NO token auth — set CHAT_ROOM_SERVER_TOKEN if this port is reachable from other hosts",
  );
}
