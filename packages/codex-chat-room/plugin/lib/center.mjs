// Central chat-room HTTP client and the room action used by the Codex MCP tool.
// This mirrors the subset of the OpenCode plugin's central mode that the
// central server can serve without a host session transport.
import os from "node:os";

export function centerConfig(env = process.env) {
  return {
    url: (env.CHAT_ROOM_SERVER_URL || "http://127.0.0.1:4399").replace(/\/+$/, ""),
    token: env.CHAT_ROOM_SERVER_TOKEN || "",
  };
}

export function sessionIDFor(threadID) {
  return `codex:${threadID}`;
}

export function identity(name) {
  return (name || `${os.userInfo().username}@${os.hostname()}`).slice(0, 64);
}

export function timeOf(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export async function request(cfg, path, method, body, timeout = 15000) {
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${data.error ?? "unknown"}`);
  }
  return data;
}

function senderName(room, message) {
  const participant = (room.participants || []).find((p) => p.id === message.senderId);
  return participant?.name ?? message.senderId;
}

export function formatRoom(room) {
  const members = (room.participants || []).map((p) => p.name).join(", ");
  const lines = [`Room ${room.id} (${room.name}) \u2014 members: ${members}`];
  for (const message of (room.messages || []).slice(-5)) {
    lines.push(`[${timeOf(message.createdAt)}] ${senderName(room, message)}: ${message.text}`);
  }
  return lines.join("\n");
}

export async function centerAction(cfg, args, sessionID) {
  switch (args.action) {
    case "list": {
      const rooms = await request(cfg, `/rooms?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      if (!Array.isArray(rooms) || rooms.length === 0) return "no rooms yet";
      return rooms.map((r) => `${r.id} (${r.name}): ${(r.participants || []).length} members`).join("\n");
    }
    case "create": {
      if (!args.name?.trim()) return "error: name is required";
      const room = await request(cfg, "/rooms", "POST", {
        name: args.name.trim(),
        ownerId: identity(),
        sessionID,
        host: os.hostname(),
      });
      return formatRoom(room);
    }
    case "join": {
      if (!args.name?.trim()) return "error: name is required to join a room";
      if (!args.roomId) return "error: roomId is required";
      const me = identity(args.name.trim());
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/join`, "POST", {
        sessionID,
        participantId: me,
        participantName: me,
        host: os.hostname(),
      });
      return formatRoom(room);
    }
    case "leave": {
      if (!args.roomId) return "error: roomId is required";
      await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/leave`, "POST", { sessionID });
      return `left room ${args.roomId}`;
    }
    case "members": {
      if (!args.roomId) return "error: roomId is required";
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}`, "GET");
      const names = (room.participants || []).map((p) => p.name);
      return names.length ? names.join("\n") : "no members";
    }
    case "send": {
      if (!args.roomId) return "error: roomId is required";
      if (!args.text?.trim()) return "error: text is required";
      const text = args.text.trim();
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/messages`, "POST", {
        sessionID,
        text,
        ...(args.isQuestion ? { isQuestion: true } : {}),
      });
      return `sent: ${text}\n${formatRoom(room)}`;
    }
    case "poll": {
      if (!args.roomId) return "error: roomId is required";
      const result = await request(
        cfg,
        `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(args.roomId)}&excludeSelf=1`,
        "GET",
      );
      if (!result.member) return "error: not joined";
      const items = (result.items || []).filter((item) => item.senderSessionID !== sessionID);
      if (items.length === 0) return "no new messages";
      const lines = items.map((item) => `[${timeOf(item.createdAt)}] ${item.senderId}: ${item.text}`);
      const maxTs = items.reduce((max, item) => Math.max(max, item.createdAt), 0);
      await request(cfg, "/read", "POST", { roomId: args.roomId, sessionID, ts: maxTs }).catch(() => {});
      return lines.join("\n") + (result.hasMore ? "\nMore unread messages remain; poll again." : "");
    }
    case "announcement_list":
    case "announcement_read":
    case "announcement_write":
    case "announcement_delete": {
      if (!args.roomId) return "error: roomId is required";
      if (args.action !== "announcement_list" && !args.announcementName) {
        return "error: announcementName is required";
      }
      const root = `/rooms/${encodeURIComponent(args.roomId)}/announcements`;
      if (args.action === "announcement_list") {
        const result = await request(cfg, root, "GET");
        return (result.announcements || []).map((item) => `${item.name}: ${item.content}`).join("\n") || "no announcements";
      }
      const path = `${root}/${encodeURIComponent(args.announcementName)}`;
      if (args.action === "announcement_read") {
        const result = await request(cfg, path, "GET");
        return `${result.announcement.name}:\n${result.announcement.content}`;
      }
      if (args.action === "announcement_write") {
        if (typeof args.content !== "string") return "error: content is required";
        const result = await request(cfg, path, "PUT", { sessionID, content: args.content });
        return `announcement saved: ${result.announcement.name}`;
      }
      await request(cfg, path, "DELETE", { sessionID });
      return `announcement deleted: ${args.announcementName}`;
    }
    default:
      return "error: unknown action";
  }
}