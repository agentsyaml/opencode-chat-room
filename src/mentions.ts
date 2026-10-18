import type { QueueItem } from "./queue";

export function explicitlyMentions(item: QueueItem, recipient: string, sessionID?: string): boolean {
  if (!recipient.trim() || item.senderId === "system" || (sessionID !== undefined && item.senderSessionID === sessionID)) return false;
  const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\p{L}\\p{N}_.@])(?:<at>)?@${escaped}(?:</at>)?(?![\\p{L}\\p{N}_])`, "u").exec(item.text);
  return match !== null && match.index + match[0].length <= 300;
}
