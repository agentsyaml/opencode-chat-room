import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

type Options = { center: string; token: string };
type Permission = { ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const limit = 512 * 1024 * 1024;

export class ResourceReadError extends Error {
  constructor(readonly code: "invalid" | "permission_denied" | "size_limit" | "not_found" | "aborted" | "network" | "save_failed", message: string) { super(message); }
}
export function resourceReadFailure(error: unknown): string {
  return error instanceof ResourceReadError ? error.message : "resource read failed; verify roomId and resourceId, check the server connection, then retry";
}

export async function readAgentResource(opts: Options, roomID: string, id: string, permission: Permission, signal?: AbortSignal) {
  if (!opts.center) throw new Error("resource viewing requires CHAT_ROOM_SERVER_URL (central server mode)");
  if (!roomID) throw new ResourceReadError("invalid", "roomId is required for read_resource; use the room UUID, not the room name");
  if (!id) throw new ResourceReadError("invalid", "resourceId is required for read_resource; use the resource UUID returned by upload_resource");
  if (!uuid.test(roomID)) throw new ResourceReadError("invalid", "invalid roomId; use the room UUID, not the room name");
  if (!uuid.test(id)) throw new ResourceReadError("invalid", "invalid resourceId; use the resource UUID returned by upload_resource");
  const base = new URL(opts.center);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("invalid chat server URL");
  await ask(permission, "webfetch", [base.origin], { url: base.origin });
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const root = `${base.origin}${base.pathname.replace(/\/$/, "")}`;
  const requestSignal = combineSignal(signal, 30_000);
  let configuredLimit: number | undefined;
  try {
    const response = await fetchSafe(`${root}/resources/config`, { headers, redirect: "error", signal: requestSignal }, signal);
    if (response.ok) {
      const config = await response.json() as { maxFileSizeBytes?: number };
      if (Number.isSafeInteger(config.maxFileSizeBytes) && config.maxFileSizeBytes! > 0) configuredLimit = config.maxFileSizeBytes;
    }
  } catch (error) { if (error instanceof ResourceReadError && error.code === "aborted") throw error; }
  const allowed = Math.min(limit, configuredLimit ?? limit);
  const limitNote = configuredLimit ? `server limit ${Math.min(limit, configuredLimit)} bytes` : "512 MiB safety cap (server limit unavailable)";
  const endpoint = `${root}/rooms/${roomID}/resources/${id}`;
  const metadataResponse = await fetchSafe(endpoint, { headers, redirect: "error", signal: requestSignal }, signal);
  if (metadataResponse.status === 404) throw new ResourceReadError("not_found", "resource not found in this room; check both IDs and that you joined the room");
  if (metadataResponse.status === 401) throw new ResourceReadError("permission_denied", "server requires a valid access token; set CHAT_ROOM_SERVER_TOKEN and retry");
  if (metadataResponse.status === 403) throw new ResourceReadError("permission_denied", "server denied resource access; check that you joined this room and the token is valid");
  if (!metadataResponse.ok) throw new ResourceReadError("network", "could not retrieve resource metadata; check the server connection and retry");
  const metadata = await metadataResponse.json() as { resource?: { id?: string; roomID?: string; mimeType?: string; size?: number; name?: string } };
  const resource = metadata.resource;
  if (resource && Number.isSafeInteger(resource.size) && resource.size! > allowed) throw new ResourceReadError("size_limit", `resource exceeds the ${limitNote}`);
  if (!resource || resource.id !== id || resource.roomID !== roomID || typeof resource.name !== "string" || typeof resource.mimeType !== "string" || !Number.isSafeInteger(resource.size) || resource.size! < 0) throw new ResourceReadError("network", "resource metadata is invalid; verify roomId and resourceId, then retry");
  const verified: Resource = { id: resource.id!, roomID: resource.roomID!, name: resource.name, mimeType: resource.mimeType, size: resource.size! };
  return saveResource(permission, headers, endpoint, verified, allowed, signal, limitNote);
}

type Resource = { id: string; roomID: string; mimeType: string; size: number; name: string };
async function saveResource(permission: Permission, headers: Record<string, string>, endpoint: string, resource: Resource, allowed: number, signal: AbortSignal | undefined, limitNote: string): Promise<string> {
  const tmp = os.tmpdir();
  await ask(permission, "external_directory", [tmp], { filepath: tmp });
  const directory = await fs.mkdtemp(path.join(tmp, "opencode-chat-room-"));
  const extension = path.extname(resource.name).toLowerCase();
  const filename = `${randomUUID()}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"}`;
  const filepath = path.join(directory, filename);
  try {
    await fs.chmod(directory, 0o700);
    await ask(permission, "edit", [filepath], { filepath });
    await ask(permission, "read", [filepath], { filepath });
    const response = await fetchSafe(`${endpoint}/content`, { headers, redirect: "error", signal: combineSignal(signal, 30 * 60_000) }, signal);
    if (response.status === 404) throw new ResourceReadError("not_found", "resource not found in this room; check both IDs and that you joined the room");
    if (response.status === 401) throw new ResourceReadError("permission_denied", "server requires a valid access token; set CHAT_ROOM_SERVER_TOKEN and retry");
    if (response.status === 403) throw new ResourceReadError("permission_denied", "server denied resource access; check that you joined this room and the token is valid");
    if (response.status === 413) throw new ResourceReadError("size_limit", "resource exceeds the server download limit");
    if (!response.ok || !response.body) throw new ResourceReadError("network", "could not retrieve resource content; check the server connection and retry");
    const file = await fs.open(filepath, "wx", 0o600);
    try { await streamToFile(response.body, file, Math.min(allowed, resource.size), signal); }
    finally { await file.close(); }
    const info = await fs.stat(filepath);
    if (info.size !== resource.size) throw new Error("resource size does not match metadata");
    return `Saved ${safeDisplayName(resource.name)} (${resource.mimeType}, ${info.size} bytes) to ${filepath}; used ${limitNote}. The private temporary file remains until you remove it or the operating system cleans temporary files.`;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ResourceReadError) throw error;
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new ResourceReadError("aborted", "resource download was canceled");
    throw new ResourceReadError("save_failed", "could not save resource to private temporary storage");
  }
}

async function streamToFile(body: ReadableStream<Uint8Array>, file: Awaited<ReturnType<typeof fs.open>>, limitBytes: number, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader(); let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limitBytes) throw new ResourceReadError("size_limit", "resource exceeds the configured safe limit");
      let offset = 0;
      while (offset < value.byteLength) {
        let result;
        try { result = await file.write(value, offset, value.byteLength - offset); }
        catch { throw new ResourceReadError("save_failed", "could not write resource to private temporary storage"); }
        if (!result.bytesWritten) throw new Error("temporary file write made no progress");
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ResourceReadError) throw error;
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new ResourceReadError("aborted", "resource download was canceled");
    throw new ResourceReadError("network", "resource download was interrupted; retry");
  }
  finally { reader.releaseLock(); }
}

function combineSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
async function ask(permission: Permission, action: string, patterns: string[], metadata: Record<string, unknown>): Promise<void> {
  try { await permission.ask({ permission: action, patterns, always: [], metadata }); }
  catch { throw new ResourceReadError("permission_denied", `host denied ${action} permission for resource download`); }
}
async function fetchSafe(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new ResourceReadError("aborted", "resource download was canceled");
    throw new ResourceReadError("network", "resource server request failed or timed out");
  }
}
function safeDisplayName(name: string): string { return path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "attachment"; }
