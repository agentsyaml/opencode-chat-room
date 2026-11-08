import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { databasePath, readState } from "./store";
import { getResource, putResource, type StoredResource } from "./sqlite-state";

export type Resource = StoredResource;
export class ResourceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageDir = () => path.join(path.dirname(databasePath()), "resources");
const roomDirectory = (roomID: string) => path.join(storageDir(), roomID);

export function maxResourceBytes(): number {
  const mb = Number(process.env.CHAT_ROOM_MAX_FILE_SIZE_MB ?? "100");
  const bytes = mb * 1024 * 1024;
  if (!Number.isFinite(mb) || mb <= 0 || !Number.isSafeInteger(bytes)) throw new Error("CHAT_ROOM_MAX_FILE_SIZE_MB must be a positive finite number");
  return bytes;
}
function mime(bytes: Uint8Array): string {
  const starts = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE") return "audio/wav";
  if (String.fromCharCode(...bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "OggS") return "audio/ogg";
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return "video/mp4";
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return "application/octet-stream";
}
function safeName(value: string): string {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value) || /[\\/]/.test(value) || value === "." || value === "..") {
    throw new ResourceError(400, "invalid resource filename");
  }
  return value;
}

export async function uploadResource(roomID: string, filename: string, body: ReadableStream<Uint8Array>, limitBytes: number): Promise<Resource> {
  if (!uuid.test(roomID)) throw new ResourceError(404, "room not found");
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error("limitBytes must be a positive safe integer");
  if (!await readState((service) => service.listRooms().some((room) => room.id === roomID))) throw new ResourceError(404, "room not found");
  const name = safeName(filename);
  const dir = roomDirectory(roomID);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temp = path.join(dir, `${id}.tmp`);
  const dest = resourcePath({ id, roomID } as Resource);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    const reader = body.getReader();
    let size = 0;
    const prefix = new Uint8Array(32);
    let prefixSize = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limitBytes) throw new ResourceError(413, "file exceeds maximum size");
        const copy = value.subarray(0, Math.min(value.length, prefix.length - prefixSize));
        prefix.set(copy, prefixSize); prefixSize += copy.length;
        let offset = 0;
        while (offset < value.length) {
          const result = await handle.write(value, offset, value.length - offset, size - value.length + offset);
          if (!result.bytesWritten) throw new Error("file write made no progress");
          offset += result.bytesWritten;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const resource: Resource = { id, roomID, name, mimeType: mime(prefix.subarray(0, prefixSize)), size, createdAt: Date.now() };
    await handle.close(); handle = undefined;
    await fs.rename(temp, dest);
    if (!await putResource(databasePath(), resource)) throw new ResourceError(404, "room not found");
    return resource;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    await fs.rm(dest, { force: true }).catch(() => {});
    throw error;
  }
}

export function resourcePath(resource: Pick<Resource, "id" | "roomID">): string {
  if (!uuid.test(resource.roomID) || !uuid.test(resource.id)) throw new ResourceError(404, "resource not found");
  return path.join(roomDirectory(resource.roomID), resource.id);
}
export async function findResource(roomID: string, id: string): Promise<Resource | undefined> {
  if (!uuid.test(id)) return undefined;
  return getResource(databasePath(), roomID, id);
}
export async function removeRoomResources(roomID: string): Promise<void> {
  if (!uuid.test(roomID)) throw new ResourceError(404, "room not found");
  if (await readState((service) => service.listRooms().some((room) => room.id === roomID))) {
    throw new ResourceError(409, "room still exists; resource cleanup was not performed");
  }
  await fs.rm(roomDirectory(roomID), { recursive: true, force: true });
}
