// ponytail: central-server mode client. All room state lives on the central
// server (CHAT_ROOM_SERVER_URL); this machine self-pushes queue notifications
// to its own embedded server (localhost is always reachable from the same
// process, so no cross-host serverUrl or firewall setup is needed).
import RoomService, {
  type Message,
  type Participant,
  type Room,
} from "./room-service";
import os from "node:os";
import {
  authHeader,
  formatNotificationLines,
  formatRoom,
  identity,
  NOTIFY_INSTRUCTION,
  SERVE_WAKE_PROMPT,
  timeOf,
} from "./store";

type Json = Record<string, unknown>;

function toRoom(r: Json): Room {
  const participants = new Map<string, Participant>();
  if (Array.isArray(r.participants)) {
    for (const p of r.participants as Participant[]) {
      if (p && typeof p.id === "string" && typeof p.name === "string") {
        participants.set(p.id, p);
      }
    }
  }
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    ownerId: String(r.ownerId ?? ""),
    createdAt: Number(r.createdAt ?? 0),
    participants,
    messages: Array.isArray(r.messages) ? (r.messages as Message[]) : [],
  };
}

function svcOf(room: Json): RoomService {
  const svc = new RoomService();
  svc.hydrate([toRoom(room)]);
  return svc;
}

type CenterOpts = { center: string; token: string };

async function request(
  opts: CenterOpts,
  path: string,
  method: string,
  body?: unknown,
): Promise<Json> {
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${opts.center}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // ponytail: don't hang the tool call on a dead center
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    throw new Error(String(data.error ?? `center error ${res.status}`));
  }
  return data;
}

export async function centerAction(
  opts: CenterOpts,
  args: {
    action: string;
    name?: string;
    roomId?: string;
    text?: string;
  },
  sessionID: string,
): Promise<string> {
  const { center, token } = opts;
  switch (args.action) {
    case "list": {
      const rooms = (await request(opts, "/rooms", "GET")) as unknown as Json[];
      if (!Array.isArray(rooms) || rooms.length === 0) {
        return "no rooms yet";
      }
      return rooms
        .map(
          (r) =>
            `${r.id} (${r.name}): ${
              Array.isArray(r.participants) ? r.participants.length : 0
            } members`,
        )
        .join("\n");
    }
    case "create": {
      if (!args.name?.trim()) {
        return "error: name is required";
      }
      const room = await request(opts, "/rooms", "POST", {
        name: args.name.trim(),
        ownerId: identity(),
        sessionID,
        // ponytail: ora-1 #2 — 记录归属主机，跨机 @-wake 只由所属机器唤醒
        host: os.hostname(),
      });
      return formatRoom(svcOf(room), toRoom(room));
    }
    case "join": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      const me = identity(args.name?.trim());
      const room = await request(
        opts,
        `/rooms/${encodeURIComponent(args.roomId)}/join`,
        "POST",
        {
          sessionID,
          participantId: me,
          participantName: me,
          // ponytail: ora-1 #2 — 记录归属主机，跨机 @-wake 只由所属机器唤醒
          host: os.hostname(),
        },
      );
      return formatRoom(svcOf(room), toRoom(room));
    }
    case "leave": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      await request(
        opts,
        `/rooms/${encodeURIComponent(args.roomId)}/leave`,
        "POST",
        { sessionID },
      );
      return `left room ${args.roomId}`;
    }
    case "members": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      const room = await request(
        opts,
        `/rooms/${encodeURIComponent(args.roomId)}`,
        "GET",
      );
      const svc = svcOf(room);
      const members = svc.getParticipants(toRoom(room).id);
      return members.length > 0
        ? members.map((m) => m.name).join("\n")
        : "no members";
    }
    case "send": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      if (!args.text?.trim()) {
        return "error: text is required";
      }
      const room = await request(
        opts,
        `/rooms/${encodeURIComponent(args.roomId)}/messages`,
        "POST",
        { sessionID, text: args.text.trim() },
      );
      const svc = svcOf(room);
      return `sent: ${args.text.trim()}\n${formatRoom(svc, toRoom(room))}`;
    }
    case "poll": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      const result = (await request(
        opts,
        `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(args.roomId)}&excludeSelf=0`,
        "GET",
      )) as unknown as { member: boolean; items: InboxItem[] };
      // ponytail: F6 — same gate as standalone: only members can read
      if (!result.member) {
        return "error: not joined";
      }
      const items = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) {
        return "no new messages";
      }
      const lines = items.map(
        (it) => `[${timeOf(it.createdAt)}] ${it.senderId}: ${it.text}`,
      );
      // ponytail: F7 — advance the watermark after the result is delivered
      // (fire-and-forget); a failure only repeats the messages, never loses
      const maxTs = items.reduce((mx, it) => Math.max(mx, it.createdAt), 0);
      void request(opts, "/read", "POST", {
        roomId: args.roomId,
        sessionID,
        ts: maxTs,
      }).catch(() => {});
      return lines.join("\n");
    }
    default:
      return "error: unknown action";
  }
}

