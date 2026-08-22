// ponytail: central chat-room server. Single HTTP service holding the
// authoritative rooms.json/registry.json; plugins (central mode) talk to it
// via CHAT_ROOM_SERVER_URL. Optional bearer token (CHAT_ROOM_SERVER_TOKEN).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import RoomService, {
  RoomError,
  type Message,
  type Room,
} from "../src/room-service";
import {
  authHeader,
  enqueue,
  formatServeWakePrompt,
  formatNotificationLines,
  loadRegistry,
  loadRooms,
  saveRegistry,
  saveRooms,
  type RegistryEntry,
} from "../src/store";
import {
  admissionMatches,
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  rejectPendingAdmission,
  type QueueBody,
  type QueueItem,
} from "../src/queue";

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

// ponytail: cross-process wake dedupe — multiple opencode windows all run the
// 10s wake sweep, and their per-process spawn windows don't see each other;
// the server claims the wake atomically so only one window spawns per session
// (generic coordination, no opencode assumption)
const wakeClaims = new Map<string, number>();
const WAKE_CLAIM_MS = 30 * 1000;

function claimWake(sessionID: string): boolean {
  const now = Date.now();
  const last = wakeClaims.get(sessionID) ?? 0;
  if (now - last < WAKE_CLAIM_MS) {
    return false;
  }
  wakeClaims.set(sessionID, now);
  return true;
}

// ponytail: 活跃心跳（内存）——任何活跃操作（inbox/read/send/join）都会刷
// 新；近 2 分钟活跃的会话由插件 queue 推送处理，服务器绝不 serve 双唤起。
// 内存态：服务器重启后短暂视为未活跃（可接受——重启场景罕见）
const activeSessions = new Map<string, number>();
const WAKE_INACTIVE_MS = 2 * 60 * 1000;

function touchActive(sessionID: string): void {
  if (sessionID) {
    activeSessions.set(sessionID, Date.now());
  }
}

