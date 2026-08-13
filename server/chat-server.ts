// ponytail: central chat-room server. Single HTTP service holding the
// authoritative rooms.json/registry.json; plugins (central mode) talk to it
// via CHAT_ROOM_SERVER_URL. Optional bearer token (CHAT_ROOM_SERVER_TOKEN).
import { promises as fs } from "node:fs";
import path from "node:path";
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
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method === "GET" && p === "/chat") {
    // ponytail: the human-facing chat page; APIs stay token-gated, the page
    // itself is a static shell
    const html = await fs
      .readFile(path.join(import.meta.dir, "chat.html"), "utf8")
      .catch(() => null);
    if (html === null) {
      return json({ error: "chat page not found" }, 404);
    }
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  // ponytail: F1 — reject non-JSON POSTs; a text/plain simple request from a
  // malicious page would otherwise mutate rooms cross-origin (no preflight)
  if (
    req.method === "POST" &&
    !req.headers.get("content-type")?.includes("application/json")
  ) {
    return json({ error: "content-type must be application/json" }, 415);
  }
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return json({ error: "unauthorized" }, 401);
  }
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
      if (name.length > 64) {
        return json({ error: "name too long (max 64)" }, 400);
      }
      const owner = (body.ownerId ?? "").trim() || "访客";
      if (owner.length > 64) {
        return json({ error: "ownerId too long (max 64)" }, 400);
      }
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
      // ponytail: poll includes the caller's own messages (echo), the
      // notification self-pull excludes them — aligned with standalone poll
      const excludeSelf = url.searchParams.get("excludeSelf") === "1";
      const result = await read(async (svc) => {
        const reg = await loadRegistry();
        const out: unknown[] = [];
        let member = false;
        for (const room of svc.listRooms()) {
          if (roomFilter && room.id !== roomFilter) {
            continue;
          }
          const entry = reg[room.id]?.[sessionID];
          if (!entry) {
            continue;
          }
          member = true;
          const lastRead = entry.lastReadTs ?? 0;
          for (const m of room.messages) {
            if (m.createdAt > lastRead && (!excludeSelf || m.senderId !== entry.name)) {
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
        return { member, items: out };
      });
      return json(result);
    }
    if (req.method === "POST" && p === "/read") {
      // ponytail: trusted-client-only — any caller can advance any session's
      // watermark (sessionIDs are unguessable UUIDs and never exposed);
      // accepted as a limitation until real session auth exists
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
        // ponytail: F4/F5 — names must be non-empty, and re-joining under a
        // new name must retire the old participant (no ghost members)
        const id = (body.participantId ?? "").trim();
        const name = (body.participantName ?? "").trim();
        if (!id || !name || !sessionID) {
          return json(
            { error: "participantId/participantName/sessionID are required" },
            400,
          );
        }
        if (id.length > 64 || name.length > 64) {
          return json({ error: "name too long (max 64)" }, 400);
        }
        const room = await mutate(async (svc) => {
          const reg = await loadRegistry();
          const regRoom = (reg[roomId] = reg[roomId] ?? {});
          // retire the participant this session previously held, if renamed
          // — skipped when another session still uses the old name
          const prevEntry = regRoom[sessionID];
          if (prevEntry && prevEntry.name !== name) {
            const shared = Object.entries(regRoom).some(
              ([sid, e]) => sid !== sessionID && e.name === prevEntry.name,
            );
            if (!shared && svc.containsParticipant(roomId, prevEntry.name)) {
              svc.leaveRoom(roomId, prevEntry.name);
            }
          }
          const already = svc.containsParticipant(roomId, id);
          // ponytail: prune a stale registry entry for the same participant
          // name from another session (closed tab / cleared localStorage) —
          // but only when the identity is NOT already present, otherwise two
          // live sessions sharing a nickname would evict each other forever
          if (!already) {
            for (const [sid, e] of Object.entries(regRoom)) {
              if (sid !== sessionID && e.name === name) {
                delete regRoom[sid];
              }
            }
          }
          svc.joinRoom(roomId, { id, name });
          if (!already) {
            svc.addEvent(roomId, `${name} joined the room`);
          }
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
          svc.addEvent(roomId, `${participantId} left the room`);
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
        // ponytail: F3 — mirror the plugin's zod limit at the HTTP boundary
        const text = (body.text ?? "").trim();
        if (!text) {
          return json({ error: "text is required" }, 400);
        }
        if (text.length > 2000) {
          return json({ error: "text too long (max 2000)" }, 400);
        }
        const room = await mutate(async (svc) => {
          const reg = await loadRegistry();
          const sender = reg[roomId]?.[sessionID]?.name ?? sessionID;
          svc.sendMessage(roomId, sender, text);
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
