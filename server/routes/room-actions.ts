// Join, leave and message append routes for a single room.
import { appendRoomMessage, databasePath, readState, sendReply, writeState } from "../../src/state/store.ts";
import { saveJoinRequest, writeSqliteStateWithDatabase } from "../../src/state/sqlite-state.ts";
import { isReceiverOwnerID } from "../../src/state/receiver-owner.ts";
import { jsonObject } from "../json-body.ts";
import { isUser, settleAdmins, settleOwner } from "../room-owner.ts";
import { joinRoomMember } from "../room-join.ts";
import { roomPayload } from "../room-payload.ts";
import { touchActive, wakeMentionedSessions } from "../wake.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function roomActionRoutes(req: Request, url: URL, serveWakeUrl: string): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/rooms\/([^/]+)\/(join|leave|messages)$/);
  if (!m) return undefined;
  const roomId = decodeURIComponent(m[1]!);
  const body = await jsonObject<Record<string, string>>(req);
  if (!body) return json({ error: "JSON object body is required" }, 400);
  const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
  if (req.method === "POST" && m[2] === "join") {
    if (body.protocol !== undefined && body.protocol !== "v2" || body.receiverOwnerID !== undefined && !isReceiverOwnerID(body.receiverOwnerID)) {
      return json({ error: "invalid receiver ownership" }, 400);
    }
    // ponytail: F4/F5 — names must be non-empty, and re-joining under a
    // new name must retire the old participant (no ghost members)
    const id = typeof body.participantId === "string" ? body.participantId.trim() : "";
    const name = typeof body.participantName === "string" ? body.participantName.trim() : "";
    if (!id || !name || !sessionID) {
      return json(
        { error: "participantId/participantName/sessionID are required" },
        400,
      );
    }
    if (id.length > 64 || name.length > 64) {
      return json({ error: "name too long (max 64)" }, 400);
    }
    const result = await writeSqliteStateWithDatabase(databasePath(), (svc, reg, db) => {
      const currentRoom = svc.getRoom(roomId);
      // A restricted room treats a new identity as a pending request; no
      // participant or registry entry exists until a reviewer approves.
      if (currentRoom.joinPolicy === "approval" && currentRoom.kind !== "direct" && !reg[roomId]?.[sessionID]) {
        if (svc.containsParticipant(roomId, id)) return { status: 409 as const, error: "participant name is already in use in this room" };
        const duplicate = db.query("SELECT 1 FROM room_join_requests WHERE room_id=? AND session_id<>? AND (participant_id=? OR name=?)").get(roomId, sessionID, id, name);
        if (duplicate) return { status: 409 as const, error: "participant name is already in use in this room" };
        saveJoinRequest(db, {
          roomID: roomId, sessionID, participantId: id, name,
          isAgent: Boolean(body.protocol || body.receiverOwnerID || body.host),
          createdAt: Date.now(),
          ...(body.protocol === "v2" ? { protocol: "v2" as const } : {}),
          ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
          ...(body.directory ? { directory: body.directory } : {}),
          ...(body.host ? { host: body.host } : {}),
        });
        return { pending: true as const };
      }
      return { room: joinRoomMember(svc, reg, roomId, {
        sessionID, participantId: id, name,
        ...(body.protocol === "v2" ? { protocol: "v2" as const } : {}),
        ...(body.protocol === "v2" && isReceiverOwnerID(body.receiverOwnerID) ? { receiverOwnerID: body.receiverOwnerID } : {}),
        ...(body.directory ? { directory: body.directory } : {}),
        host: body.host ?? "",
      }) };
    });
    if ("status" in result) return json({ error: result.error }, result.status);
    if ("pending" in result) return json({
      status: "pending",
      message: "Join request submitted. You are not a member yet; a human administrator must approve it before you can send or poll.",
    }, 202);
    touchActive(sessionID); // join = active
    return json(await roomPayload(result.room), 201);
  }
  if (req.method === "POST" && m[2] === "leave") {
    await writeState((svc, reg) => {
      const room = svc.getRoom(roomId);
      const entry = reg[roomId]?.[sessionID];
      const participantId = room.kind === "direct" ? sessionID : entry?.name ?? sessionID;
      // Shared-name guard: when another session still holds this name, remove
      // only this registry entry, not the participant (otherwise a sibling tab
      // would start getting NOT_JOINED).
      const shared = Object.entries(reg[roomId] ?? {}).some(
        ([sid, e]) => e.name === participantId && sid !== sessionID,
      );
      if (!shared) {
        svc.leaveRoom(roomId, participantId);
        svc.addEvent(roomId, `${participantId} left the room`);
      }
      if (reg[roomId]) {
        delete reg[roomId][sessionID];
        if (Object.keys(reg[roomId]).length === 0) {
          delete reg[roomId];
        }
      }
      // A departing delegated admin passes the role to the room's explicit successor.
      if (entry?.name && room.ownerId && (room.adminIds ?? []).includes(entry.name)) {
        const successor = Object.values(reg[roomId] ?? {}).find((candidate) =>
          isUser(candidate) && (room.successorMembershipID ? candidate.membershipID === room.successorMembershipID : candidate.name === room.successorId));
        if (successor?.name && successor.name !== room.ownerId) {
          room.adminIds = [...new Set([...(room.adminIds ?? []).filter((name) => name !== successor.name), successor.name])];
          if (successor.membershipID) room.adminMembershipIDs = [...new Set([...(room.adminMembershipIDs ?? []).filter((id) => id !== successor.membershipID), successor.membershipID])];
        }
      }
      if (entry && (room.successorMembershipID ? entry.membershipID === room.successorMembershipID : entry.name === room.successorId)) {
        delete room.successorId;
        delete room.successorMembershipID;
      }
      // A departing owner hands the room to the next person; the last one leaves it open.
      settleAdmins(svc.getRoom(roomId), reg[roomId] ?? {});
      settleOwner(svc.getRoom(roomId), reg[roomId] ?? {});
    });
    return json({ ok: true });
  }
  if (req.method === "POST" && m[2] === "messages") {
    const isQuestion = (body as Record<string, unknown>).isQuestion;
    if (isQuestion !== undefined && typeof isQuestion !== "boolean") return json({ error: "isQuestion must be a boolean" }, 400);
    // ponytail: F3 — mirror the plugin's zod limit at the HTTP boundary
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return json({ error: "text is required" }, 400);
    }
    if (text.length > 5000) {
      return json({ error: "text too long (max 5000)" }, 400);
    }
    // parentMessageId is the addressing alias of the web client's reply field.
    const replyTo = (body as Record<string, unknown>).replyToMessageID ?? (body as Record<string, unknown>).parentMessageId;
    if (replyTo !== undefined && (typeof replyTo !== "string" || !replyTo)) return json({ error: "parentMessageId must be a non-empty message ID" }, 400);
    // Optional retry key: a lost response may be retried without creating a twin.
    const clientMessageID = (body as Record<string, unknown>).clientMessageID;
    if (clientMessageID !== undefined && (typeof clientMessageID !== "string" || !clientMessageID || clientMessageID.length > 100)) {
      return json({ error: "clientMessageID must be a non-empty string (max 100)" }, 400);
    }
    if (replyTo !== undefined) {
      const result = await sendReply(roomId, replyTo, sessionID, text, clientMessageID);
      if (result.status !== "ok") {
        if (result.status === "missing") return json({ error: "room not found" }, 404);
        if (result.status === "target") return json({ error: "reply target not found in room" }, 404);
        if (result.status === "recalled") return json({ error: "reply target was recalled" }, 409);
        if (result.status === "question") return json({ error: "use the question answers endpoint to reply to a question" }, 409);
        // Reply addressing is member-only and uniformly missing otherwise.
        return json({ error: "not found" }, 404);
      }
      touchActive(sessionID);
      const room = await readState((svc) => svc.getRoom(roomId));
      if (!result.duplicate) void wakeMentionedSessions(serveWakeUrl, roomId, room.name, text, sessionID, result.message);
      return json(await roomPayload(room), 201);
    }
    const result = await appendRoomMessage(roomId, sessionID, text, isQuestion === true, clientMessageID);
    if (result.status !== "ok") {
      if (result.status === "missing") return json({ error: "room not found" }, 404);
      return json({ error: "session is not a room member" }, 409);
    }
    touchActive(sessionID); // sender is active
    const room = await readState((svc) => svc.getRoom(roomId));
    // Immediate wake only when the message explicitly @-mentions members.
    if (!result.duplicate) void wakeMentionedSessions(serveWakeUrl, roomId, room.name, text, sessionID, result.message);
    return json(await roomPayload(room), 201);
  }
  return undefined;
}