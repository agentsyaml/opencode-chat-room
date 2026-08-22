// ponytail: central-server mode client. All room state lives on the central
// server (CHAT_ROOM_SERVER_URL); this machine pushes queue notifications to
// sessions owned by this OpenCode process before using an HTTP fallback.
import { OpencodeClient } from "@opencode-ai/sdk/v2";
import RoomService, {
  type Message,
  type Participant,
  type Room,
} from "./room-service";
import os from "node:os";
import {
  authHeader,
  formatServeWakePrompt,
  formatNotificationLines,
  formatRoom,
  identity,
  NOTIFY_INSTRUCTION,
  timeOf,
} from "./store";
import {
  admissionMatches,
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  pendingAdmission,
  rejectPendingAdmission,
  type QueueBody,
  type QueueItem,
  type PendingAdmission,
} from "./queue";
export { queueAdmissionId } from "./queue";

type Json = Record<string, unknown>;

const LOCAL_SERVER_URL = "http://localhost:4096";

export type PushResult = "delivered" | "unreachable" | "rejected";

export type QueueTransport = {
  client?: OpencodeClient;
  serverUrl?: string;
  directory?: string;
};

type QueueTransportInput = {
  client?: unknown;
  directory?: string;
  serverUrl?: URL | string;
};

// Compatibility bridge for OpenCode 1.18.16. The plugin exposes the embedded
// transport through a private field; HTTP remains the compatibility fallback.
export function createQueueTransport(
  input: QueueTransportInput = {},
): QueueTransport {
  const raw =
    input.client && typeof input.client === "object"
      ? (input.client as { _client?: unknown })._client
      : undefined;
  let client: OpencodeClient | undefined;
  if (raw !== undefined && raw !== null) {
    try {
      type ClientArgs = NonNullable<ConstructorParameters<typeof OpencodeClient>[0]>;
      client = new OpencodeClient({
        client: raw as NonNullable<ClientArgs["client"]>,
      });
    } catch {
      client = undefined;
    }
  }
  const serverUrl = String(input.serverUrl ?? "").trim();
  return {
    client,
    serverUrl: serverUrl || LOCAL_SERVER_URL,
    directory: input.directory,
  };
}

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

type CenterOpts = { center: string; token: string; directory?: string };

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
        directory: opts.directory,
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
          directory: opts.directory,
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
      })
        .then(() => clearPendingAdmission(sessionID, args.roomId!, maxTs))
        .catch(() => {});
      return lines.join("\n");
    }
    default:
      return "error: unknown action";
  }
}

type InboxItem = QueueItem & {
  roomId: string;
  roomName: string;
};

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

function queueBody(admissionID: string, text: string): QueueBody {
  return {
    id: admissionID,
    prompt: { text },
    delivery: "queue",
    resume: true,
  };
}

function statusOf(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.status === "number") {
    return value.status;
  }
  if (isRecord(value.response) && typeof value.response.status === "number") {
    return value.response.status;
  }
  if (isRecord(value.cause) && typeof value.cause.status === "number") {
    return value.cause.status;
  }
  return undefined;
}

function httpHeaders(transport: QueueTransport): Record<string, string> {
  const auth = authHeader();
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: auth } : {}),
    ...(transport.directory
      ? { "x-opencode-directory": encodeURIComponent(transport.directory) }
      : {}),
  };
}

async function sendQueueInProcess(
  client: OpencodeClient,
  sessionID: string,
  body: QueueBody,
): Promise<PushResult> {
  let result: unknown;
  try {
    result = await client.v2.session.prompt(
      { sessionID, ...body },
      { responseStyle: "fields", signal: AbortSignal.timeout(10_000) },
    );
  } catch (error) {
    const status = statusOf(error);
    return status === undefined || status === 404
      ? "unreachable"
      : "rejected";
  }
  if (!isRecord(result)) {
    return "unreachable";
  }
  if (!isRecord(result.response)) {
    if (admissionMatches(result, body, sessionID)) {
      return "delivered";
    }
    return "unreachable";
  }
  const status = result.response.status;
  if (typeof status !== "number") {
    return "unreachable";
  }
  if (status === 404) {
    return "unreachable";
  }
  if (status < 200 || status >= 300) {
    return "rejected";
  }
  return admissionMatches(result.data, body, sessionID)
    ? "delivered"
    : "rejected";
}

async function sendQueueHttp(
  transport: QueueTransport,
  sessionID: string,
  body: QueueBody,
): Promise<PushResult> {
  const base = (transport.serverUrl || LOCAL_SERVER_URL).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(
      `${base}/api/session/${encodeURIComponent(sessionID)}/prompt`,
      {
        method: "POST",
        headers: httpHeaders(transport),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return "unreachable";
  }
  const data = await response.json().catch(() => undefined);
  if (response.status === 404) {
    return "unreachable";
  }
  if (!response.ok) {
    return "rejected";
  }
  return admissionMatches(data, body, sessionID) ? "delivered" : "rejected";
}

export async function sendQueue(
  transport: QueueTransport,
  sessionID: string,
  text: string,
  admissionID: string,
): Promise<PushResult> {
  const body = queueBody(admissionID, text);
  if (transport.client) {
    const result = await sendQueueInProcess(transport.client, sessionID, body);
    if (result !== "unreachable") {
      return result;
    }
  }
  return sendQueueHttp(transport, sessionID, body);
}

// Overlapping hook and tool triggers must not double-deliver; keep the lock
// per session so a slow check cannot starve another session.
const inboxChecks = new Set<string>();

export async function checkCenterInbox(
  opts: CenterOpts,
  sessionID: string,
  transport: QueueTransport,
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
      await pushItemsToSession(opts, sessionID, items, transport);
    }
  } catch {
    // best-effort: next check retries
  } finally {
    inboxChecks.delete(sessionID);
  }
}

