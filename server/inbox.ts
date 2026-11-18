import { readInboxMessages } from "../src/state/store.ts";
import type { Message } from "../src/rooms/room-service.ts";

export type InboxItem = Pick<Message, "id" | "roomId" | "senderId" | "senderSessionID" | "text" | "createdAt"> & {
  roomName: string;
  roomKind?: "group" | "direct";
  answerQuestionExcerpt?: string;
};
export type InboxResult = { member: boolean; items: InboxItem[]; queuedTs: Record<string, number>; hasMore: boolean; recallVersion: number };

export async function readInbox(sessionID: string, roomFilter: string | null, excludeSelf: boolean, afterTs?: number): Promise<InboxResult> {
  return readInboxMessages(sessionID, roomFilter, excludeSelf, excludeSelf ? 20 : 100, afterTs);
}
