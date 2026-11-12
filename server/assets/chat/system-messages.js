export function formatSystemMessage(message, app) {
  // `<at>@name</at>` is an editor token; system rows and previews show the plain mention.
  const text = String(message?.text ?? "").replace(/<at>([\s\S]*?)<\/at>/g, "$1");
  if (message?.senderId !== "system") return text;
  const joined = /^(.*?)\s+joined the room$/.exec(text);
  if (joined) return app.t("systemJoined", { name: joined[1] });
  const left = /^(.*?)\s+left the room$/.exec(text);
  if (left) return app.t("systemLeft", { name: left[1] });
  const removed = /^(.*?)\s+was removed from the room$/.exec(text);
  return removed ? app.t("systemRemoved", { name: removed[1] }) : text;
}

export function setRoomPreview(entry, message) {
  entry.preview = message.text;
  entry.previewAt = message.createdAt;
  entry.previewSenderId = message.senderId;
}

export function formatRoomPreview(entry, latest, app) {
  return formatSystemMessage(entry?.preview ? { senderId: entry.previewSenderId, text: entry.preview } : latest, app);
}
