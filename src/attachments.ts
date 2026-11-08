// Image attachments: stored by the chat server, materialised on each host.
//
// The server keeps the bytes and hands out an id; a message references ids, not
// data and not a public URL. The plugin then writes each image to a temporary
// file on the machine that received the message and puts that path in the
// notification, so an agent reads the image with its own tools. An agent with
// no vision still sees a path it cannot interpret, which is the point: the
// message does not pretend a picture was understood.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "./store";

export type AttachmentRef = { id: string; mime: string; bytes: number; name?: string };

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 2;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** The declared type has to match the bytes: a .png that is not a PNG is not stored. */
export function sniffImage(head: Uint8Array): ImageMime | null {
  const at = (offset: number, bytes: number[]) =>
    bytes.every((value, index) => head[offset + index] === value);
  if (head.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (head.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (head.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

export function extensionFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

/** Safe on-disk name for a message attachment; ids come from the server. */
export function attachmentFileName(mime: string, id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]/g, "")}.${extensionFor(mime)}`;
}

const materialised = new Map<string, string[]>();

/** Paths already written for a message, empty when it carries no image. */
export function imageLines(messageID: string): string[] {
  return materialised.get(messageID) ?? [];
}

export function forgetImages(messageID: string): void {
  materialised.delete(messageID);
}

export type AttachmentSource = {
  base: string;
  token: string;
  roomID: string;
};

/** Download every image of one message to this host's temp directory. */
export async function materializeMessage(
  message: { id: string; roomId?: string; attachments?: AttachmentRef[] },
  source: AttachmentSource,
): Promise<string[]> {
  const refs = message.attachments ?? [];
  if (refs.length === 0) return [];
  if (materialised.has(message.id)) return materialised.get(message.id)!;
  const directory = path.join(tmpdir(), "opencode-chat-room", String(message.roomId ?? source.roomID));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
  const written: string[] = [];
  for (const ref of refs) {
    const file = path.join(directory, `${message.id.replace(/[^A-Za-z0-9_-]/g, "")}-${attachmentFileName(ref.mime, ref.id)}`);
    try {
      await fs.access(file);
      written.push(file);
      continue;
    } catch {}
    const url = `${source.base.replace(/\/$/, "")}/attachments/${encodeURIComponent(String(message.roomId ?? source.roomID))}/${encodeURIComponent(ref.id)}`;
    const headers: Record<string, string> = source.token ? { Authorization: `Bearer ${source.token}` } : {};
    const response = await fetch(url, { headers });
    if (!response.ok) continue;
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) continue;
    await fs.writeFile(file, data, { mode: 0o600 });
    written.push(file);
  }
  materialised.set(message.id, written);
  return written;
}

/** Materialise a batch and return the same array, ready for a formatter. */
export async function materializeMessages<T extends { id: string; roomId?: string; attachments?: AttachmentRef[] }>(
  messages: readonly T[],
  source: AttachmentSource,
): Promise<readonly T[]> {
  await Promise.all(messages.map((message) => materializeMessage(message, source).catch(() => [])));
  return messages;
}

/** The notification line that tells an agent where the picture is. */
export function imageNote(messageID: string): string {
  const paths = imageLines(messageID);
  if (paths.length === 0) return "";
  return paths.map((file) => `  [image] ${file} (read this file yourself; it is not described here)`).join("\n");
}

/** Remove a room's temporary copies when the room is gone. */
export async function forgetRoomImages(roomID: string): Promise<void> {
  await fs.rm(path.join(tmpdir(), "opencode-chat-room", roomID), { recursive: true, force: true }).catch(() => {});
}

// ---- server-side store -------------------------------------------------
// The bytes live beside the SQLite database, one directory per room. Kept in
// this module rather than in the HTTP routes so a plugin running on the same
// machine can read an image without going back over HTTP.

export function attachmentRoot(): string {
  return path.join(path.dirname(statePath()), "attachments");
}

function roomDirectory(roomID: string): string {
  return path.join(attachmentRoot(), roomID.replace(/[^A-Za-z0-9_-]/g, ""));
}

export async function storeAttachment(roomID: string, mime: string, data: Uint8Array, name?: string): Promise<AttachmentRef> {
  if (!IMAGE_MIMES.includes(mime as ImageMime)) throw new Error("unsupported image type");
  if (data.byteLength === 0) throw new Error("empty image");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  if (sniffImage(data.subarray(0, 16)) !== mime) throw new Error("image bytes do not match the declared type");
  const id = randomUUID();
  const directory = roomDirectory(roomID);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `${id}.${extensionFor(mime)}`), data, { mode: 0o600 });
  return { id, mime, bytes: data.byteLength, ...(name ? { name: name.slice(0, 120) } : {}) };
}

export async function readAttachment(roomID: string, id: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const directory = roomDirectory(roomID);
  for (const mime of IMAGE_MIMES) {
    const data = await fs.readFile(path.join(directory, `${id}.${extensionFor(mime)}`)).catch(() => null);
    if (data) return { data: new Uint8Array(data), mime };
  }
  return null;
}

/** Drop every file of a room, including uploads no message ever referenced. */
export async function deleteRoomAttachmentDirectory(roomID: string): Promise<void> {
  await fs.rm(roomDirectory(roomID), { recursive: true, force: true }).catch(() => {});
}

export async function deleteRoomAttachments(roomID: string, ids: readonly string[]): Promise<void> {
  const directory = roomDirectory(roomID);
  for (const id of ids) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) continue;
    for (const mime of IMAGE_MIMES) {
      await fs.rm(path.join(directory, `${id}.${extensionFor(mime)}`), { force: true }).catch(() => {});
    }
  }
}

/** Write a message's images from the local store; returns the paths. */
export async function materializeLocal(
  message: { id: string; roomId?: string; attachments?: AttachmentRef[] },
): Promise<string[]> {
  const refs = message.attachments ?? [];
  if (refs.length === 0 || !message.roomId) return [];
  const roomID = message.roomId;
  if (materialised.has(message.id)) return materialised.get(message.id)!;
  const directory = path.join(tmpdir(), "opencode-chat-room", roomID);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
  const paths: string[] = [];
  for (const ref of refs) {
    const found = await readAttachment(roomID, ref.id);
    if (!found) continue;
    const file = path.join(directory, `${message.id}-${attachmentFileName(ref.mime, ref.id)}`);
    await fs.writeFile(file, found.data, { mode: 0o600 }).catch(() => {});
    paths.push(file);
  }
  if (paths.length) materialised.set(message.id, paths);
  return paths;
}

/** Local first, then over HTTP when this host is not the server. */
export async function materializeAny(
  message: { id: string; roomId?: string; attachments?: AttachmentRef[] },
  source: AttachmentSource,
): Promise<string[]> {
  if (!message.attachments?.length) return [];
  const local = await materializeLocal(message);
  if (local.length) return local;
  return materializeMessage(message, source);
}
