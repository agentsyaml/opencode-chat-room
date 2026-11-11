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
import { answerQuestion, sendReply, readQuestions, readState, writeState, type Registry, type RegistryEntry } from "../src/store";
import {
  admissionMatches,
  clearPendingAdmission,
} from "../src/queue";
import { readInbox } from "./inbox";
import { isReceiverOwnerID } from "../src/receiver-owner";
import { claimWake, touchActive, wakeMentionedSessions } from "./wake";
import { historyRoute } from "./history-route";
import { roomManagement } from "./newrooms";
import { memberRoutes } from "./member-routes";
import { resourceRoutes } from "./resource-routes";
import { maxResourceBytes } from "../src/resources";
import { adminRoutes } from "./admin-routes";
import { roomReminderRoutes, startRoomReminderScheduler } from "./room-reminders";

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
  messages: r.messages,
  kind: r.kind ?? "group",
  ...(r.directSessionIDs ? { directSessionIDs: r.directSessionIDs } : {}),
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
    const html = await fs
      .readFile(path.join(import.meta.dir, "chat.html"), "utf8")
      .catch(() => null);
    if (html === null) {
      return json({ error: "chat page not found" }, 404);
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  if (req.method === "GET" && p.startsWith("/assets/")) {
    let relative: string;
    try { relative = decodeURIComponent(p.slice("/assets/".length)); }
    catch { return json({ error: "invalid asset path" }, 400); }
    const root = path.resolve(import.meta.dir, "assets");
    const file = path.resolve(root, relative);
    if (!relative || !file.startsWith(`${root}${path.sep}`) || !/\.(?:css|js|mjs|svg|png|jpg|woff2?)$/i.test(file)) return json({ error: "not found" }, 404);
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return json({ error: "not found" }, 404);
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : /\.(?:js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "font/woff2";
    return new Response(data, { headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  // ponytail: F1 — reject non-JSON POSTs; a text/plain simple request from a
  // malicious page would otherwise mutate rooms cross-origin (no preflight)
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    !req.headers.get("content-type")?.includes("application/json") &&
    !(/^\/rooms\/[^/]+\/resources$/.test(p) && req.method === "POST")
  ) {
    return json({ error: "content-type must be application/json" }, 415);
  }
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const reminders = await roomReminderRoutes(req, url);
    if (reminders) return reminders;
    const admin = await adminRoutes(req, url); if (admin) return admin;
    const resource = await resourceRoutes(req, url);
    if (resource) return resource;
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
      const caller = url.searchParams.get("sessionID");
      const rooms = await readState((svc, registry) => svc.listRooms()
        .filter((room) => room.kind !== "direct" ? true : !!caller && room.directSessionIDs?.includes(caller))
        .map((room) => ({ ...serializeRoom(room), joined: Boolean(caller && registry[room.id]?.[caller]) })));
      return json(rooms);
    }
    const members = await memberRoutes(req, url);
    if (members) return members;
    const management = await roomManagement(req, url);
    if (management) return management;
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
      const afterValue = url.searchParams.get("afterTs");
      const afterTs = afterValue === null ? undefined : Number(afterValue);
      if (url.searchParams.has("afterTs") && (afterValue === "" || !/^\d+$/.test(afterValue ?? "") ||
        !Number.isSafeInteger(afterTs) || afterTs! < 0 || !roomFilter || url.searchParams.get("excludeSelf") !== "0")) {
        return json({ error: "afterTs requires a roomId and excludeSelf=0, with a non-negative safe integer value" }, 400);
      }
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
      let result = await readInbox(sessionID, roomFilter, excludeSelf, afterTs);
      while (result.items.length === 0 && Date.now() < deadline) {
        // ponytail: 2s between disk scans (orc-1 #7) — 1s × 25 iterations
        // doubles the file reads on shared-mount deployments
        await sleep(2000);
        result = await readInbox(sessionID, roomFilter, excludeSelf, afterTs);
      }
      return json(result);
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
      const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
      if (req.method === "POST" && m[2] === "join") {
        if (body.protocol !== undefined && body.protocol !== "v2" || body.receiverOwnerID !== undefined && !isReceiverOwnerID(body.receiverOwnerID)) {
          return json({ error: "invalid receiver ownership" }, 400);
        }
        // ponytail: F4/F5 — names must be non-empty, and re-joining under a
        // new name must retire the old participant (no ghost members)
        const id = typeof body.participantId === "string" ? body.participantId.trim() : "";
        const name = typeof body.participantName === "string" ? body.participantName.trim() : "";
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
          const currentRoom = svc.getRoom(roomId);
          const participantId = currentRoom.kind === "direct" ? sessionID : id;
          const regRoom = (reg[roomId] =
            reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
          // retire the participant this session previously held, if renamed
          // — skipped when another session still uses the old name
          const prevEntry = regRoom[sessionID];
          if (currentRoom.kind !== "direct" && prevEntry && prevEntry.name !== name) {
            const shared = Object.entries(regRoom).some(
              ([sid, e]) => sid !== sessionID && e.name === prevEntry.name,
            );
            if (!shared && svc.containsParticipant(roomId, prevEntry.name)) {
              svc.leaveRoom(roomId, prevEntry.name);
            }
          }
          const already = svc.containsParticipant(roomId, participantId);
          // ponytail: prune a stale registry entry for the same participant
          // name from another session (closed tab / cleared localStorage) —
          // but only when the identity is NOT already present, otherwise two
          // live sessions sharing a nickname would evict each other forever
          if (!already && currentRoom.kind !== "direct") {
            for (const [sid, e] of Object.entries(regRoom)) {
              if (sid !== sessionID && e.name === name) {
                delete regRoom[sid];
              }
            }
          }
          svc.joinRoom(roomId, { id: participantId, name });
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
            ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
            name,
            ...(prevEntry?.membershipID ? { membershipID: prevEntry.membershipID } : {}),
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
          const participantId = svc.getRoom(roomId).kind === "direct" ? sessionID : entry?.name ?? sessionID;
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
        const isQuestion = (body as Record<string, unknown>).isQuestion;
        if (isQuestion !== undefined && typeof isQuestion !== "boolean") return json({ error: "isQuestion must be a boolean" }, 400);
        // ponytail: F3 — mirror the plugin's zod limit at the HTTP boundary
        const text = (body.text ?? "").trim();
        if (!text) {
          return json({ error: "text is required" }, 400);
        }
        if (text.length > 2000) {
          return json({ error: "text too long (max 2000)" }, 400);
        }
        const replyTo = (body as Record<string, unknown>).replyToMessageID;
        if (replyTo !== undefined && (typeof replyTo !== "string" || !replyTo)) return json({ error: "replyToMessageID must be a non-empty message ID" }, 400);
        if (replyTo !== undefined) {
          const result = await sendReply(roomId, replyTo, sessionID, text);
          if (result.status !== "ok") {
            if (result.status === "missing") return json({ error: "room not found" }, 404);
            if (result.status === "target") return json({ error: "reply target not found in room" }, 404);
            if (result.status === "question") return json({ error: "use the question answers endpoint to reply to a question" }, 409);
            return json({ error: "session is not a room member" }, 409);
          }
          touchActive(sessionID);
          const room = await read((svc) => svc.getRoom(roomId));
          void wakeMentionedSessions(serveWakeUrl, roomId, room.name, text, sessionID, result.message);
          return json(serializeRoom(room), 201);
        }
        const room = await mutate((svc, reg) => {
          const senderEntry = reg[roomId]?.[sessionID];
          if (!senderEntry) throw new RoomError("NOT_JOINED", "session is not a room member");
          const sender = svc.getRoom(roomId).kind === "direct" ? sessionID : senderEntry.name;
          svc.sendMessage(roomId, sender, text, sessionID, isQuestion === true);
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
    const questions = p.match(/^\/rooms\/([^/]+)\/questions$/);
    if (req.method === "GET" && questions) {
      const roomId = decodeURIComponent(questions[1]!);
      const exists = await read((svc) => svc.listRooms().some((room) => room.id === roomId));
      if (!exists) return json({ error: "room not found" }, 404);
      return json({ questions: await readQuestions(roomId) });
    }
    const answer = p.match(/^\/rooms\/([^/]+)\/questions\/([^/]+)\/answers$/);
    if (req.method === "POST" && answer) {
      const roomId = decodeURIComponent(answer[1]!);
      const questionID = decodeURIComponent(answer[2]!);
      const body: unknown = await req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "sessionID and non-empty text (max 2000) are required" }, 400);
      const input = body as Record<string, unknown>;
      if (typeof input.sessionID !== "string" || !input.sessionID || typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 2000) return json({ error: "sessionID and non-empty text (max 2000) are required" }, 400);
      const result = await answerQuestion(roomId, questionID, input.sessionID, input.text.trim());
      if (result.status === "missing") return json({ error: "room not found" }, 404);
      if (result.status === "question") return json({ error: "question not found" }, 404);
      if (result.status === "member") return json({ error: "session is not a room member" }, 409);
      if (result.status === "answered") return json({ error: "question already answered" }, 409);
      if (result.status !== "ok") return json({ error: "question not found" }, 404);
      touchActive(input.sessionID);
      const room = await read((svc) => svc.getRoom(roomId));
      void wakeMentionedSessions(serveWakeUrl, roomId, room.name, result.answer.text, input.sessionID, result.answer);
      return json({ questionID, answer: result.answer }, 201);
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
    return json({ error: "not found" }, 404);
  } catch (err) {
    if (err instanceof SyntaxError) return json({ error: "invalid JSON body" }, 400);
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
  idleTimeout: 60,
  maxRequestBodySize: Math.max(128 * 1024 * 1024, maxResourceBytes()),
};

console.log(
  `chat-room center listening on http://${displayHostname}:${port}${token ? " (token auth on)" : ""}`,
);
startRoomReminderScheduler((roomId, roomName, text, message) => wakeMentionedSessions(serveWakeUrl, roomId, roomName, text, "", message));
if (!token) {
  console.warn(
    "chat-room center has NO token auth — set CHAT_ROOM_SERVER_TOKEN if this port is reachable from other hosts",
  );
}
