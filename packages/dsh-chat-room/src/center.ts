import os from "node:os";
import type { RoomConfig } from "./config.ts";

/** One unread room message as the central inbox reports it. */
export interface InboxItem {
  id: string;
  roomId: string;
  roomName: string;
  roomKind?: "group" | "direct";
  senderId: string;
  senderSessionID?: string;
  text: string;
  createdAt: number;
  answerQuestionExcerpt?: string;
  recalledAt?: number;
}

/** The central inbox page; `member` is false once the session is no longer joined. */
export interface InboxPage {
  member: boolean;
  items: InboxItem[];
  queuedTs: Record<string, number>;
  hasMore: boolean;
}

/** An HTTP failure from the central server, carrying its status. */
export class CenterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CenterError";
    this.status = status;
  }
}

/** Stable central identity for one harness agent; the session id survives restarts. */
export function sessionIDFor(agent: { readonly session: { readonly id: string } }): string {
  return `dsh:${agent.session.id}`;
}

async function request(
  cfg: RoomConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(cfg.requestTimeoutMs);
  const response = await fetch(`${cfg.url}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data && typeof data === "object" && "error" in data ? String(data.error) : "unknown error";
    throw new CenterError(response.status, `${init.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  return data;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read the unread items for one session, optionally restricted to one room. */
export async function readInbox(cfg: RoomConfig, sessionID: string, roomId?: string, signal?: AbortSignal): Promise<InboxPage> {
  const query = new URLSearchParams({ sessionID, excludeSelf: "1", timeout: "0" });
  if (roomId) query.set("roomId", roomId);
  const data = record(await request(cfg, `/inbox?${query}`, {}, signal));
  const items: InboxItem[] = [];
  for (const value of Array.isArray(data.items) ? data.items : []) {
    const item = record(value);
    if (!text(item.id) || !text(item.roomId) || typeof item.createdAt !== "number") continue;
    items.push({
      id: text(item.id), roomId: text(item.roomId), roomName: text(item.roomName),
      ...(item.roomKind === "direct" ? { roomKind: "direct" as const } : { roomKind: "group" as const }),
      senderId: text(item.senderId), text: text(item.text), createdAt: item.createdAt,
      ...(text(item.answerQuestionExcerpt) ? { answerQuestionExcerpt: text(item.answerQuestionExcerpt) } : {}),
      ...(text(item.senderSessionID) ? { senderSessionID: text(item.senderSessionID) } : {}),
      ...(typeof item.recalledAt === "number" ? { recalledAt: item.recalledAt } : {}),
    });
  }
  return {
    member: data.member === true,
    items,
    queuedTs: record(data.queuedTs) as Record<string, number>,
    hasMore: data.hasMore === true,
  };
}

/** Advance the read watermark so delivered items are not offered again. */
export async function markRead(cfg: RoomConfig, roomId: string, sessionID: string, ts: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(ts) || ts <= 0) return;
  await request(cfg, "/read", { method: "POST", body: { roomId, sessionID, ts } }, signal);
}

/** One model-facing notification block; room text stays quoted as untrusted input. */
export function formatMessages(roomName: string, roomKind: "group" | "direct" | undefined, items: InboxItem[]): string {
  const context = roomKind === "direct"
    ? `Direct conversation in room ${roomName}`
    : `New messages in room ${roomName}`;
  const lines = items.slice(-20).map((item) => {
    const body = item.text.replace(/\s+/g, " ").trim().slice(0, 300);
    const answer = item.answerQuestionExcerpt
      ? `\n  answer to: ${item.answerQuestionExcerpt.replace(/\s+/g, " ").trim().slice(0, 200)}`
      : "";
    return `- ${item.senderId}: (id: ${item.id}) ${body}${answer}`;
  });
  return `<notification>\n${context}:\n${lines.join("\n")}\n</notification>`;
}

/** Actions the room tool exposes; kept in the schema enum and the switch together. */
export const ROOM_ACTIONS = ["list", "create", "join", "join_status", "leave", "send", "poll", "recall", "members"] as const;
export type RoomAction = (typeof ROOM_ACTIONS)[number];

/** Validated model arguments for one room call. */
export interface RoomArgs {
  action: RoomAction;
  roomId?: string;
  messageId?: string;
  name?: string;
  text?: string;
  isQuestion?: boolean;
  joinPolicy?: "open" | "approval";
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > max) throw new TypeError(`room: ${field} must be 1-${max} characters`);
  return trimmed;
}

/** Reject malformed model arguments before any network call. */
export function parseRoomArgs(value: unknown): RoomArgs {
  const raw = record(value);
  const action = text(raw.action) as RoomAction;
  if (!ROOM_ACTIONS.includes(action)) throw new TypeError(`room: action must be one of ${ROOM_ACTIONS.join(", ")}`);
  if (raw.isQuestion !== undefined && typeof raw.isQuestion !== "boolean") throw new TypeError("room: isQuestion must be a boolean");
  if (raw.joinPolicy !== undefined && raw.joinPolicy !== "open" && raw.joinPolicy !== "approval") {
    throw new TypeError("room: joinPolicy must be open or approval");
  }
  const roomId = optionalString(raw.roomId, "roomId", 128);
  const messageId = optionalString(raw.messageId, "messageId", 128);
  const name = optionalString(raw.name, "name", 64);
  const message = optionalString(raw.text, "text", 5000);
  return {
    action,
    ...(roomId === undefined ? {} : { roomId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(name === undefined ? {} : { name }),
    ...(message === undefined ? {} : { text: message }),
    ...(raw.isQuestion === true ? { isQuestion: true } : {}),
    ...(raw.joinPolicy === "approval" ? { joinPolicy: "approval" as const } : {}),
  };
}

function requireRoomId(args: RoomArgs): string {
  if (!args.roomId) throw new TypeError(`room: ${args.action} requires roomId`);
  return encodeURIComponent(args.roomId);
}

/** Run one validated action against the central server and return model-facing text. */
export async function roomAction(cfg: RoomConfig, args: RoomArgs, sessionID: string, signal?: AbortSignal): Promise<string> {
  switch (args.action) {
    case "list": {
      const data = await request(cfg, `/rooms?sessionID=${encodeURIComponent(sessionID)}`, {}, signal);
      const rooms = Array.isArray(data) ? data.map(record) : [];
      if (rooms.length === 0) return "no rooms yet";
      return rooms.map((room) => {
        const members = Array.isArray(room.participants) ? room.participants.length : 0;
        return `${text(room.id)} (${text(room.name)}): ${members} members`;
      }).join("\n");
    }
    case "create": {
      if (!args.name) throw new TypeError("room: create requires name");
      const data = record(await request(cfg, "/rooms", {
        method: "POST", body: {
          name: args.name, ownerId: cfg.participant, sessionID, host: os.hostname(),
          ...(args.joinPolicy ? { joinPolicy: args.joinPolicy } : {}),
        },
      }, signal));
      return `created room ${text(data.id)} (${text(data.name)})`;
    }
    case "join": {
      const id = requireRoomId(args);
      if (!args.name) throw new TypeError("room: join requires name");
      const data = record(await request(cfg, `/rooms/${id}/join`, {
        method: "POST", body: { sessionID, participantId: args.name, participantName: args.name, host: os.hostname() },
      }, signal));
      if (data.status === "pending") {
        return `pending: join request sent to room ${args.roomId}; a human administrator must approve it. You are NOT a member yet: do not claim you joined, and do not send or poll until join_status reports joined.`;
      }
      return `joined room ${text(data.id)} (${text(data.name)})`;
    }
    case "join_status": {
      const id = requireRoomId(args);
      const data = record(await request(cfg, `/rooms/${id}/join-requests/status?sessionID=${encodeURIComponent(sessionID)}`, {}, signal));
      if (data.status === "joined") return `joined room ${args.roomId}`;
      if (data.status === "pending") return `pending: join request for room ${args.roomId} is waiting for a human administrator; you are NOT a member yet`;
      return `none: no join request for room ${args.roomId}; run join with your name to request access`;
    }
    case "leave": {
      const id = requireRoomId(args);
      await request(cfg, `/rooms/${id}/leave`, { method: "POST", body: { sessionID } }, signal);
      return `left room ${args.roomId}`;
    }
    case "send": {
      const id = requireRoomId(args);
      if (!args.text) throw new TypeError("room: send requires text");
      const room = record(await request(cfg, `/rooms/${id}/messages`, {
        method: "POST", body: { sessionID, text: args.text, ...(args.isQuestion ? { isQuestion: true } : {}) },
      }, signal));
      const messages = Array.isArray(room.messages) ? room.messages.map(record) : [];
      const sentID = [...messages].reverse()
        .find((message) => message.senderSessionID === sessionID && message.text === args.text)?.id
        ?? messages.at(-1)?.id;
      return `sent to room ${args.roomId}${typeof sentID === "string" && sentID ? ` (id: ${sentID})` : ""}`;
    }
    case "recall": {
      const id = requireRoomId(args);
      if (!args.messageId) throw new TypeError("room: recall requires messageId");
      await request(cfg, `/rooms/${id}/messages/${encodeURIComponent(args.messageId)}/recall`, {
        method: "POST", body: { sessionID },
      }, signal);
      return `recalled message ${args.messageId}`;
    }
    case "members": {
      const id = requireRoomId(args);
      const data = record(await request(cfg, `/rooms/${id}`, {}, signal));
      const names = (Array.isArray(data.participants) ? data.participants : []).map((value) => text(record(value).name)).filter(Boolean);
      return names.length ? names.join("\n") : "no members";
    }
    case "poll": {
      requireRoomId(args);
      const page = await readInbox(cfg, sessionID, args.roomId, signal);
      if (!page.member) throw new CenterError(409, "room: not joined to this room");
      const items = page.items.filter((item) => !item.recalledAt);
      if (items.length === 0) return "no new messages";
      const newest = Math.max(...items.map((item) => item.createdAt));
      await markRead(cfg, args.roomId!, sessionID, newest, signal).catch(() => {});
      const lines = items.map((item) => `[${item.senderId}] ${item.text} (id: ${item.id})`);
      return lines.join("\n") + (page.hasMore ? "\nMore unread messages remain; poll again." : "");
    }
  }
}