// Items are grouped by room. A room watermark advances only after queue
// admission and a successful /read, so failures remain retryable.
const lastPushed = new Map<string, number>();

export async function pushItemsToSession(
  opts: CenterOpts,
  sessionID: string,
  items: InboxItem[],
  transport: QueueTransport,
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
  let worst: PushResult = "delivered";
  for (const [roomId, roomItems] of byRoom) {
    const maxTs = roomItems.reduce(
      (mx, it) => Math.max(mx, it.createdAt),
      0,
    );
    const key = `${sessionID}|${roomId}`;
    const existing = pendingAdmission(sessionID, roomId);
    if (existing?.state === "admitted") {
      if (existing.capped) {
        if (maxTs <= existing.maxTs) {
          continue;
        }
      } else if (existing.maxTs <= 0) {
        continue;
      } else {
        const advanced = await request(opts, "/read", "POST", {
          roomId,
          sessionID,
          ts: existing.maxTs,
        })
          .then(() => true)
          .catch(() => false);
        if (advanced) {
          lastPushed.set(key, existing.maxTs);
          clearPendingAdmission(sessionID, roomId, existing.maxTs);
        }
        continue;
      }
    }
    if (!existing && maxTs <= (lastPushed.get(key) ?? 0)) {
      continue;
    }
    if (lastPushed.size > 1000) {
      lastPushed.clear();
    }
    const { lines, capped } = formatNotificationLines(roomItems);
    const prompt = `<notification>\nNew messages in room ${roomItems[0]!.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`;
    const admission = getOrCreatePendingAdmission(
      sessionID,
      roomId,
      roomItems,
      prompt,
      maxTs,
      capped,
    );
    const result = await sendQueue(
      transport,
      sessionID,
      admission.prompt,
      admission.id,
    );
    if (result !== "delivered") {
      if (result === "rejected") {
        rejectPendingAdmission(sessionID, roomId, admission.id);
      }
      if (result === "rejected" || worst === "delivered") {
        worst = result;
      }
      continue;
    }
    markPendingAdmissionAdmitted(sessionID, roomId, admission.id);
    void request(opts, "/active", "POST", { sessionID }).catch(() => {});
    if (admission.capped || admission.maxTs <= 0) {
      continue;
    }
    const advanced = await request(opts, "/read", "POST", {
      roomId,
      sessionID,
      ts: admission.maxTs,
    })
      .then(() => true)
      .catch(() => false);
    if (advanced) {
      lastPushed.set(key, admission.maxTs);
      clearPendingAdmission(sessionID, roomId, admission.maxTs);
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

// No process is spawned here. A configured opencode serve is only a fallback
// for mentioned sessions that cannot be admitted by the current process.
async function wakeViaServe(
  serveUrl: string,
  sessionID: string,
  roomId: string,
  opts: CenterOpts,
  transport: QueueTransport,
  admission: PendingAdmission,
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
  const result = await sendQueue(
    { ...transport, client: undefined, serverUrl: serveUrl },
    sessionID,
    admission.prompt,
    admission.id,
  );
  if (result === "delivered") {
    void request(opts, "/active", "POST", { sessionID }).catch(() => {});
    markPendingAdmissionAdmitted(sessionID, roomId, admission.id);
  } else if (result === "rejected") {
    rejectPendingAdmission(sessionID, roomId, admission.id);
  }
  return result === "delivered";
}

export async function wakeSessions(
  opts: CenterOpts,
  transport: QueueTransport,
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
        {
          name: string;
          lastReadTs?: number;
          host?: string;
          directory?: string;
        }
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
          `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(roomId)}&excludeSelf=1&timeout=0`,
          "GET",
        )) as unknown as { member: boolean; items: InboxItem[] };
        const items = Array.isArray(result.items)
          ? result.items.filter((item) => item.roomId === roomId)
          : [];
        if (items.length > 0) {
          const targetTransport = {
            ...transport,
            directory: entry.directory ?? transport.directory,
          };
          // ponytail: ora-1 #2 — @-wake 只由 session 归属主机执行；web 条目
          // （host 为空）与异机条目绝不 spawn（否则错机 spawn 一个不存在
          // 的 session，且 5 分钟 claim 窗口会挡住真正正确的那台机器）
          const pushed = await pushItemsToSession(
            opts,
            sessionID,
            items,
            targetTransport,
          );
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
              const { lines, capped } = formatNotificationLines(items);
              const prompt = formatServeWakePrompt(
                items[0]!.roomName,
                lines,
              );
              const maxTs = items.reduce(
                (mx, it) => Math.max(mx, it.createdAt),
                0,
              );
              const admission = getOrCreatePendingAdmission(
                sessionID,
                roomId,
                items,
                prompt,
                maxTs,
                capped,
              );
              const woke = await wakeViaServe(
                serveUrl,
                sessionID,
                roomId,
                opts,
                targetTransport,
                admission,
              );
              if (woke && !admission.capped && admission.maxTs > 0) {
                const advanced = await request(opts, "/read", "POST", {
                  roomId,
                  sessionID,
                  ts: admission.maxTs,
                })
                  .then(() => true)
                  .catch(() => false);
                if (advanced) {
                  clearPendingAdmission(sessionID, roomId, admission.maxTs);
                }
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
