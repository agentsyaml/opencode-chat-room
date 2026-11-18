import type { Participant, Room } from "../src/rooms/room-service.ts";
import { isUser } from "../src/state/roles.ts";

export { isOwnerEntry, isRoomAdmin, isUser } from "../src/state/roles.ts";

export type OwnerEntry = { name?: string | null; protocol?: string | null; host?: string | null; receiverOwnerID?: string | null; membershipID?: string | null };

function humans(room: Room, registry: Record<string, OwnerEntry>): OwnerEntry[] {
  const joined = new Map([...room.participants.values()].map((member) => [member.name, member]));
  return Object.values(registry)
    .filter(isUser)
    .filter((entry) => joined.has(entry.name!))
    .sort((left, right) => joined.get(left.name!)!.joinedAt - joined.get(right.name!)!.joinedAt) as OwnerEntry[];
}

// A room whose owner entry vanished follows the explicit successor first, then the
// first person still present; the last person out leaves the room open to claim.
export function settleOwner(room: Room, registry: Record<string, OwnerEntry>): string {
  const people = humans(room, registry);
  const bound = room.ownerMembershipID ? people.find((entry) => entry.membershipID === room.ownerMembershipID) : undefined;
  if (bound) { room.ownerId = bound.name!; return room.ownerId; }
  if (!room.ownerMembershipID) {
    const named = people.find((entry) => entry.name === room.ownerId);
    if (named) { room.ownerMembershipID = named.membershipID ?? undefined; return room.ownerId; }
  }
  const successor = room.successorId
    ? people.find((entry) => room.successorMembershipID ? entry.membershipID === room.successorMembershipID : entry.name === room.successorId)
    : undefined;
  const chosen = successor ?? people[0];
  room.ownerId = chosen?.name ?? "";
  if (chosen?.membershipID) room.ownerMembershipID = chosen.membershipID; else delete room.ownerMembershipID;
  delete room.successorId;
  delete room.successorMembershipID;
  const admins = (room.adminIds ?? []).filter((name) => name !== room.ownerId);
  if (admins.length) room.adminIds = admins;
  else if (room.adminIds) delete room.adminIds;
  if (chosen?.membershipID && room.adminMembershipIDs?.length) {
    const ids = room.adminMembershipIDs.filter((id) => id !== chosen.membershipID);
    if (ids.length) room.adminMembershipIDs = ids; else delete room.adminMembershipIDs;
  }
  return room.ownerId;
}

// Joining must not transfer ownership: bind a legacy room once, follow a renamed
// owner membership, and only settle when the bound owner is really gone.
export function bindOwner(room: Room, registry: Record<string, OwnerEntry>): void {
  if (!room.ownerId) return;
  const people = humans(room, registry);
  if (room.ownerMembershipID) {
    const bound = people.find((entry) => entry.membershipID === room.ownerMembershipID);
    if (bound) { room.ownerId = bound.name!; return; }
    settleOwner(room, registry);
    return;
  }
  const named = people.find((entry) => entry.name === room.ownerId);
  if (named?.membershipID) room.ownerMembershipID = named.membershipID;
}

// Delegated admins follow the people still in the room; the owner is implicit.
export function settleAdmins(room: Room, registry: Record<string, OwnerEntry>): void {
  if (!room.adminIds?.length) return;
  const people = Object.values(registry).filter(isUser);
  const names = new Set(people.map((entry) => entry.name));
  const next = room.adminIds.filter((name) => names.has(name));
  if (next.length) room.adminIds = next;
  else delete room.adminIds;
  if (room.adminMembershipIDs?.length) {
    const ids = new Set(people.map((entry) => entry.membershipID).filter(Boolean));
    const kept = room.adminMembershipIDs.filter((id) => ids.has(id));
    if (kept.length) room.adminMembershipIDs = kept; else delete room.adminMembershipIDs;
  }
}