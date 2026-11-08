// Central mode room API client. Recipient runtimes poll the server and deliver
// inbox items through their host's supported notification transport.
import RoomService, {
  type Message,
  type Participant,
  type Room,
} from "./room-service";
import os from "node:os";
import {
  formatRoom,
  identity,
  timeOf,
} from "./store";
import {
  clearPendingAdmission,
} from "./queue";
import type { InboxItem } from "./center-inbox";
import { assertDeliveryLease } from "./session-delivery";
export { queueAdmissionId } from "./queue";
export { createQueueTransport, sendAsyncNotification, sendQueue } from "./queue-transport";
export type { QueueTransport, PushResult } from "./queue-transport";

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
    kind: r.kind === "direct" ? "direct" : "group",
    ...(Array.isArray(r.directSessionIDs) ? { directSessionIDs: r.directSessionIDs as string[] } : {}),
    participants,
    messages: Array.isArray(r.messages) ? (r.messages as Message[]) : [],
  };
}

function svcOf(room: Json): RoomService {
  const svc = new RoomService();
  svc.hydrate([toRoom(room)]);
  return svc;
}

export type CenterOpts = { center: string; token: string; directory?: string };

export async function request(
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
    throw Object.assign(new Error(String(data.error ?? `center error ${res.status}`)), { status: res.status });
  }
  return data;
}

export async function markQueued(
  opts: CenterOpts,
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<boolean> {
  assertDeliveryLease();
  return request(opts, "/queued", "POST", { roomId, sessionID, ts })
    .then(() => true)
    .catch(() => false);
}

export async function centerAction(
  opts: CenterOpts,
  args: {
    action: string;
    name?: string;
    roomId?: string;
    text?: string;
    announcementName?: string;
    content?: string;
    isQuestion?: boolean;
    receiverOwnerID?: string;
    protocol?: "v1" | "v2";
  },
  sessionID: string,
): Promise<string> {
  const { center, token } = opts;
  switch (args.action) {
    case "list": {
      const rooms = (await request(opts, `/rooms?sessionID=${encodeURIComponent(sessionID)}`, "GET")) as unknown as Json[];
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
        // Record the owning host so only that host wakes this session.
        host: os.hostname(),
        directory: opts.directory,
        ...(args.protocol === "v2" ? { protocol: "v2", receiverOwnerID: args.receiverOwnerID } : {}),
      });
      return formatRoom(svcOf(room), toRoom(room));
    }
    case "join": {
      if (!args.name?.trim()) {
        return "error: name is required to join a room";
      }
      if (!args.roomId) {
        return "error: roomId is required";
      }
      const me = identity(args.name.trim());
      const room = await request(
        opts,
        `/rooms/${encodeURIComponent(args.roomId)}/join`,
        "POST",
        {
          sessionID,
          participantId: me,
          participantName: me,
          // Record the owning host so only that host wakes this session.
          host: os.hostname(),
          directory: opts.directory,
          ...(args.protocol === "v2" ? { protocol: "v2", receiverOwnerID: args.receiverOwnerID } : {}),
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
    case "announcement_list":
    case "announcement_read":
    case "announcement_write":
    case "announcement_delete": {
      if (!args.roomId) return "error: roomId is required";
      if (args.action !== "announcement_list" && !args.announcementName) return "error: announcementName is required";
      const root = `/rooms/${encodeURIComponent(args.roomId)}/announcements`;
      if (args.action === "announcement_list") {
        const result = await request(opts, root, "GET") as { announcements: Array<{ name: string; content: string }> };
        return result.announcements.map((item) => `${item.name}: ${item.content}`).join("\n") || "no announcements";
      }
      const path = `${root}/${encodeURIComponent(args.announcementName!)}`;
      if (args.action === "announcement_read") {
        const result = await request(opts, path, "GET") as { announcement: { name: string; content: string } };
        return `${result.announcement.name}:\n${result.announcement.content}`;
      }
      if (args.action === "announcement_write") {
        if (typeof args.content !== "string") return "error: content is required";
        const result = await request(opts, path, "PUT", { sessionID, content: args.content }) as { announcement: { name: string; content: string } };
        return `announcement saved: ${result.announcement.name}`;
      }
      await request(opts, path, "DELETE", { sessionID });
      return `announcement deleted: ${args.announcementName}`;
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
        { sessionID, text: args.text.trim(), ...(args.isQuestion ? { isQuestion: true } : {}) },
      );
      const svc = svcOf(room);
      return `sent: ${args.text.trim()}\n${formatRoom(svc, toRoom(room))}`;
    }
    case "poll": {
      if (!args.roomId) {
        return "error: roomId is required";
      }
      let member: { membershipID?: string; receiverOwnerID?: string } | undefined;
      let legacyCenter = false;
      try {
        const registry = await request(opts, `/rooms/${encodeURIComponent(args.roomId)}/registry`, "GET") as Record<string, { membershipID?: string; receiverOwnerID?: string }>;
        member = registry[sessionID];
        legacyCenter = Boolean(member && !member.membershipID);
      } catch (error) { legacyCenter = (error as { status?: number }).status === 404; }
      const result = (await request(
        opts,
        `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(args.roomId)}&excludeSelf=0`,
        "GET",
      )) as unknown as { member: boolean; items: InboxItem[]; hasMore?: boolean };
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
      // ponytail: F7 — serialize the acknowledgment before returning so a
      // following action cannot race the read watermark update. A failure only
      // repeats the messages, never loses them.
      const maxTs = items.reduce((mx, it) => Math.max(mx, it.createdAt), 0);
      const exactIDs = items.map((item) => item.id);
      const body = {
        roomId: args.roomId,
        sessionID,
        ts: maxTs,
        ...(member?.membershipID && exactIDs.every((id) => typeof id === "string" && id)
          ? { messageIDs: exactIDs, membershipID: member.membershipID, evidence: "tool",
              ...(member.receiverOwnerID ? { receiverOwnerID: member.receiverOwnerID } : {}) }
          : {}),
      };
      if (member?.membershipID && !exactIDs.every((id) => typeof id === "string" && id)) {
        // Without stable IDs, do not perform an unguarded watermark update.
      } else if (member?.membershipID || legacyCenter) {
        await request(opts, "/read", "POST", body)
          .then(() => clearPendingAdmission(sessionID, args.roomId!, maxTs))
          .catch(() => {});
      }
      return lines.join("\n") + (result.hasMore ? "\nMore unread messages remain; poll again." : "");
    }
    default:
      return "error: unknown action";
  }
}
