import { countOpenQuestions, readHistory } from "../src/store";
import type { Room } from "../src/room-service";
import { binding, tx } from "./admin-state";

// Initial page of history sent when a room is opened; older pages load on scroll.
export const ROOM_WINDOW = 100;

// Room meta + participants from memory, messages as a bounded newest-first page
// from SQLite so opening a room never downloads the whole history.
export async function roomPayload(room: Room, limit = ROOM_WINDOW) {
  const page = await readHistory(room.id, undefined, limit);
  const admin = await tx(db => binding(db, room.id));
  const openQuestions = await countOpenQuestions(room.id);
  return {
    id: room.id,
    name: room.name,
    description: room.description ?? "",
    ownerId: room.ownerId,
    createdAt: room.createdAt,
    participants: [...room.participants.values()],
    messages: page.messages,
    kind: room.kind ?? "group",
    ...(room.directSessionIDs ? { directSessionIDs: room.directSessionIDs } : {}),
    hasMore: page.hasMore,
    nextBeforeSeq: page.nextBeforeSeq,
    adminSessionID: admin?.session_id ?? null,
    openQuestions,
  };
}
