// Room domain shapes shared by the service layer, center clients, and tests.
// This module is type-only; the RoomService behavior stays in src/rooms.

export type Participant = {
  id: string;
  name: string;
  joinedAt: number;
};

export type Message = {
  id: string;
  roomId: string;
  senderId: string;
  senderSessionID?: string;
  text: string;
  createdAt: number;
  isQuestion?: boolean;
  answerToMessageID?: string;
  answeredByMessageID?: string;
  // Soft recall: the original text stays in storage for member reveal, while
  // read paths expose the message as a tombstone.
  recalledAt?: number;
  recalledBy?: string;
};

export type JoinPolicy = "open" | "approval";

export type Room = {
  id: string;
  name: string;
  description?: string;
  // Absent means "open" so rooms created before approvals existed stay open.
  joinPolicy?: JoinPolicy;
  ownerId: string;
  // Server-issued membership binding for the owner and the explicitly chosen successor.
  // Display names remain the public identity; the membership IDs guard against name reuse.
  ownerMembershipID?: string;
  successorId?: string;
  successorMembershipID?: string;
  // Humans authorized by the owner or another admin; the owner is always an admin.
  adminIds?: string[];
  // Server-issued membership bindings matching adminIds, so a same-name session
  // does not inherit delegation. Missing for legacy rooms; names are the fallback.
  adminMembershipIDs?: string[];
  participants: Map<string, Participant>;
  messages: Message[];
  createdAt: number;
  kind?: "group" | "direct";
  directSessionIDs?: string[];
  directPair?: string;
};