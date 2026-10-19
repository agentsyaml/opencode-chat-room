import { readInboxMessages } from "../src/store";
import type { Message } from "../src/room-service";

export type InboxItem = Pick<Message, "id" | "roomId" | "senderId" | "text" | "createdAt"> & { roomName: string };
export type InboxResult = { member: boolean; items: InboxItem[]; queuedTs: Record<string, number>; hasMore: boolean };

export async function readInbox(sessionID: string, roomFilter: string | null, excludeSelf: boolean): Promise<InboxResult> {
  return readInboxMessages(sessionID, roomFilter, excludeSelf, excludeSelf ? 20 : 100);
}
