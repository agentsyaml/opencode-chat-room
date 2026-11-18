export type RoleRoom = {
  ownerId: string;
  ownerMembershipID?: string;
  adminIds?: string[];
  adminMembershipIDs?: string[];
};

export type RoleEntry = {
  name?: string | null;
  protocol?: string | null;
  host?: string | null;
  receiverOwnerID?: string | null;
  membershipID?: string | null;
};

// Agents carry a protocol (v1/v2), a host, or a receiver binding; only a person may
// own a room, so any of those fields marks an entry that must never be promoted.
export function isUser(entry: RoleEntry | undefined | null): boolean {
  return Boolean(entry?.name) && !entry!.protocol && !entry!.host && !entry!.receiverOwnerID;
}

// The owner is a person bound to a server-issued membership. The display name is
// only for presentation: a new session that reuses the name must not inherit the room.
export function isOwnerEntry(room: RoleRoom, entry: RoleEntry | null | undefined): boolean {
  return isUser(entry) && entry!.name === room.ownerId &&
    (!room.ownerMembershipID || entry!.membershipID === room.ownerMembershipID);
}

export function isRoomAdmin(room: RoleRoom, entry: RoleEntry | null | undefined): boolean {
  if (isOwnerEntry(room, entry)) return true;
  if (!isUser(entry) || !(room.adminIds ?? []).includes(entry!.name!)) return false;
  if (!room.adminMembershipIDs?.length) return true;
  return !entry!.membershipID || room.adminMembershipIDs.includes(entry!.membershipID);
}