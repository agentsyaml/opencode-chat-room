const patterns = [
  [/^(.*?) joined the room$/, "systemJoined", (m) => ({ name: m[1] })],
  [/^(.*?) left the room$/, "systemLeft", (m) => ({ name: m[1] })],
  [/^(.*?) was removed from the room$/, "systemRemoved", (m) => ({ name: m[1] })],
  [/^(.*?) designated (.*?) as administrator$/, "systemDesignated", (m) => ({ actor: m[1], name: m[2] })],
  [/^(.*?) updated the room administrators$/, "systemAdminsUpdated", (m) => ({ actor: m[1] })],
  [/^(.*?) named (.*?) as the room successor$/, "systemSuccessorNamed", (m) => ({ actor: m[1], name: m[2] })],
  [/^(.*?) cleared the room successor$/, "systemSuccessorCleared", (m) => ({ actor: m[1] })],
  [/^(.*?) revoked the administrator designation$/, "systemRevoked", (m) => ({ actor: m[1] })],
  [/^(.*?) renamed the room from "(.*)" to "(.*)"$/, "systemRenamed", (m) => ({ actor: m[1], from: m[2], to: m[3] })],
  [/^(.*?) updated the room description$/, "systemDescribed", (m) => ({ actor: m[1] })],
  [/^(.*?) handed the room to (.*)$/, "systemHanded", (m) => ({ actor: m[1], name: m[2] })],
];

function formatLine(line, app) {
  for (const [pattern, key, values] of patterns) {
    const match = pattern.exec(line);
    if (match) return app.t(key, values(match));
  }
  return line;
}

export function formatSystemMessage(message, app) {
  // `<at>@name</at>` is an editor token; system rows and previews show the plain mention.
  const text = String(message?.text ?? "").replace(/<at>([\s\S]*?)<\/at>/g, "$1");
  if (message?.senderId !== "system") return text;
  // One edit can log several changes joined by "; "; translate each line.
  return text.split("; ").map((line) => formatLine(line, app)).join("; ");
}

export function setRoomPreview(entry, message) {
  entry.preview = message.text;
  entry.previewAt = message.createdAt;
  entry.previewSenderId = message.senderId;
  entry.previewRecalled = Boolean(message.recalledAt);
}

export function formatRoomPreview(entry, latest, app) {
  // A recalled message must not leak its text through the room rail.
  if (entry?.previewRecalled || latest?.recalledAt) return app.t("messageRecalled");
  return formatSystemMessage(entry?.preview ? { senderId: entry.previewSenderId, text: entry.preview } : latest, app);
}