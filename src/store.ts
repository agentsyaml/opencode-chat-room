// Shared state facade for the standalone SQLite database.
// (rooms + registry), identity, and formatting. Used by plugin.ts (standalone
// mode) and server/chat-server.ts (central mode).
import path from "node:path";
import os from "node:os";
import RoomService, { type Message, type Room } from "./room-service";
import { readHistoryPage, readInboxPage as sqliteInboxPage, readSqliteState, readUnreadPage, writeSqliteState, type HistoryMessage } from "./sqlite-state";

export function statePath(): string {
  // JSON path remains the migration source; SQLite lives beside it.
  if (process.env.CHAT_ROOM_STATE_DIR) {
    return path.join(process.env.CHAT_ROOM_STATE_DIR, "rooms.json");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "chat-room", "rooms.json");
}

export function databasePath(): string { return path.join(path.dirname(statePath()), "chat-room.sqlite"); }
export function writeState<T>(callback: (service: RoomService, registry: Registry) => T): Promise<T> {
  return writeSqliteState(databasePath(), callback);
}
export async function readState<T>(callback: (service: RoomService, registry: Registry) => T): Promise<T> {
  const state = await readSqliteState(databasePath());
  const service = new RoomService();
  service.hydrate(state.rooms);
  return callback(service, state.registry);
}
export async function readUnreadMessages(roomID: string, afterTs: number, limit = 100, sessionID?: string, senderName?: string, newest = false) {
  return readUnreadPage(databasePath(), roomID, afterTs, limit, sessionID, senderName, newest);
}
export async function readInboxMessages(sessionID: string, roomID: string | null, excludeSelf: boolean, limit = 100) {
  return sqliteInboxPage(databasePath(), sessionID, roomID, excludeSelf, limit);
}
export async function readHistory(roomID: string, beforeSeq?: number, limit = 100, exclude?: { sessionID: string; name: string }): Promise<{ messages: HistoryMessage[]; nextBeforeSeq: number | null; hasMore: boolean }> {
  return readHistoryPage(databasePath(), roomID, beforeSeq, limit, exclude?.sessionID, exclude?.name);
}

export async function loadRooms(): Promise<Room[]> {
  return (await readSqliteState(databasePath())).rooms;
}

export type RegistryEntry = {
  serverUrl: string;
  apiPrefix: string;
  protocol?: "v1" | "v2";
  name: string;
  lastReadTs?: number;
  lastQueuedTs?: number;
  directory?: string;
  // ora-1 #2: 归属主机——跨机 @-wake 只由所属机器执行；web 条目不填
  host?: string;
  receiverOwnerID?: string;
};
export type Registry = Record<string, Record<string, RegistryEntry>>;

export async function loadRegistry(): Promise<Registry> {
  return (await readSqliteState(databasePath())).registry;
}

export function identity(name?: string): string {
  // ponytail: cap the resolved identity so long-hostname defaults can't hit
  // the central server's 64-char name limit on a path the user never typed
  return (name || `${os.userInfo().username}@${os.hostname()}`).slice(0, 64);
}

// ponytail: shared trailing instruction for push notifications
export const NOTIFY_INSTRUCTION =
  "This is an automatic chat-room notification. Do NOT reply, do NOT call any tools, do NOT interrupt your current work, unless you are explicitly addressed (mentioned by name) or genuinely need to respond.";

// ponytail: 唤醒已退出 session 的消息（serve /session/:id/message 的 parts
// 文本）——客户端（center-client）与服务器（chat-server）共享
export const SERVE_WAKE_PROMPT =
  "You were woken because you were mentioned (@) in the chat room. Use the room tool to poll the room(s) you are a member of, read the new messages, and reply to anything addressed to you. Then report what you did.";

export function formatServeWakePrompt(
  roomName: string,
  lines: ReadonlyArray<string>,
): string {
  return `${SERVE_WAKE_PROMPT}\n\nNew messages in room ${roomName}:\n${lines.join("\n")}`;
}

// ponytail: oversize protection for push payloads — truncate long texts and
// cap the number of unread lines per notification
const MAX_LINE = 300;
const MAX_LINES = 20;

// Display lines for a push. `capped` means the notification is lossy because
// lines were folded or message text was truncated; callers must not advance
// the watermark until a full poll confirms it.
export function formatNotificationLines(
  items: ReadonlyArray<{ createdAt: number; senderId: string; text: string }>,
): { lines: string[]; capped: boolean } {
  const countCapped = items.length > MAX_LINES;
  const textCapped = items.some((it) => it.text.length > MAX_LINE);
  const capped = countCapped || textCapped;
  const lines = items.slice(-MAX_LINES).map((it) => {
    const text =
      it.text.length > MAX_LINE ? `${it.text.slice(0, MAX_LINE)}\u2026` : it.text;
    return `- [${timeOf(it.createdAt)}] ${it.senderId}: ${text}`;
  });
  if (countCapped) {
    lines.unshift(`\u2026 and ${items.length - MAX_LINES} earlier messages`);
  }
  return { lines, capped };
}

export function authHeader(): string {
  const pwd = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pwd) {
    return "";
  }
  return `Basic ${Buffer.from(
    `${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${pwd}`,
  ).toString("base64")}`;
}

export function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function senderName(svc: RoomService, m: Message): string {
  return (
    svc.getParticipants(m.roomId).find((p) => p.id === m.senderId)?.name ??
    m.senderId
  );
}

export function formatRoom(svc: RoomService, room: Room): string {
  const members = svc
    .getParticipants(room.id)
    .map((p) => p.name)
    .join(", ");
  const lines = [`Room ${room.id} (${room.name}) \u2014 members: ${members}`];
  for (const m of room.messages.slice(-5)) {
    lines.push(`[${timeOf(m.createdAt)}] ${senderName(svc, m)}: ${m.text}`);
  }
  return lines.join("\n");
}
