// Channel D attachments: chatroom resources become local files for the adapter,
// and adapter-downloaded files become chatroom resources for the room.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AdapterCapabilities, AttachmentRef, IngestEvent } from "../packages/chat-room-channeld/src/protocol.ts";
import { platformLabel } from "../packages/chat-room-channeld/src/inbound.ts";
import { findResource, maxResourceBytes, openResource, uploadResource } from "../src/rooms/resources.ts";

/**
 * Resources referenced by a room message marker. The message text stays the
 * source of truth: an attachment that was uploaded but never mentioned is not
 * forwarded.
 */
export async function forwardAttachments(roomId: string, text: string): Promise<AttachmentRef[]> {
  const ids = [...text.matchAll(/\[\[resource:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\]/gi)]
    .map((match) => match[1]!)
    .filter((id, index, all) => all.indexOf(id) === index);
  const attachments: AttachmentRef[] = [];
  for (const id of ids) {
    const resource = await findResource(roomId, id).catch(() => undefined);
    if (!resource) {
      attachments.push({ kind: "file", name: "attachment", error: "resource unavailable" });
      continue;
    }
    attachments.push({
      kind: resource.mimeType.startsWith("image/") ? "image" : "file",
      name: resource.name,
      mimeType: resource.mimeType,
      size: resource.size,
      resourceId: resource.id,
      roomId,
    });
  }
  return attachments;
}

/**
 * Turn chatroom resource ids into local files for the adapter. Channel D runs
 * adapters as child processes on the same host, so a path is cheaper and less
 * fragile than moving megabytes through the JSON frame.
 */
export async function prepareSendPayload(
  payload: unknown,
  capabilities?: AdapterCapabilities,
): Promise<{ payload: unknown; cleanup?: () => Promise<void> }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { payload };
  const attachments = (payload as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return { payload };

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-room-outbound-"));
  const files: AttachmentRef[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const attachment = raw as AttachmentRef;
    if (!attachment.resourceId || !attachment.roomId) {
      files.push(attachment);
      continue;
    }
    try {
      const resource = await findResource(attachment.roomId, attachment.resourceId);
      if (!resource) throw new Error("resource not found");
      const limit = resource.mimeType.startsWith("image/")
        ? capabilities?.attachments?.imageMaxBytes
        : capabilities?.attachments?.fileMaxBytes;
      if (limit !== undefined && resource.size > limit) throw new Error(`exceeds adapter attachment limit (${limit} bytes)`);
      const opened = await openResource(resource);
      if (!opened) throw new Error("resource content is missing");
      const extension = path.extname(resource.name).toLowerCase();
      const file = path.join(directory, `${resource.id}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"}`);
      await pipeline(Readable.fromWeb(opened.stream as unknown as import("node:stream/web").ReadableStream), createWriteStream(file, { mode: 0o600 }));
      files.push({ ...attachment, name: resource.name, mimeType: resource.mimeType, size: resource.size, path: file });
    } catch (error) {
      files.push({ ...attachment, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    payload: { ...(payload as Record<string, unknown>), attachments: files },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

/** Reuse one resource id per event, room, and attachment so a retry cannot duplicate it. */
function stableResourceID(eventId: string, roomId: string, index: number): string {
  const hex = createHash("sha256").update(`${eventId}:${roomId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Adapter downloads live in a private temp directory. Only accept that shape so
 * an adapter cannot ask the server to import an arbitrary local file.
 */
function readableAdapterFile(value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  const prefix = path.join(os.tmpdir(), "chat-room-channeld-");
  return path.resolve(value).startsWith(prefix) ? path.resolve(value) : undefined;
}

export async function inboundAttachments(event: IngestEvent, roomId: string): Promise<string[]> {
  const attachments = event.content?.attachments ?? [];
  const markers: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.error) {
      markers.push(`[attachment unavailable: ${attachment.error}]`);
      continue;
    }
    const file = readableAdapterFile(attachment.path);
    if (!file) {
      markers.push("[attachment unavailable: no local file]");
      continue;
    }
    try {
      const info = await fs.stat(file);
      if (!info.isFile() || info.size > maxResourceBytes()) throw new Error("file is not a regular file within the upload limit");
      const resource = await uploadResource(
        roomId,
        attachment.name || `${attachment.kind}-${index + 1}`,
        Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>,
        maxResourceBytes(),
        { sessionID: `channel:${event.source.accountId}`, name: `${platformLabel(event.source.platform)} ${event.source.accountId}` },
        stableResourceID(event.eventId, roomId, index),
      );
      markers.push(`[[resource:${resource.id}]]`);
    } catch (error) {
      markers.push(`[attachment upload failed: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return markers;
}