// ponytail: shared primitives for the chat room plugin — file persistence
// (rooms + registry), identity, and formatting. Used by plugin.ts (standalone
// mode) and server/chat-server.ts (central mode).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import RoomService, { type Message, type Room } from "./room-service";

export function statePath(): string {
  // ponytail: shared mount for multi-host rooms (NFS/sshfs); default is local
  if (process.env.CHAT_ROOM_STATE_DIR) {
    return path.join(process.env.CHAT_ROOM_STATE_DIR, "rooms.json");
  }
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "chat-room", "rooms.json");
}

// ponytail: in-process serialization of load->mutate->save; cross-process
// concurrent writers are still last-writer-wins (unique tmp name below makes
// the failure clean instead of mis-assigned)
let storeQueue: Promise<unknown> = Promise.resolve();

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(fn);
  storeQueue = run.catch(() => {});
  return run;
}

export async function loadRooms(): Promise<Room[]> {
  const file = statePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // ponytail: corrupt file -> back it up and start fresh instead of bricking the tool
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((entry): Room[] => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const r = entry as Record<string, unknown>;
    const room: Room = {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      ownerId: String(r.ownerId ?? ""),
      createdAt: Number(r.createdAt ?? 0),
      participants: new Map(),
      messages: [],
    };
    if (!room.id) {
      return [];
    }
    if (Array.isArray(r.participants)) {
      for (const p of r.participants) {
        if (p && typeof p.id === "string" && typeof p.name === "string") {
          room.participants.set(p.id, p);
        }
      }
    }
    if (Array.isArray(r.messages)) {
      // ponytail: keep only well-formed entries so one corrupt message
      // can't crash formatting (or lose a pending send)
      room.messages = (r.messages as Message[]).filter(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          typeof m.id === "string" &&
          typeof m.roomId === "string" &&
          typeof m.senderId === "string" &&
          typeof m.text === "string" &&
          typeof m.createdAt === "number",
      );
    }
    return [room];
  });
}

export async function saveRooms(svc: RoomService): Promise<void> {
  const file = statePath();
  const data = svc.listRooms().map((r) => ({
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    createdAt: r.createdAt,
    participants: [...r.participants.values()],
    messages: r.messages,
  }));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export type RegistryEntry = {
  serverUrl: string;
  apiPrefix: string;
  name: string;
  lastReadTs?: number;
};
export type Registry = Record<string, Record<string, RegistryEntry>>;

export function registryPath(): string {
  return path.join(path.dirname(statePath()), "registry.json");
}

export async function loadRegistry(): Promise<Registry> {
  const file = registryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // ponytail: corrupt file -> back it up and start fresh instead of bricking the tool
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return {};
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  // ponytail: null-proto so hostile keys ("__proto__") can't touch Object.prototype
  return Object.assign(Object.create(null), data) as Registry;
}

export async function saveRegistry(reg: Registry): Promise<void> {
  const file = registryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export function identity(name?: string): string {
  return name || `${os.userInfo().username}@${os.hostname()}`;
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
