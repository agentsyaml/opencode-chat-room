import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Resource } from "./resources";

type PermissionContext = { directory: string; worktree?: string; ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void> };
type UploadOptions = { center: string; token: string };

export async function uploadAgentResource(opts: UploadOptions, roomID: string, filePath: string, sessionID: string, context: PermissionContext): Promise<string> {
  if (!opts.center) return "error: resource uploads require CHAT_ROOM_SERVER_URL (central server mode)";
  if (!roomID) return "error: roomId is required";
  if (!filePath?.trim()) return "error: filePath is required";
  const absolute = path.resolve(context.directory, filePath);
  const directory = path.dirname(absolute);
  const root = context.worktree ?? context.directory;
  if (!inside(root, absolute)) {
    await context.ask({ permission: "external_directory", patterns: [directory], always: [directory], metadata: { filepath: absolute } });
  }
  await context.ask({ permission: "read", patterns: [absolute], always: [], metadata: { filepath: absolute } });
  const actual = await realpath(absolute);
  if (actual !== absolute) {
    const targetDirectory = path.dirname(actual);
    if (!inside(root, actual)) await context.ask({ permission: "external_directory", patterns: [targetDirectory], always: [targetDirectory], metadata: { filepath: actual } });
    await context.ask({ permission: "read", patterns: [actual], always: [], metadata: { filepath: actual } });
  }
  const info = await stat(actual);
  if (!info.isFile()) return "error: filePath must name a regular file";
  const name = path.basename(absolute);
  const headers: Record<string, string> = {
    "X-Session-ID": sessionID,
    "X-File-Name": encodeURIComponent(name),
    "Content-Type": "application/octet-stream",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const response = await fetch(`${opts.center}/rooms/${encodeURIComponent(roomID)}/resources`, {
    method: "POST", headers, body: Bun.file(actual).stream(),
    redirect: "error",
    // Large transfers need more than the JSON client's ten-second deadline.
    signal: AbortSignal.timeout(30 * 60_000),
    // @ts-expect-error Bun supports streaming request bodies without buffering.
    duplex: "half",
  });
  const data = await response.json().catch(() => ({})) as { resource?: Resource; error?: string };
  if (!response.ok || !data.resource) throw new Error(data.error ?? `upload failed (${response.status})`);
  return `${JSON.stringify(data.resource)}\n[[resource:${data.resource.id}]]\nThe upload alone is invisible. To display this attachment, include the marker above unchanged in a send message, outside backticks or code blocks.`;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
