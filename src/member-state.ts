import type { RegistryEntry, WorkState } from "./store";

export type { WorkState } from "./store";
export type ActivityState = WorkState | "offline";
export const PRESENCE_TTL_MS = 60_000;

export function presenceOwnerMatches(entry: RegistryEntry, ownerID?: string): boolean {
  return entry.protocol === "v2"
    ? Boolean(entry.receiverOwnerID && entry.receiverOwnerID === ownerID)
    : (entry.protocol === "v1" || entry.protocol === undefined && Boolean(entry.serverUrl || entry.host)) &&
      !entry.receiverOwnerID && ownerID === undefined;
}

export function receiptOwnerMatches(entry: RegistryEntry, ownerID?: string): boolean {
  return entry.receiverOwnerID === undefined
    ? ownerID === undefined
    : entry.protocol === "v2" && entry.receiverOwnerID === ownerID;
}

export function memberActivity(entry: RegistryEntry, now = Date.now()): { state: ActivityState; observedAt: number | null } {
  const observedAt = entry.lastSeenAt;
  if (observedAt === undefined) return { state: "unknown", observedAt: null };
  if (now - observedAt >= PRESENCE_TTL_MS) return { state: "offline", observedAt };
  return { state: entry.workState ?? "unknown", observedAt };
}
