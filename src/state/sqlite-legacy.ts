import { readFileSync } from "node:fs";
import path from "node:path";
import type { Message, Participant, Room } from "../rooms/room-service.ts";
import type { Registry, RegistryEntry } from "./store.ts";
import { type StateDatabase } from "./sqlite.ts";
import { immediate } from "./sqlite-transaction.ts";
import { insertRoom, replaceRegistry } from "./sqlite-rooms.ts";

function readLegacy(file: string): unknown | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function migrate(db: StateDatabase, file: string): Promise<void> {
  if (db.query("SELECT value FROM meta WHERE key='json-migration'").get()) return;
  const oldRooms = readLegacy(path.join(path.dirname(file), "rooms.json"));
  const oldRegistry = readLegacy(path.join(path.dirname(file), "registry.json"));
  const rooms = validateRooms(oldRooms);
  const registry = validateRegistry(oldRegistry);
  await immediate(db, () => {
    if (db.query("SELECT value FROM meta WHERE key='json-migration'").get()) return;
    for (const room of rooms) insertRoom(db, room);
    replaceRegistry(db, registry);
    db.query("INSERT INTO meta(key,value) VALUES('json-migration','done')").run();
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function validateRooms(value: unknown): Room[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Legacy rooms.json must contain an array");
  return value.map((item) => {
    if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string" ||
      typeof item.ownerId !== "string" || !timestamp(item.createdAt) || !Array.isArray(item.participants) || !Array.isArray(item.messages)) {
      throw new Error("Legacy rooms.json contains an invalid room");
    }
    const participants = new Map<string, Participant>();
    for (const p of item.participants) {
      if (!record(p) || typeof p.id !== "string" || typeof p.name !== "string" || !timestamp(p.joinedAt)) throw new Error("Legacy rooms.json contains an invalid participant");
      participants.set(p.id, { id: p.id, name: p.name, joinedAt: p.joinedAt });
    }
    let previousTs = -1;
    const messages = item.messages.map((m): Message => {
      if (!record(m) || typeof m.id !== "string" || typeof m.roomId !== "string" || m.roomId !== item.id ||
        typeof m.senderId !== "string" || typeof m.text !== "string" || !timestamp(m.createdAt) ||
        m.createdAt <= previousTs || (m.senderSessionID !== undefined && typeof m.senderSessionID !== "string")) throw new Error("Legacy rooms.json contains an invalid message");
      previousTs = m.createdAt;
      return { id: m.id, roomId: m.roomId, senderId: m.senderId, text: m.text, createdAt: m.createdAt,
        ...(m.senderSessionID !== undefined ? { senderSessionID: m.senderSessionID } : {}) };
    });
    return { id: item.id, name: item.name, ownerId: item.ownerId, createdAt: item.createdAt, participants, messages };
  });
}

function validateRegistry(value: unknown): Registry {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("Legacy registry.json must contain an object");
  const result: Registry = Object.create(null);
  for (const [roomId, members] of Object.entries(value)) {
    if (!roomId || !record(members)) throw new Error("Legacy registry.json contains an invalid room");
    result[roomId] = Object.create(null);
    for (const [sessionID, raw] of Object.entries(members)) {
      if (!sessionID || !record(raw) || typeof raw.serverUrl !== "string" || typeof raw.apiPrefix !== "string" ||
        typeof raw.name !== "string" || (raw.protocol !== undefined && raw.protocol !== "v1" && raw.protocol !== "v2") ||
        (["lastReadTs", "lastQueuedTs", "lastSeenAt"].some((key) => raw[key] !== undefined && !timestamp(raw[key]))) ||
        (raw.workState !== undefined && !["working", "idle", "waiting", "unknown"].includes(String(raw.workState))) ||
        (["directory", "host", "receiverOwnerID", "membershipID"].some((key) => raw[key] !== undefined && typeof raw[key] !== "string"))) {
        throw new Error("Legacy registry.json contains an invalid entry");
      }
      result[roomId]![sessionID] = { serverUrl: raw.serverUrl, apiPrefix: raw.apiPrefix, name: raw.name,
        ...(raw.protocol ? { protocol: raw.protocol } : {}),
        ...(timestamp(raw.lastReadTs) ? { lastReadTs: raw.lastReadTs } : {}),
        ...(timestamp(raw.lastQueuedTs) ? { lastQueuedTs: raw.lastQueuedTs } : {}),
        ...(typeof raw.directory === "string" ? { directory: raw.directory } : {}),
        ...(typeof raw.host === "string" ? { host: raw.host } : {}),
        ...(typeof raw.receiverOwnerID === "string" ? { receiverOwnerID: raw.receiverOwnerID } : {}),
        ...(typeof raw.membershipID === "string" ? { membershipID: raw.membershipID } : {}),
        ...(typeof raw.workState === "string" ? { workState: raw.workState as RegistryEntry["workState"] } : {}),
        ...(timestamp(raw.lastSeenAt) ? { lastSeenAt: raw.lastSeenAt } : {}) };
    }
  }
  return result;
}
