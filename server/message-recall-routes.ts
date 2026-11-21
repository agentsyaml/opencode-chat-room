import { recallMessage, revealMessageContent } from "../src/state/store.ts";
import { jsonObject } from "./json-body.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MAX_SESSION = 128;

export async function messageRecallRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const recall = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)\/recall$/);
  if (recall) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const roomID = decodeURIComponent(recall[1]!);
    const messageID = decodeURIComponent(recall[2]!);
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID.trim() : "";
    if (!sessionID || sessionID.length > MAX_SESSION) return json({ error: "sessionID is required" }, 400);
    const result = await recallMessage(roomID, messageID, sessionID);
    if (result.status === "missing") return json({ error: "message not found" }, 404);
    if (result.status === "member") return json({ error: "session is not a room member" }, 409);
    if (result.status === "forbidden") return json({ error: "not allowed to recall this message" }, 403);
    if (result.status !== "ok") return json({ error: "recall failed" }, 409);
    return json({ ok: true, messageID: result.messageID, recalledAt: result.recalledAt, recalledBy: result.recalledBy });
  }
  const content = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)\/content$/);
  if (!content) return undefined;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const roomID = decodeURIComponent(content[1]!);
  const messageID = decodeURIComponent(content[2]!);
  const sessionID = url.searchParams.get("sessionID") ?? "";
  if (!sessionID || sessionID.length > MAX_SESSION) return json({ error: "sessionID is required" }, 400);
  const result = await revealMessageContent(roomID, messageID, sessionID);
  if (result.status === "missing") return json({ error: "message not found" }, 404);
  if (result.status === "member") return json({ error: "session is not a room member" }, 409);
  if (result.status === "hidden") return json({ error: "message is not recalled" }, 409);
  if (result.status !== "ok") return json({ error: "message not found" }, 404);
  return json({ messageID: result.messageID, text: result.text, senderId: result.senderId, createdAt: result.createdAt, recalledAt: result.recalledAt });
}