// Stable message addressing for clients resuming after a restart: fetch one
// message by ID, or page forward from a persisted seq. Both endpoints are
// member-only and use a uniform 404 so they reveal neither room nor message.
import { explicitlyAddresses } from "../src/center/mentions.ts";
import type { HistoryMessage } from "../src/state/sqlite-state.ts";
import { countOpenQuestions, readHistory, readMessage, readOpenQuestionRefs, readState } from "../src/state/store.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MAX_SESSION = 128;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Resource attachments are referenced by a UUID marker in the message text.
const RESOURCE_MARKER = /\[\[resource:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\]/gi;

type MemberContext = {
  allowed: boolean;
  name: string;
  roomKind: "group" | "direct";
  senderNames: Map<string, string>;
};

function decode(value: string): string | undefined {
  try { return decodeURIComponent(value); }
  catch { return undefined; }
}

async function memberContext(roomID: string, sessionID: string): Promise<MemberContext> {
  return readState((service, registry) => {
    const room = service.listRooms().find((candidate) => candidate.id === roomID);
    const entry = sessionID && sessionID.length <= MAX_SESSION ? registry[roomID]?.[sessionID] : undefined;
    // Pending and kicked sessions have no registry entry; a stale entry without
    // a participant is not a membership either.
    const allowed = Boolean(room && entry) && (room!.kind === "direct"
      ? Boolean(room!.directSessionIDs?.includes(sessionID))
      : service.containsParticipant(roomID, entry!.name));
    return {
      allowed,
      name: entry?.name ?? "",
      roomKind: room?.kind === "direct" ? "direct" : "group",
      senderNames: new Map([...room?.participants.values() ?? []].map((participant) => [participant.id, participant.name])),
    };
  });
}

function extractResourceIDs(text: string): string[] {
  return [...new Set([...text.matchAll(RESOURCE_MARKER)].map((match) => match[1]!))];
}

function messageView(message: HistoryMessage, senderName: string) {
  if (message.recalledAt !== undefined) {
    // A tombstone exposes only addressing metadata: never the original text or
    // the resources it referenced.
    return {
      id: message.id, roomId: message.roomId, seq: message.seq, senderId: message.senderId,
      createdAt: message.createdAt, recalled: true as const, recalledAt: message.recalledAt,
      recalledBy: message.recalledBy ?? null, text: null, unavailable: "recalled" as const, resourceIDs: [] as string[],
    };
  }
  return {
    id: message.id, roomId: message.roomId, seq: message.seq, senderId: message.senderId, senderName,
    text: message.text, createdAt: message.createdAt, isQuestion: message.isQuestion === true,
    parentMessageId: message.answerToMessageID ?? null, answeredByMessageId: message.answeredByMessageID ?? null,
    recalled: false as const, resourceIDs: extractResourceIDs(message.text),
  };
}

async function getMessage(req: Request, url: URL, match: RegExpMatchArray): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const roomID = decode(match[1]!), messageID = decode(match[2]!);
  if (roomID === undefined || messageID === undefined) return json({ error: "not found" }, 404);
  const sessionID = url.searchParams.get("sessionID") ?? "";
  const access = await memberContext(roomID, sessionID);
  if (!access.allowed) return json({ error: "not found" }, 404);
  const message = await readMessage(roomID, messageID);
  if (!message) return json({ error: "not found" }, 404);
  return json(messageView(message, access.senderNames.get(message.senderId) ?? message.senderId));
}

async function catchUp(req: Request, url: URL, match: RegExpMatchArray): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const roomID = decode(match[1]!);
  if (roomID === undefined) return json({ error: "not found" }, 404);
  const afterText = url.searchParams.get("afterSeq");
  const limitText = url.searchParams.get("limit");
  // Reject anything that is not a plain non-negative integer: Number("") and
  // Number("1.5") would otherwise silently become different cursors.
  if ((afterText !== null && !/^\d+$/.test(afterText)) || (limitText !== null && !/^\d+$/.test(limitText))) {
    return json({ error: "afterSeq must be a non-negative integer and limit must be 1-200" }, 400);
  }
  const afterSeq = afterText === null ? 0 : Number(afterText);
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return json({ error: "afterSeq must be a non-negative integer and limit must be 1-200" }, 400);
  }
  const sessionID = url.searchParams.get("sessionID") ?? "";
  const access = await memberContext(roomID, sessionID);
  if (!access.allowed) return json({ error: "not found" }, 404);
  // Strictly read-only: no receipts, read cursor, admission update, wake, model
  // call, or any other write. Catch-up can be retried and shared safely.
  const page = await readHistory(roomID, undefined, limit, undefined, afterSeq);
  const messages = page.messages.map((message) =>
    messageView(message, access.senderNames.get(message.senderId) ?? message.senderId));
  const unreadMentions = page.messages
    .filter((message) => message.recalledAt === undefined &&
      explicitlyAddresses(message, access.name, sessionID, access.roomKind))
    .map((message) => ({ id: message.id, seq: message.seq }));
  // Open questions are room-wide. The array is capped at 200 refs so the
  // response stays bounded; the count always reports the total open questions.
  const [unansweredQuestions, unansweredQuestionCount] = await Promise.all([
    readOpenQuestionRefs(roomID),
    countOpenQuestions(roomID),
  ]);
  return json({
    messages,
    nextCursor: page.messages.at(-1)?.seq ?? afterSeq,
    hasMore: page.hasMore,
    unreadMentions,
    unreadMentionCount: unreadMentions.length,
    unansweredQuestions,
    unansweredQuestionCount,
  });
}

export async function addressingRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const message = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)$/);
  if (message) return getMessage(req, url, message);
  const resume = url.pathname.match(/^\/rooms\/([^/]+)\/catch-up$/);
  if (resume) return catchUp(req, url, resume);
  return undefined;
}