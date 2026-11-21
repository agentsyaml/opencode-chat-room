import { randomUUID } from "node:crypto";
import RoomService, { type Room } from "../src/rooms/room-service.ts";
import type { Registry, RegistryEntry } from "../src/state/store.ts";
import { bindOwner, isUser } from "./room-owner.ts";

export type JoinMember = {
  sessionID: string;
  participantId: string;
  name: string;
  protocol?: "v2";
  receiverOwnerID?: string;
  directory?: string;
  host?: string;
  notify?: boolean;
};

// Shared by the join endpoint and approved join requests so an approved member
// gets exactly the same membership, rename retirement, and owner binding.
export function joinRoomMember(svc: RoomService, registry: Registry, roomId: string, member: JoinMember): Room {
  const currentRoom = svc.getRoom(roomId);
  const participantId = currentRoom.kind === "direct" ? member.sessionID : member.participantId;
  const regRoom = (registry[roomId] = registry[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
  const prevEntry = regRoom[member.sessionID];
  // Retire the participant this session previously held, unless another
  // session still uses the old name.
  if (currentRoom.kind !== "direct" && prevEntry && prevEntry.name !== member.name) {
    const shared = Object.entries(regRoom).some(([sid, entry]) => sid !== member.sessionID && entry.name === prevEntry.name);
    if (!shared && svc.containsParticipant(roomId, prevEntry.name)) svc.leaveRoom(roomId, prevEntry.name);
  }
  const already = svc.containsParticipant(roomId, participantId);
  // Prune a stale registry entry for the same name from another session, but
  // only when the identity is not already present.
  if (!already && currentRoom.kind !== "direct") {
    for (const [sid, entry] of Object.entries(regRoom)) if (sid !== member.sessionID && entry.name === member.name) delete regRoom[sid];
  }
  svc.joinRoom(roomId, { id: participantId, name: member.name });
  const event = already ? undefined : svc.addEvent(roomId, `${member.name} joined the room`);
  const latestMessageTs = svc.getMessages(roomId).at(-1)?.createdAt ?? 0;
  regRoom[member.sessionID] = {
    serverUrl: "",
    apiPrefix: "/api",
    ...(member.protocol === "v2" ? { protocol: "v2" as const } : {}),
    ...(member.protocol === "v2" && member.receiverOwnerID ? { receiverOwnerID: member.receiverOwnerID } : {}),
    name: member.name,
    membershipID: prevEntry?.membershipID ?? randomUUID(),
    directory: member.directory || undefined,
    host: member.host ?? "",
    lastQueuedTs: regRoom[member.sessionID]?.lastQueuedTs,
    // An approved applicant must see the join event as unread; a normal join
    // stays quiet so joining does not create a phantom notification.
    lastReadTs: regRoom[member.sessionID]?.lastReadTs ?? (
      member.notify && event ? event.createdAt - 1 : Math.max(Date.now(), latestMessageTs)
    ),
  };
  // An ownerless room is claimed by the first person who arrives; agents never are.
  const joinedRoom = svc.getRoom(roomId);
  if (!joinedRoom.ownerId && isUser(regRoom[member.sessionID])) {
    joinedRoom.ownerId = member.name;
    joinedRoom.ownerMembershipID = regRoom[member.sessionID]!.membershipID;
  } else {
    bindOwner(joinedRoom, regRoom);
  }
  return svc.getRoom(roomId);
}