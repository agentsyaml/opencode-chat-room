import { memberActivity, type WorkState } from "../src/member-state";
import { acknowledgeReadWithReceipts, readReceipts, readState, recordMessageReceipts, reportPresence, writeState, type ReceiptEvidence, type ReceiptIdentity } from "../src/store";
import { isReceiverOwnerID } from "../src/receiver-owner";
import { clearPendingAdmission } from "../src/queue";
import { touchActive } from "./wake";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const states = new Set<WorkState>(["working", "idle", "waiting", "unknown"]);
type Report = { sessionID: string; receiverOwnerID?: string; state: WorkState };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function memberRoutes(req: Request, url: URL): Promise<Response | undefined> {
  if (req.method === "POST" && url.pathname === "/read") {
    const body = (await req.json()) as Record<string, unknown>;
    const ts = body.ts;
    const roomId = String(body.roomId ?? "");
    const sessionID = String(body.sessionID ?? "");
    const messageIDs = body.messageIDs;
    const hasReceipts = messageIDs !== undefined;
    if (
      body.ts === undefined ||
      body.ts === null ||
      !roomId ||
      !sessionID ||
      typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0 ||
      (hasReceipts && (!Array.isArray(messageIDs) || !messageIDs.length || messageIDs.length > 500 || messageIDs.some((id) => typeof id !== "string" || !id || id.length > 128) ||
        typeof body.membershipID !== "string" || !body.membershipID || body.membershipID.length > 128 ||
        typeof body.evidence !== "string" || !["displayed", "tool", "context"].includes(body.evidence) ||
        (body.receiverOwnerID !== undefined && !isReceiverOwnerID(body.receiverOwnerID))))
    ) {
      return json({ error: "invalid read acknowledgement" }, 400);
    }
    if (hasReceipts) {
      const result = await acknowledgeReadWithReceipts(roomId, sessionID, ts, messageIDs as string[], body.evidence as ReceiptEvidence, {
        membershipID: body.membershipID as string,
        ...(typeof body.receiverOwnerID === "string" ? { receiverOwnerID: body.receiverOwnerID } : {}),
      });
      if (result.status === "membership") return json({ error: "membership generation mismatch" }, 409);
      if (result.status === "messageIDs") return json({ error: "message IDs do not belong to this room" }, 400);
      if (result.status !== "ok") return json({ error: "read acknowledgement rejected" }, 400);
      clearPendingAdmission(sessionID, roomId, result.readThroughTs ?? 0);
      touchActive(sessionID);
      return json({ ok: true, acceptedIDs: result.acceptedIDs });
    }
    const updated = await writeState((svc, reg) => {
      const entry = reg[roomId]?.[sessionID];
      if (!entry) return false;
      const actualTs = Math.min(ts, svc.getMessages(roomId).at(-1)?.createdAt ?? 0);
      if (actualTs > 0) entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, actualTs);
      return { actualTs };
    });
    if (!updated) return json({ error: "registry entry not found" }, 404);
    clearPendingAdmission(sessionID, roomId, updated.actualTs);
    touchActive(sessionID);
    return json({ ok: true });
  }
  const receiptRoute = url.pathname.match(/^\/rooms\/([^/]+)\/receipts$/);
  if (req.method === "POST" && receiptRoute) {
    const body: unknown = await req.json();
    if (!object(body)) return json({ error: "JSON object body is required" }, 400);
    const sessionID = body.sessionID, membershipID = body.membershipID, evidence = body.evidence;
    const ids = body.messageIDs;
    const ownerID = body.receiverOwnerID;
    if (typeof sessionID !== "string" || !sessionID || sessionID.length > 128 ||
      typeof membershipID !== "string" || !membershipID || membershipID.length > 128 ||
      !Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id) => typeof id !== "string" || !id || id.length > 128) ||
      typeof evidence !== "string" || !["displayed", "tool", "context"].includes(evidence) ||
      (ownerID !== undefined && !isReceiverOwnerID(ownerID))) return json({ error: "invalid message receipt" }, 400);
    const identity: ReceiptIdentity = { membershipID, ...(typeof ownerID === "string" ? { receiverOwnerID: ownerID } : {}) };
    const result = await recordMessageReceipts(decodeURIComponent(receiptRoute[1]!), sessionID, ids as string[], evidence as ReceiptEvidence, identity);
    if (result.status === "membership") return json({ error: "membership generation mismatch" }, 409);
    if (result.status === "messageIDs") return json({ error: "message IDs do not belong to this room" }, 400);
    return json({ acceptedIDs: result.acceptedIDs });
  }
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/(members|receipts)$/);
  if (req.method === "GET" && match) {
    const roomID = decodeURIComponent(match[1]!);
    if (match[2] === "members") return json(await readState((svc, registry) => {
      svc.getRoom(roomID);
      return Object.entries(registry[roomID] ?? {}).map(([sessionID, entry]) => ({
        sessionID, membershipID: entry.membershipID!, name: entry.name, ...(entry.protocol ? { protocol: entry.protocol } : {}),
        ...(entry.host ? { host: entry.host } : {}),
        type: entry.protocol === "v1" || entry.protocol === "v2" || Boolean(entry.host) ? "agent" : "human",
        activity: memberActivity(entry),
      }));
    }));
    const registry = await readState((svc, entries) => { svc.getRoom(roomID); return entries[roomID] ?? {}; });
    const filter = url.searchParams.get("messageIDs");
    const ids = filter === null ? undefined : filter.split(",");
    if (ids && (!ids.length || ids.length > 500 || ids.some((id) => !id || id.length > 128))) return json({ error: "invalid message IDs" }, 400);
    const receipts = await readReceipts(roomID, ids);
    if (!receipts) return json({ error: "message IDs do not belong to this room" }, 400);
    return json({ receipts: receipts.map((item) => ({ messageID: item.messageID, readers: item.readers.map((reader) => ({ ...reader, currentMember: Boolean(registry[reader.sessionID]) })) })), semantics: "per-message" });
  }
  if (req.method !== "POST" || url.pathname !== "/presence") return undefined;
  const body: unknown = await req.json();
  if (!object(body) || !Array.isArray(body.sessions) || body.sessions.length > 200) return json({ error: "sessions must be an array of at most 200 reports" }, 400);
  const ownerID = body.ownerID;
  const sequence = body.sequence;
  if ((ownerID !== undefined && !isReceiverOwnerID(ownerID)) ||
    (ownerID === undefined && sequence !== undefined) ||
    (ownerID !== undefined && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0))) return json({ error: "invalid owner sequence" }, 400);
  const reports = new Map<string, Report>();
  for (const item of body.sessions) {
    if (!object(item) || typeof item.sessionID !== "string" || !item.sessionID || item.sessionID.length > 128 ||
      typeof item.state !== "string" || !states.has(item.state as WorkState) ||
      (item.receiverOwnerID !== undefined && (!isReceiverOwnerID(item.receiverOwnerID) || item.receiverOwnerID !== ownerID)) ||
      (ownerID === undefined && item.receiverOwnerID !== undefined)) return json({ error: "invalid presence report" }, 400);
    reports.set(item.sessionID, { sessionID: item.sessionID, state: item.state as WorkState,
      ...(typeof ownerID === "string" ? { receiverOwnerID: ownerID } : {}) });
  }
  const result = await reportPresence([...reports.values()], ownerID as string | undefined, sequence as number | undefined);
  return json({ updatedSessionIDs: result.stale ? [] : result.updatedSessionIDs });
}
