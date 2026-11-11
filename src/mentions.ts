import type { QueueItem } from "./queue";

export function explicitlyMentions(item: QueueItem, recipient: string, sessionID?: string): boolean {
  if (!recipient.trim() || (item.senderId === "system" && !item.id?.startsWith("reminder:")) || (sessionID !== undefined && item.senderSessionID === sessionID)) return false;
  const broadcast = /(?<![\p{L}\p{N}_.@])(?:<at>)?@(?:all|所有人)(?:<\/at>)?(?![\p{L}\p{N}_])/u.exec(item.text);
  if (broadcast && broadcast.index + broadcast[0].length <= 300) return true;
  const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\p{L}\\p{N}_.@])(?:<at>)?@${escaped}(?:</at>)?(?![\\p{L}\\p{N}_])`, "u").exec(item.text);
  return match !== null && match.index + match[0].length <= 300;
}

export function explicitlyAddresses(item: QueueItem, recipient: string, sessionID?: string, roomKind?: "group" | "direct"): boolean {
  if (roomKind !== "direct") return explicitlyMentions(item, recipient, sessionID);
  if (item.senderId === "system") return item.id?.startsWith("reminder:") ? explicitlyMentions(item, recipient, sessionID) : false;
  return item.senderId !== "system" && item.senderId !== sessionID && item.senderSessionID !== sessionID;
}