type InboxItem = {
  roomId: string;
  roomName: string;
  senderId: string;
  text: string;
  createdAt: number;
};

// ponytail: overlapping hook+tool triggers must not double-deliver;
// per-session so a slow check for one session can't starve another
const inboxChecks = new Set<string>();

// ponytail: central mode has no cross-host push; each session pulls its inbox
// on every hook/tool call and self-pushes queue notifications (localhost).
// Items are grouped by room: a room's watermark advances only when every item
// in that room was pushed successfully, so a failed push is retried next time.
export async function checkCenterInbox(
  opts: CenterOpts,
  sessionID: string,
  selfServerUrl: string,
): Promise<void> {
  if (inboxChecks.has(sessionID)) {
    return;
  }
  inboxChecks.add(sessionID);
  try {
    const result = (await request(
      opts,
      `/inbox?sessionID=${encodeURIComponent(sessionID)}&excludeSelf=1`,
      "GET",
    )) as unknown as { member: boolean; items: InboxItem[] };
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length > 0) {
      await pushItemsToSession(opts, sessionID, items, selfServerUrl);
    }
  } catch {
    // best-effort: next check retries
  } finally {
    inboxChecks.delete(sessionID);
  }
}
// ponytail: push a batch of inbox items to one session (grouped per room —
// a room's watermark advances only when every item in it was pushed
// successfully, so a failed push is retried next time).
// Result: "delivered" = all 2xx; "unreachable" = connection refused or 404
// (the session's process is very likely gone — the only case worth spawning
// a replacement process for); "rejected" = server alive but refused (401/5xx
// — do NOT spawn, the session may live in another window).
export type PushResult = "delivered" | "unreachable" | "rejected";

// ponytail: in-process push dedupe — the 30s wake sweep and the per-hook
// inbox check must not deliver the same items twice; capped pushes (which
// deliberately don't advance the watermark) would otherwise re-notify every
// sweep forever (orc-1 #4)
const lastPushed = new Map<string, number>();

