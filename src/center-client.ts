// ponytail: central-server mode client. All room state lives on the central
// server (CHAT_ROOM_SERVER_URL); this machine self-pushes queue notifications
// to its own embedded server (localhost is always reachable from the same
// process, so no cross-host serverUrl or firewall setup is needed).
import RoomService, {
  type Message,
  type Participant,
  type Room,
} from "./room-service";
import {
  authHeader,
  formatNotificationLines,
  formatRoom,
  identity,
  NOTIFY_INSTRUCTION,
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
        { sessionID, participantId: me, participantName: me },
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
    if (items.length === 0) {
      return;
    }
    const byRoom = new Map<string, InboxItem[]>();
    for (const it of items) {
      const list = byRoom.get(it.roomId) ?? [];
      list.push(it);
      byRoom.set(it.roomId, list);
    }
    const auth = authHeader();
    const base = selfServerUrl.replace(/\/+$/, "");
    for (const [roomId, roomItems] of byRoom) {
      const { lines, capped } = formatNotificationLines(roomItems);
      const prompt = `<notification>\nNew messages in room ${roomItems[0]!.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`;
      const res = await fetch(`${base}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({ prompt, delivery: "queue" }),
      });
      // ponytail: a capped push must not advance the watermark — the
      // folded-out messages would become permanently unreadable; the
      // uncapped poll/inbox path remains the lossless catch-up
      if (res.ok && !capped) {
        const maxTs = roomItems.reduce(
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
  } catch {
    // best-effort: next check retries
  } finally {
    inboxChecks.delete(sessionID);
  }
}