// ponytail: 服务器消息触发唤起——只有 @ 点名了成员的消息才会唤起（用户
// 核心需求）。仅唤起本机（host === 服务器主机名）的已退出 opencode 成员：
// 服务器的 serve 只能恢复本机 session，异机 session 由该机插件定时器兜底。
// 水位在唤起成功后推进（prompt 已带消息内容——agent 无需 poll 到它，
// 也不会因先推进而在唤起失败时丢消息）。
async function wakeMentionedSessions(
  roomId: string,
  roomName: string,
  text: string,
  senderSessionID: string,
  triggeringMessage: Message,
): Promise<void> {
  if (!serveWakeUrl) {
    return;
  }
  const mentions = new Set<string>();
  for (const m of text.matchAll(/<at>@([^<]+)<\/at>/g)) {
    mentions.add(m[1]!);
  }
  for (const m of text.matchAll(/@([\p{L}\p{N}_]+)/gu)) {
    // ponytail: mid-word 守卫（orc-1）——email/URL 里的 @token 不算提及。
    // 用 ASCII 词字符（与客户端 picker 的 ASCII_WORD 一致，orc-2 #5）：
    // 中文前缀（你好@小明）正常触发，dev@bob 不触发
    const at = m.index ?? 0;
    if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1] ?? "")) continue;
    mentions.add(m[1]!);
  }
  if (mentions.size === 0) {
    return; // 未 @ 任何人——不唤起（核心需求）
  }
  const reg = await enqueue(async () => {
    const r = await loadRegistry();
    return r[roomId] ?? {};
  });
  const now = Date.now();
  for (const [sid, entry] of Object.entries(reg)) {
    if (
      sid === senderSessionID ||
      !mentions.has(entry.name) || // 只唤起被 @ 点名的人
      entry.host !== os.hostname() || // 只唤起本机 session（serve 只能恢复本机）
      (activeSessions.get(sid) ?? 0) > now - WAKE_INACTIVE_MS // 活跃中——插件推送处理
    ) {
      continue;
    }
    if (!claimWake(sid)) {
      continue; // 30s 窗口内已唤起过
    }
    void (async () => {
      try {
        // orc-3 #2——带该 session 的全部未读（含更早的），水位推进到
        // maxTs；否则更早未读被标记已读但从未投递（插件 sweep 也会因
        // 水位已推进而跳过——永久丢失）
        const inbox = await readInbox(sid, roomId, true);
        const triggerItem: InboxItem = {
          id: triggeringMessage.id,
          roomId,
          roomName,
          senderId: triggeringMessage.senderId,
          text: triggeringMessage.text,
          createdAt: triggeringMessage.createdAt,
        };
        const items = inbox.items.some((item) => item.id === triggerItem.id)
          ? inbox.items
          : [...inbox.items, triggerItem].sort(
              (a, b) => a.createdAt - b.createdAt,
            );
        const { lines, capped } = formatNotificationLines(items);
        const prompt = formatServeWakePrompt(roomName, lines);
        const maxTs = items.reduce(
          (mx, it) => Math.max(mx, it.createdAt),
          0,
        );
        const admissionItems: QueueItem[] = items;
        const admission = getOrCreatePendingAdmission(
          sid,
          roomId,
          admissionItems,
          prompt,
          maxTs,
          capped,
        );
        const body: QueueBody = {
          id: admission.id,
          prompt: { text: admission.prompt },
          delivery: "queue",
          resume: true,
        };
        const confirmRead = async (): Promise<boolean> =>
          enqueue(async () => {
            const r = await loadRegistry();
            const e = r[roomId]?.[sid];
            if (!e) {
              return false;
            }
            e.lastReadTs = Math.max(e.lastReadTs ?? 0, admission.maxTs);
            await saveRegistry(r);
            return true;
          });
        if (admission.state === "admitted") {
          if (admission.capped) {
            if (maxTs <= admission.maxTs) {
              return;
            }
          } else {
            if (admission.maxTs > 0 && (await confirmRead())) {
              clearPendingAdmission(sid, roomId, admission.maxTs);
            }
            return;
          }
        }
        const directory =
          (entry as RegistryEntry & { directory?: string }).directory ??
          process.env.OPENCODE_DIRECTORY;
        const auth = authHeader();
        const res = await fetch(
          `${serveWakeUrl.replace(/\/+$/, "")}/api/session/${encodeURIComponent(sid)}/prompt`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(auth ? { Authorization: auth } : {}),
              ...(directory
                ? { "x-opencode-directory": encodeURIComponent(directory) }
                : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const data = await res.json().catch(() => undefined);
        if (res.status >= 200 && res.status < 300 && admissionMatches(data, body, sid)) {
          markPendingAdmissionAdmitted(sid, roomId, admission.id);
          touchActive(sid);
          if (!admission.capped && admission.maxTs > 0 && (await confirmRead())) {
            clearPendingAdmission(sid, roomId, admission.maxTs);
          }
        } else if (res.status !== 404) {
          rejectPendingAdmission(sid, roomId, admission.id);
        }
      } catch {
        // serve 不可达——静默，插件 10s 定时器兜底
      }
    })();
  }
}

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

type InboxItem = {
  id: string;
  roomId: string;
  roomName: string;
  senderId: string;
  text: string;
  createdAt: number;
};
type InboxResult = { member: boolean; items: InboxItem[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: short enqueue per check (writes are never blocked by a long poll)
async function readInbox(
  sessionID: string,
  roomFilter: string | null,
  excludeSelf: boolean,
): Promise<InboxResult> {
  // 注意：这里绝不 touchActive——插件 10s 扫描也会调 inbox（把已退出
  // session 误标活跃会让消息触发唤起失效）
  return read(async (svc) => {
    const reg = await loadRegistry();
    const out: InboxItem[] = [];
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
        const isSelf =
          m.senderSessionID !== undefined
            ? m.senderSessionID === sessionID
            : m.senderId === entry.name;
        if (
          m.createdAt > lastRead &&
          (!excludeSelf || !isSelf)
        ) {
          out.push({
            id: m.id,
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
}

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
          const regRoom = (reg[created.id] =
            reg[created.id] ?? Object.create(null) as Record<string, RegistryEntry>);
          regRoom[body.sessionID] = {
            // ponytail: central mode self-pulls the inbox; no cross-host URL
            serverUrl: "",
            apiPrefix: "/api",
            name: owner,
            directory: body.directory || undefined,
            // ora-1 #2: 归属主机——跨机 @-wake 只由所属机器执行
            host: body.host ?? "",
            lastReadTs: Math.max(
              Date.now(),
              created.messages.at(-1)?.createdAt ?? 0,
            ),
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
      const ts = Number(body.ts ?? 0);
      const roomId = String(body.roomId ?? "");
      const sessionID = String(body.sessionID ?? "");
      touchActive(sessionID); // poll 推进 = 活跃
      await enqueue(async () => {
        const reg = await loadRegistry();
        const entry = reg[roomId]?.[sessionID];
        // ponytail: NaN would poison the watermark (all comparisons false)
        if (entry && Number.isFinite(ts)) {
          entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
          await saveRegistry(reg);
          clearPendingAdmission(sessionID, roomId, ts);
        }
      });
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
      const ok = await enqueue(async () => claimWake(sessionID));
      return json({ ok });
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
          touchActive(sessionID); // join = 活跃
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
            name,
            directory: body.directory || undefined,
            // ora-1 #2: 归属主机——跨机 @-wake 只由所属机器执行
            host: body.host ?? "",
            lastReadTs:
              regRoom[sessionID]?.lastReadTs ??
              Math.max(Date.now(), latestMessageTs),
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
          svc.sendMessage(roomId, sender, text, sessionID);
          return svc.getRoom(roomId);
        });
        touchActive(sessionID); // 发送者活跃
        // ponytail: 即时唤起——仅 @ 点名成员时（核心需求）
        const sent = room.messages.at(-1);
        if (sent) {
          void wakeMentionedSessions(
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
      const reg = await enqueue(async () => {
        const registry = await loadRegistry();
        const entries = registry[roomId] ?? {};
        return Object.fromEntries(
          Object.entries(entries).map(([sid, e]) => [
            sid,
            {
              name: e.name,
              lastReadTs: e.lastReadTs ?? 0,
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