export async function pushItemsToSession(
  opts: CenterOpts,
  sessionID: string,
  items: InboxItem[],
  selfServerUrl: string,
): Promise<PushResult> {
  if (items.length === 0) {
    return "delivered";
  }
  const byRoom = new Map<string, InboxItem[]>();
  for (const it of items) {
    const list = byRoom.get(it.roomId) ?? [];
    list.push(it);
    byRoom.set(it.roomId, list);
  }
  const auth = authHeader();
  const base = selfServerUrl.replace(/\/+$/, "");
  let worst: PushResult = "delivered";
  for (const [roomId, roomItems] of byRoom) {
    const maxTs = roomItems.reduce(
      (mx, it) => Math.max(mx, it.createdAt),
      0,
    );
    const key = `${sessionID}|${roomId}`;
    if (maxTs <= (lastPushed.get(key) ?? 0)) {
      continue; // already pushed this content
    }
    if (lastPushed.size > 1000) {
      lastPushed.clear(); // ponytail: cap——防长驻进程无限增长
    }
    const { lines, capped } = formatNotificationLines(roomItems);
    const prompt = `<notification>\nNew messages in room ${roomItems[0]!.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`;
    // ponytail: network errors (e.g. connection refused — the session's
    // process has exited) count as push failure, NOT as a crash: a rejected
    // fetch here would abort the whole wake sweep and skip every other
    // session, and the @-wake spawn would never run
    let res: Response;
    try {
      res = await fetch(`${base}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({ prompt, delivery: "queue" }),
      });
    } catch {
      worst = "unreachable";
      continue;
    }
    // ponytail: a capped push must not advance the watermark — the
    // folded-out messages would become permanently unreadable; the
    // uncapped poll/inbox path remains the lossless catch-up
    if (res.ok) {
      if (capped) {
        lastPushed.set(key, maxTs);
      } else {
        // orc-3 #6——/read 失败时不得记 lastPushed：水位未推进，下次 sweep
        // 重推（否则推送成功但水位未动 → 推送路径对该批消息永久静默）
        const advanced = await request(opts, "/read", "POST", {
          roomId,
          sessionID,
          ts: maxTs,
        })
          .then(() => true)
          .catch(() => false);
        if (advanced) lastPushed.set(key, maxTs);
      }
    } else if (res.status === 404 || res.status === 400) {
      // 404 / 400 (Invalid session ID): 本进程/本 server 不持有该 session
      // ——已退出或从未在本机运行 → 视为 unreachable，可由 serve 唤起
      worst = "unreachable";
    } else {
      worst = "rejected";
    }
  }
  return worst;
}

// ponytail: in-plugin wake watcher — sweep all rooms on the central server,
// find sessions with unread messages, and self-push queue notifications to
// them (opencode wakes the session in-process; dead sessions just fail
// silently). Runs on a timer; the central server itself has no opencode
// knowledge, this is purely client-side.
let wakeChecking = false;

// ponytail: 纯进程内唤醒（去 spawn）——已退出进程的 session 不再拉起新
// 进程。若部署者配置了 CHAT_ROOM_WAKE_SERVE_URL（常驻 opencode serve），
// 对被 @ 的已退出 session 通过 serve 的 /session/:id/message 进程内唤起；
// serve 未配置/不可达 → 不唤醒（未读由水位保留，session 下次运行时 poll
// 自动拿到）
async function wakeViaServe(
  serveUrl: string,
  sessionID: string,
  opts: CenterOpts,
  prompt = SERVE_WAKE_PROMPT,
): Promise<boolean> {
  // ponytail: 与多窗口插件共用服务器原子去重，避免重复唤起同一 session
  try {
    const claim = (await fetch(`${opts.center}/wake-claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ sessionID }),
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json().catch(() => ({})))) as { ok?: boolean };
    if (!claim.ok) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const res = await fetch(
      `${serveUrl.replace(/\/+$/, "")}/session/${sessionID}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.ok;
  } catch {
    // serve 未启动/不可达——按用户要求不唤醒（无 spawn、无重试）
    return false;
  }
}

export async function wakeSessions(
  opts: CenterOpts,
  selfServerUrl: string,
  serveUrl = "",
): Promise<void> {
  if (wakeChecking) {
    return;
  }
  wakeChecking = true;
  try {
    // ponytail: 轻量摘要（orc-1 #5）——不下载全部房间历史
    const rooms = (await request(
      opts,
      "/rooms/summary",
      "GET",
    )) as unknown as Array<{ id: string; name: string; latestMsgTs: number }>;
    if (!Array.isArray(rooms)) {
      return;
    }
    for (const room of rooms) {
      try {
      const roomId = String(room.id ?? "");
      const latest = Number(room.latestMsgTs ?? 0);
      if (!roomId || latest === 0) {
        continue;
      }
      const reg = (await request(
        opts,
        `/rooms/${encodeURIComponent(roomId)}/registry`,
        "GET",
      )) as unknown as Record<
        string,
        { name: string; lastReadTs?: number; host?: string }
      >;
      if (!reg || typeof reg !== "object") {
        continue;
      }
      for (const [sessionID, entry] of Object.entries(reg)) {
        // ponytail: 网页/模拟条目（host 空）不是 opencode 会话——不扫描
        // 不推送（否则死条目每 10s 一次 404 推送，永远 churn，orc-1 #7）
        if (!entry.host) {
          continue;
        }
        // ponytail: orc-2 #6——跨 host 条目由各自机器上的插件负责，本机
        // 扫描+推送只会 404（lastPushed 只在 res.ok 时设置，永不去重）
        if (entry.host !== os.hostname()) {
          continue;
        }
        // quick skip: nothing newer than this session's watermark
        if (latest <= (entry.lastReadTs ?? 0)) {
          continue;
        }
        const result = (await request(
          opts,
          `/inbox?sessionID=${encodeURIComponent(sessionID)}&excludeSelf=1&timeout=0`,
          "GET",
        )) as unknown as { member: boolean; items: InboxItem[] };
        const items = Array.isArray(result.items) ? result.items : [];
        if (items.length > 0) {
          // ponytail: ora-1 #2 — @-wake 只由 session 归属主机执行；web 条目
          // （host 为空）与异机条目绝不 spawn（否则错机 spawn 一个不存在
          // 的 session，且 5 分钟 claim 窗口会挡住真正正确的那台机器）
          const pushed = await pushItemsToSession(
            opts,
            sessionID,
            items,
            selfServerUrl,
          );
          if (pushed === "delivered") {
            // ponytail: 进程内自推成功 = 该 session 真实活跃——上报服务器，
            // 避免服务器 serve 双唤起
            void request(opts, "/active", "POST", { sessionID }).catch(
              () => {},
            );
          }
          // 被 @ 的已退出 session：serve 配置了才唤起（进程内，零 spawn）。
          // 唤起成功即推进水位——消息已进入该 session 的对话（不丢），
          // 避免同一未读反复唤起导致循环回复。
          // 仅唤起本机 opencode session（host === 本机主机名）——web 条目
          // 与 curl 模拟成员（host 空）没有可恢复的 opencode 会话
          if (
            pushed === "unreachable" &&
            serveUrl &&
            entry.host === os.hostname()
          ) {
            const mentioned = items.some((it) => {
              if (it.text.includes(`<at>@${entry.name}</at>`)) return true;
              const esc = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              return new RegExp(`@${esc}(?![\\p{L}\\p{N}_])`, "u").test(
                it.text,
              );
            });
            if (mentioned) {
              // ponytail: orc-2 #1——唤起 prompt 必须带未读消息内容（镜像
              // 服务器路径），否则 agent poll 时已无未读（水位已推进），
              // @ 内容永远不达；水位推进到 maxTs 因此是安全的
              const content = items
                .map((it) => `[${it.senderId}]: ${it.text}`)
                .join("\n");
              const woke = await wakeViaServe(
                serveUrl,
                sessionID,
                opts,
                `${SERVE_WAKE_PROMPT}\n\n未读消息：\n${content}`,
              );
              if (woke) {
                const maxTs = items.reduce(
                  (mx, it) => Math.max(mx, it.createdAt),
                  0,
                );
                await request(opts, "/read", "POST", {
                  roomId,
                  sessionID,
                  ts: maxTs,
                }).catch(() => {});
              }
            }
          }
        }
      }
      } catch {
        // ponytail: orc-3 #4——单房间错误（registry/inbox 请求失败）只跳过
        // 该房间，不中止整个 sweep
      }
    }
  } catch {
    // best-effort: next sweep retries
  } finally {
    wakeChecking = false;
  }
}
