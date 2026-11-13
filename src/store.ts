// Shared state facade for the standalone SQLite database.
// (rooms + registry), identity, and formatting. Used by plugin.ts (standalone
// mode) and server/chat-server.ts (central mode).
import path from "node:path";
import os from "node:os";
import RoomService, { type Message, type Room } from "./room-service";
import { acknowledgeQueued as sqliteAcknowledgeQueued, acknowledgeRead as sqliteAcknowledgeRead, answerQuestion as sqliteAnswerQuestion, appendRoomMessage as sqliteAppendRoomMessage, sendReply as sqliteSendReply, readHistoryPage, readInboxPage as sqliteInboxPage, readMessageReceipts, readQuestionExcerpt as sqliteQuestionExcerpt, readQuestions as sqliteReadQuestions, countOpenQuestions as sqliteCountOpenQuestions, readSqliteState, readUnreadPage, writeMessageReceipts, writePresenceState, writeSqliteState, type HistoryMessage } from "./sqlite-state";

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
export async function readInboxMessages(sessionID: string, roomID: string | null, excludeSelf: boolean, limit = 100, afterTs?: number) {
  return sqliteInboxPage(databasePath(), sessionID, roomID, excludeSelf, limit, afterTs);
}
export async function readHistory(roomID: string, beforeSeq?: number, limit = 100, exclude?: { sessionID: string; name: string }): Promise<{ messages: HistoryMessage[]; nextBeforeSeq: number | null; hasMore: boolean }> {
  return readHistoryPage(databasePath(), roomID, beforeSeq, limit, exclude?.sessionID, exclude?.name);
}
export async function readQuestions(roomID: string): Promise<Message[]> { return sqliteReadQuestions(databasePath(), roomID); }
export async function countOpenQuestions(roomID: string): Promise<number> { return sqliteCountOpenQuestions(databasePath(), roomID); }
export function acknowledgeRead(roomID: string, sessionID: string, ts: number) { return sqliteAcknowledgeRead(databasePath(), roomID, sessionID, ts); }
export function acknowledgeQueued(roomID: string, sessionID: string, ts: number) { return sqliteAcknowledgeQueued(databasePath(), roomID, sessionID, ts); }
export async function answerQuestion(roomID: string, questionID: string, sessionID: string, text: string) { return sqliteAnswerQuestion(databasePath(), roomID, questionID, sessionID, text); }
export async function sendReply(roomID: string, targetID: string, sessionID: string, text: string) { return sqliteSendReply(databasePath(), roomID, targetID, sessionID, text); }
export function appendRoomMessage(roomID: string, sessionID: string, text: string, isQuestion: boolean) { return sqliteAppendRoomMessage(databasePath(), roomID, sessionID, text, isQuestion); }
export async function readQuestionExcerpt(roomID: string, questionID: string) { return sqliteQuestionExcerpt(databasePath(), roomID, questionID); }

export async function loadRooms(): Promise<Room[]> {
  return (await readSqliteState(databasePath())).rooms;
}

export async function readReceipts(roomID: string, messageIDs?: string[]): Promise<MessageReceipt[] | undefined> {
  return readMessageReceipts(databasePath(), roomID, messageIDs);
}

export type WorkState = "working" | "idle" | "waiting" | "unknown";
export type ReceiptEvidence = "displayed" | "tool" | "context";
export type MessageReceiptReader = { sessionID: string; name: string; readAt: number; evidence: ReceiptEvidence };
export type MessageReceipt = { messageID: string; readers: MessageReceiptReader[] };
export type PresenceReport = { sessionID: string; state: WorkState };
export type ReceiptIdentity = { membershipID: string; receiverOwnerID?: string };
export type ReceiptWriteResult = { status: "ok"; acceptedIDs: string[]; readThroughTs?: number } | { status: "membership" | "messageIDs"; acceptedIDs: [] };

export function recordMessageReceipts(roomID: string, sessionID: string, messageIDs: string[], evidence: ReceiptEvidence, identity: ReceiptIdentity): Promise<ReceiptWriteResult> {
  return writeMessageReceipts(databasePath(), roomID, sessionID, messageIDs, evidence, identity, Date.now());
}

export function acknowledgeReadWithReceipts(roomID: string, sessionID: string, readThroughTs: number, messageIDs: string[], evidence: ReceiptEvidence, identity: ReceiptIdentity): Promise<ReceiptWriteResult> {
  return writeMessageReceipts(databasePath(), roomID, sessionID, messageIDs, evidence, identity, Date.now(), readThroughTs);
}

export function reportPresence(reports: PresenceReport[], ownerID?: string, sequence?: number) {
  return writePresenceState(databasePath(), reports, ownerID, sequence, Date.now());
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
  membershipID?: string;
  workState?: WorkState;
  lastSeenAt?: number;
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

export function formatServeWakePrompt(
  roomName: string,
  roomId: string,
  lines: ReadonlyArray<string>,
): string {
  return `<notification>\nNew messages in room ${roomName} (${roomId}):\n${lines.join("\n")}\n</notification>`;
}

// ponytail: oversize protection for push payloads — truncate long texts and
// cap the number of unread lines per notification
const MAX_LINE = 300;
const MAX_LINES = 20;

// Display lines for a push. `capped` means the notification is lossy because
// lines were folded or message text was truncated; callers must not advance
// the watermark until a full poll confirms it.
const MENTION_MARKER = /<at>([\s\S]*?)<\/at>/g;
// `<at>@name</at>` is an editor token; notifications and receipts show the plain mention.
export const visibleText = (text: string) => text.replace(MENTION_MARKER, "$1");

export function formatNotificationLines(
  items: ReadonlyArray<{ createdAt: number; senderId: string; text: string; answerQuestionExcerpt?: string }>,
): { lines: string[]; capped: boolean; visibleIndices: number[] } {
  const visible: Array<{ item: typeof items[number]; index: number }> = [];
  let lineCount = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const required = item.answerQuestionExcerpt ? 2 : 1;
    if (lineCount + required > MAX_LINES) break;
    visible.unshift({ item, index });
    lineCount += required;
  }
  const countCapped = visible.length < items.length;
  const textCapped = items.some((it) => visibleText(it.text).length > MAX_LINE);
  const capped = countCapped || textCapped;
  const lines = visible.flatMap(({ item: it }) => {
    const plain = visibleText(it.text);
    const text = plain.length > MAX_LINE ? `${plain.slice(0, MAX_LINE)}\u2026` : plain;
    return [
      ...(it.answerQuestionExcerpt ? [`  ↳ Answer to: “${it.answerQuestionExcerpt.replace(/[\r\n]+/g, " ")}”`] : []),
      `- [${timeOf(it.createdAt)}] ${it.senderId}: ${text}`,
    ];
  });
  if (countCapped) {
    lines.unshift(`\u2026 and ${items.length - visible.length} earlier messages`);
  }
  return { lines, capped, visibleIndices: visible.map(({ index }) => index) };
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
