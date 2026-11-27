// The fourth column drives the event icon and tint in the web client.
const patterns = [
  [/^(.*?) joined the room$/, "systemJoined", (m) => ({ name: m[1] }), "join"],
  [/^(.*?) left the room$/, "systemLeft", (m) => ({ name: m[1] }), "leave"],
  [/^(.*?) was removed from the room$/, "systemRemoved", (m) => ({ name: m[1] }), "remove"],
  [/^(.*?) designated (.*?) as administrator$/, "systemDesignated", (m) => ({ actor: m[1], name: m[2] }), "admin"],
  [/^(.*?) updated the room administrators$/, "systemAdminsUpdated", (m) => ({ actor: m[1] }), "admin"],
  [/^(.*?) named (.*?) as the room successor$/, "systemSuccessorNamed", (m) => ({ actor: m[1], name: m[2] }), "admin"],
  [/^(.*?) cleared the room successor$/, "systemSuccessorCleared", (m) => ({ actor: m[1] }), "admin"],
  [/^(.*?) revoked the administrator designation$/, "systemRevoked", (m) => ({ actor: m[1] }), "admin"],
  [/^(.*?) renamed the room from "(.*)" to "(.*)"$/, "systemRenamed", (m) => ({ actor: m[1], from: m[2], to: m[3] }), "admin"],
  [/^(.*?) updated the room description$/, "systemDescribed", (m) => ({ actor: m[1] }), "admin"],
  [/^(.*?) set join approval to (open|approval)$/, "systemJoinPolicy", (m) => ({ actor: m[1], policy: m[2] }), "admin"],
  [/^(.*?) handed the room to (.*)$/, "systemHanded", (m) => ({ actor: m[1], name: m[2] }), "admin"],
  [/^Forwarded to (.*)$/, "systemForwarded", (m) => ({ target: m[1] }), "forward"],
  [/^Forward to (.*?) failed: (.*)$/, "systemForwardFailed", (m) => ({ target: m[1], reason: m[2] }), "forward"],
];

function formatLine(line, app) {
  for (const [pattern, key, values] of patterns) {
    const match = pattern.exec(line);
    if (match) return app.t(key, values(match));
  }
  return line;
}

export function formatRelayMessage(message, app) {
  // Relay rows keep resource markers: the renderer turns them into attachment cards.
  return String(message?.text ?? "")
    .replace(/<at>@all<\/at>/g, `@${app.t("allMembers")}`)
    .replace(/<at>([\s\S]*?)<\/at>/g, "$1");
}

export function formatSystemMessage(message, app) {
  // `<at>@name</at>` is an editor token; system rows and previews show the plain mention.
  let text = String(message?.text ?? "")
    .replace(/<at>@all<\/at>/g, `@${app.t("allMembers")}`)
    .replace(/<at>([\s\S]*?)<\/at>/g, "$1");
  // Resource markers are internal IDs. A rail preview must not expose them.
  const resources = /\[\[resource:[0-9a-f-]{36}\]\]/gi;
  if (resources.test(text)) {
    text = text.replace(resources, "").trim();
    text = text ? `${text} · ${app.t("attachments")}` : app.t("attachments");
  }
  if (message?.senderId !== "system") return text;
  // One edit can log several changes joined by "; "; translate each line.
  return text.split("; ").map((line) => formatLine(line, app)).join("; ");
}

// Reminders are plain text system rows, so their id is the only stable marker.
export function systemMessageKind(message) {
  if (String(message?.id ?? "").startsWith("reminder:")) return "reminder";
  const line = String(message?.text ?? "").split("; ")[0];
  // Inbound relay lines carry provider ids and read like messages, not notices.
  if (/^\[[A-Za-z][\w .-]*\] message_id=\S+/.test(line)) return "relay";
  for (const [pattern, , , kind] of patterns) if (pattern.test(line)) return kind;
  return "notice";
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