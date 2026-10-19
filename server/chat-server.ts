// ponytail: central chat-room server. Single HTTP service holding the
// authoritative SQLite room database; plugins (central mode) talk to it
// via CHAT_ROOM_SERVER_URL. Optional bearer token (CHAT_ROOM_SERVER_TOKEN).
import { promises as fs } from "node:fs";
import path from "node:path";
import RoomService, {
  RoomError,
  type Message,
  type Room,
} from "../src/room-service";
import { readState, writeState, type Registry, type RegistryEntry } from "../src/store";
import {
  admissionMatches,
  clearPendingAdmission,
} from "../src/queue";
import { readInbox } from "./inbox";
import { isReceiverOwnerID } from "../src/receiver-owner";
import { claimWake, touchActive, wakeMentionedSessions } from "./wake";
import { historyRoute } from "./history-route";

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid server port "${value}": expected an integer from 1 to 65535`,
    );
  }
  return port;
}

const hostname =
  process.env.CHAT_ROOM_SERVER_HOST ?? process.env.HOST ?? "0.0.0.0";
const displayHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
const port = parsePort(
  process.env.CHAT_ROOM_SERVER_PORT ?? process.env.PORT ?? "4399",
);
const token = process.env.CHAT_ROOM_SERVER_TOKEN;

// ponytail: 部署者显式配置的 serve 地址——消息到达时立即唤起被 @ 的已退出
// session（零轮询延迟）；未配置则跳过（插件定时器兜底）。这是显式配置，
// 不是对 opencode 存在的假设
const serveWakeUrl = process.env.CHAT_ROOM_WAKE_SERVE_URL ?? "";

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
  messages: r.messages.map(({ senderSessionID: _senderSessionID, ...message }) => message),
});

function mutate<T>(fn: (svc: RoomService, registry: Registry) => T): Promise<T> {
  return writeState(fn);
}

function read<T>(fn: (svc: RoomService) => T): Promise<T> {
  return readState(fn);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Database callbacks finish synchronously before any HTTP or long-poll wait.
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method === "GET" && p === "/") {
    return Response.redirect(new URL("/chat", url).toString(), 302);
  }
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
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // ponytail: never cache the page — the UI is iterated often and the
        // server reads it fresh from disk on every request
        "Cache-Control": "no-store",
      },
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
    const history = await historyRoute(url);
    if (history) return history;
    if (req.method === "GET" && p === "/rooms/summary") {
      // ponytail: 轻量房间摘要（不含消息）——wakeSessions 每 10s 用它计算
      // latest，避免下载全部房间历史（orc-1 #5）
      const rooms = await read((svc) =>
        svc.listRooms().map((r) => ({
          id: r.id,
          name: r.name,
          latestMsgTs: r.messages.at(-1)?.createdAt ?? 0,
        })),
      );
      return json(rooms);
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
      const rooms = await read((svc) => svc.listRooms());
      return json(rooms.map(serializeRoom));
    }
    if (req.method === "POST" && p === "/rooms") {
      const body = (await req.json()) as Record<string, string>;
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
      const room = await mutate((svc, reg) => {
        const created = svc.createRoom(name, owner);
        if (body.sessionID) {
          const regRoom = (reg[created.id] =
            reg[created.id] ?? Object.create(null) as Record<string, RegistryEntry>);
          regRoom[body.sessionID] = {
            // ponytail: central mode self-pulls the inbox; no cross-host URL
            serverUrl: "",
            apiPrefix: "/api",
            ...(body.protocol === "v2" ? { protocol: "v2" as const } : {}),
            ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
            name: owner,
            directory: body.directory || undefined,
            // ora-1 #2: 归属主机——跨机 @-wake 只由所属机器执行
            host: body.host ?? "",
            lastReadTs: Math.max(
              Date.now(),
              created.messages.at(-1)?.createdAt ?? 0,
            ),
            lastQueuedTs: 0,
          };
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
      // long-poll: wait up to `timeout` ms for the first new message
      // instead of returning empty immediately (web chat + sub-agent
      // watchers); empty responses only happen on timeout
      const timeout = Math.min(
        Math.max(Number(url.searchParams.get("timeout") ?? 0) || 0, 0),
        30000,
      );
      const deadline = Date.now() + timeout;
      let result = await readInbox(sessionID, roomFilter, excludeSelf);
      while (result.items.length === 0 && Date.now() < deadline) {
        // ponytail: 2s between disk scans (orc-1 #7) — 1s × 25 iterations
        // doubles the file reads on shared-mount deployments
        await sleep(2000);
        result = await readInbox(sessionID, roomFilter, excludeSelf);
      }
      return json(result);
    }
    if (req.method === "POST" && p === "/read") {
      // ponytail: trusted-client-only — any caller can advance any session's
      // watermark (sessionIDs are unguessable UUIDs and never exposed);
      // accepted as a limitation until real session auth exists
      const body = (await req.json()) as Record<string, unknown>;
      const ts = Number(body.ts);
      const roomId = String(body.roomId ?? "");
      const sessionID = String(body.sessionID ?? "");
      if (
        body.ts === undefined ||
        body.ts === null ||
        !roomId ||
        !sessionID ||
        !Number.isFinite(ts)
      ) {
        return json({ error: "roomId/sessionID/finite ts are required" }, 400);
      }
      const updated = await writeState((_svc, reg) => {
        const entry = reg[roomId]?.[sessionID];
        if (!entry) {
          return false;
        }
        entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
        return true;
      });
      if (!updated) {
        return json({ error: "registry entry not found" }, 404);
      }
      clearPendingAdmission(sessionID, roomId, ts);
      touchActive(sessionID); // poll 推进 = 活跃
      return json({ ok: true });
    }
    if (req.method === "POST" && p === "/queued") {
      const body = (await req.json()) as Record<string, unknown>;
      const ts = Number(body.ts);
      const roomId = String(body.roomId ?? "");
      const sessionID = String(body.sessionID ?? "");
      if (
        body.ts === undefined ||
        body.ts === null ||
        !roomId ||
        !sessionID ||
        !Number.isFinite(ts)
      ) {
        return json({ error: "roomId/sessionID/finite ts are required" }, 400);
      }
      const updated = await writeState((_svc, reg) => {
        const entry = reg[roomId]?.[sessionID];
        if (!entry) {
          return false;
        }
        entry.lastQueuedTs = Math.max(entry.lastQueuedTs ?? 0, ts);
        return true;
      });
      if (!updated) {
        return json({ error: "registry entry not found" }, 404);
      }
      clearPendingAdmission(sessionID, roomId, ts);
      touchActive(sessionID);
      return json({ ok: true });
    }
    if (req.method === "POST" && p === "/active") {
      // ponytail: 活跃上报——插件对"进程内自推成功"的 session 调用（真实
      // 活跃）；服务器据此避免 serve 双唤起
      const body = (await req.json()) as Record<string, unknown>;
      touchActive(String(body.sessionID ?? ""));
      return json({ ok: true });
    }
    if (req.method === "POST" && p === "/wake-claim") {
      // ponytail: atomic cross-process wake dedupe (see claimWake) — the
      // server only arbitrates, it never spawns anything itself
      const body = (await req.json()) as Record<string, unknown>;
      const sessionID = String(body.sessionID ?? "");
      const ok = claimWake(sessionID);
      return json({ ok });
    }
    const m = p.match(/^\/rooms\/([^/]+)\/(join|leave|messages)$/);
    if (m) {
      const roomId = decodeURIComponent(m[1]!);
      const body = (await req.json()) as Record<string, string>;
      const sessionID = body.sessionID ?? "";
      if (req.method === "POST" && m[2] === "join") {
        if (body.protocol !== undefined && body.protocol !== "v2" || body.receiverOwnerID !== undefined && !isReceiverOwnerID(body.receiverOwnerID)) {
          return json({ error: "invalid receiver ownership" }, 400);
        }
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
        const room = await mutate((svc, reg) => {
          const regRoom = (reg[roomId] =
            reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
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
          const latestMessageTs =
            svc.getMessages(roomId).at(-1)?.createdAt ?? 0;
          regRoom[sessionID] = {
            // ponytail: central mode self-pulls the inbox; no cross-host URL.
            // Re-join must not rewind the read watermark (unread messages
            // would be silently dropped); a first join starts at join time.
            serverUrl: "",
            apiPrefix: "/api",
            ...(body.protocol === "v2" ? { protocol: "v2" as const } : {}),
            ...(prevEntry?.receiverOwnerID ? { receiverOwnerID: prevEntry.receiverOwnerID } : {}),
            ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
            name,
            directory: body.directory || undefined,
            // ora-1 #2: 归属主机——跨机 @-wake 只由所属机器执行
            host: body.host ?? "",
            lastQueuedTs: regRoom[sessionID]?.lastQueuedTs,
            lastReadTs:
              regRoom[sessionID]?.lastReadTs ??
              Math.max(Date.now(), latestMessageTs),
          };
          return svc.getRoom(roomId);
        });
        touchActive(sessionID); // join = active
        return json(serializeRoom(room), 201);
      }
      if (req.method === "POST" && m[2] === "leave") {
        await mutate((svc, reg) => {
          const entry = reg[roomId]?.[sessionID];
          const participantId = entry?.name ?? sessionID;
          // ponytail: orc-2 #2——共享名守卫：还有别的 session 持有同名时，
          // 只移除本 entry，不移除参与者（否则兄弟 tab 发送会 NOT_JOINED）
          const shared = Object.entries(reg[roomId] ?? {}).some(
            ([sid, e]) => e.name === participantId && sid !== sessionID,
          );
          if (!shared) {
            svc.leaveRoom(roomId, participantId);
            svc.addEvent(roomId, `${participantId} left the room`);
          }
          if (reg[roomId]) {
            delete reg[roomId][sessionID];
            if (Object.keys(reg[roomId]).length === 0) {
              delete reg[roomId];
            }
          }
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
        const room = await mutate((svc, reg) => {
          const sender = reg[roomId]?.[sessionID]?.name ?? sessionID;
          svc.sendMessage(roomId, sender, text, sessionID);
          return svc.getRoom(roomId);
        });
        touchActive(sessionID); // 发送者活跃
        // ponytail: 即时唤起——仅 @ 点名成员时（核心需求）
        const sent = room.messages.at(-1);
        if (sent) {
          void wakeMentionedSessions(
            serveWakeUrl,
            roomId,
            room.name,
            text,
            sessionID,
            sent,
          );
        }
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
    const r = p.match(/^\/rooms\/([^/]+)\/registry$/);
    if (r && req.method === "GET") {
      // ponytail: session registry for the in-plugin wake watcher — lets the
      // plugin find which sessions have unread messages without polling every
      // session's inbox; host is included for the @-wake ownership gate
      const roomId = decodeURIComponent(r[1]!);
      const reg = await readState((_svc, registry) => {
        const entries = registry[roomId] ?? {};
        return Object.fromEntries(
          Object.entries(entries).map(([sid, e]) => [
            sid,
            {
              name: e.name,
              protocol: e.protocol,
              receiverOwnerID: e.receiverOwnerID,
              lastReadTs: e.lastReadTs ?? 0,
              lastQueuedTs: e.lastQueuedTs ?? 0,
              host: e.host ?? "",
              directory: e.directory,
            },
          ]),
        );
      });
      return json(reg);
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
  hostname,
  port,
  fetch: handle,
  // ponytail: bun's default idleTimeout (10s) would close our long-poll
  // connections (25s) mid-request -> ERR_EMPTY_RESPONSE on every poll;
  // keep connections alive well past the longest long-poll window
  idleTimeout: 60,
};

console.log(
  `chat-room center listening on http://${displayHostname}:${port}${token ? " (token auth on)" : ""}`,
);
if (!token) {
  // ponytail: default is open — anyone who can reach the port can read/write
  // rooms; set CHAT_ROOM_SERVER_TOKEN before exposing beyond localhost
  console.warn(
    "chat-room center has NO token auth — set CHAT_ROOM_SERVER_TOKEN if this port is reachable from other hosts",
  );
}
