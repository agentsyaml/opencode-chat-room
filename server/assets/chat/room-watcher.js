import { isOwnMessage } from "./messages.js";
import { setRoomPreview } from "./system-messages.js";

export async function watchRoom(roomId, app) {
  const entry = app.state.rooms.get(roomId);
  if (!entry || app.state.room?.id === roomId) return;
  try {
    const query = new URLSearchParams({ sessionID: app.LS.sessionID, roomId, excludeSelf: "0", timeout: "0" });
    query.set("afterTs", String(entry.receivedTs || 0));
    const result = await app.api(`/inbox?${query}`);
    if (app.state.rooms.get(roomId) !== entry) return;
    if (result.member === false) { await app.removeJoinedRoom(roomId, { reason: false }); return; }
    if (result.member !== true || !Array.isArray(result.items) || app.state.room?.id === roomId) return;
    const previousReceivedTs = entry.receivedTs || 0;
    const sawSystem = result.items.some((message) => message.senderId === "system");
    for (const message of result.items) {
      if (!isOwnMessage(message, app, entry.room, entry.name) && !entry.unreadIds.has(message.id)) entry.unreadIds.set(message.id, message);
      if (!entry.room.messages.some((item) => item.id === message.id)) entry.room.messages.push({ ...message, roomId });
      if (message.createdAt >= entry.previewAt) setRoomPreview(entry, message);
    }
    entry.receivedTs = result.items.reduce((latest, message) => Number.isSafeInteger(message.createdAt) ? Math.max(latest, message.createdAt) : latest, previousReceivedTs);
    if (sawSystem || result.hasMore) {
      const latest = await app.api(`/rooms/${encodeURIComponent(roomId)}`);
      if (app.state.rooms.get(roomId) !== entry || app.state.room?.id === roomId) return;
      entry.room.participants = latest.participants;
      entry.room.messages = [...new Map([...entry.room.messages, ...latest.messages].map((message) => [message.id, message])).values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500);
      const newest = latest.messages.at(-1);
      if (newest && newest.createdAt >= entry.previewAt) setRoomPreview(entry, newest);
    }
    entry.unreadOverflow = Boolean(result.hasMore);
    if (entry.room.messages.length > 500) entry.room.messages.splice(0, entry.room.messages.length - 500);
    if (result.hasMore && entry.receivedTs > previousReceivedTs) await watchRoom(roomId, app);
  } catch (error) {
    if (error.status === 401) app.openChatSettings();
    else if (error.status === 404) await app.removeJoinedRoom(roomId, { reason: false });
  }
}
