import { stat } from "node:fs/promises";
import { findResource, maxResourceBytes, resourcePath, uploadResource, type Resource } from "../src/resources";
import { readState } from "../src/store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeHeaders = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Accept-Ranges": "bytes" };

function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function resourceRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const upload = url.pathname.match(/^\/rooms\/([^/]+)\/resources$/);
  const item = url.pathname.match(/^\/rooms\/([^/]+)\/resources\/([^/]+)(\/content)?$/);
  if ((!upload || req.method !== "POST") && (!item || req.method !== "GET")) return undefined;
  try {
    const roomID = decodeURIComponent((upload ?? item)![1]!);
    if (upload) {
      const sessionID = req.headers.get("x-session-id") ?? "";
      if (!sessionID || !await readState((_svc, registry) => Boolean(registry[roomID]?.[sessionID]))) return json({ error: "forbidden" }, 403);
      const encoded = req.headers.get("x-file-name");
      if (!encoded) return json({ error: "invalid filename" }, 400);
      let filename: string;
      try { filename = decodeURIComponent(encoded); } catch { return json({ error: "invalid filename" }, 400); }
      if (!filename || filename.length > 255 || /[\\/\r\n\0]/.test(filename) || filename === "." || filename === "..") return json({ error: "invalid filename" }, 400);
      const resource = await uploadResource(roomID, filename, req.body ?? new Blob([]).stream(), maxResourceBytes());
      return json({ resource }, 201);
    }
    const id = decodeURIComponent(item![2]!);
    if (!uuid.test(id)) return json({ error: "resource not found" }, 404);
    const resource = await findResource(roomID, id);
    if (!resource) return json({ error: "resource not found" }, 404);
    if (!item![3]) return json({ resource });
    return await content(req, resource);
  } catch (error) {
    if (error instanceof URIError) return json({ error: "invalid resource request" }, 400);
    const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
    if (status >= 400 && status < 500) return json({ error: status === 413 ? "file exceeds maximum size" : status === 404 ? "resource not found" : status === 403 ? "forbidden" : "invalid resource request" }, status);
    return json({ error: "internal server error" }, 500);
  }
}

async function content(req: Request, resource: Resource): Promise<Response> {
  const path = resourcePath(resource);
  const info = await stat(path);
  const range = req.headers.get("range");
  if (range && info.size === 0) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": "bytes */0" } });
  if (info.size === 0) return new Response(null, { headers: { ...safeHeaders, "Content-Type": resource.mimeType, "Content-Disposition": contentDisposition(resource.name, false), "Content-Length": "0" } });
  let start = 0, end = info.size - 1, status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": `bytes */${info.size}` } });
    if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": `bytes */${info.size}` } }); start = Math.max(0, info.size - suffix); }
    else { start = Number(match[1]); if (!Number.isSafeInteger(start)) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": `bytes */${info.size}` } }); }
    if (match[1] && match[2]) { const requestedEnd = Number(match[2]); if (!Number.isSafeInteger(requestedEnd)) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": `bytes */${info.size}` } }); end = Math.min(requestedEnd, end); }
    if (start >= info.size || end < start) return new Response(null, { status: 416, headers: { ...safeHeaders, "Content-Range": `bytes */${info.size}` } });
    status = 206;
  }
  const inline = /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|ogg|wav)|video\/(mp4|webm))$/.test(resource.mimeType);
  const headers = new Headers({ ...safeHeaders, "Content-Type": resource.mimeType, "Content-Disposition": contentDisposition(resource.name, inline), "Content-Length": String(end - start + 1) });
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  return new Response(Bun.file(path).slice(start, end + 1).stream(), { status, headers });
}
