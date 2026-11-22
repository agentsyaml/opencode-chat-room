// Pure formatting for the CLI parity commands. No terminal or network code, so
// the row text and the settings redaction can be checked directly in tests.
import { sanitizeText } from "./messages.mjs";

const oneLine = (value, max = 100) => {
  const text = sanitizeText(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function timeLabel(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return "unknown time";
  const date = new Date(ms);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function memberRows(members, selfID) {
  return (Array.isArray(members) ? members : []).map((member) => {
    const self = Boolean(selfID) && member.sessionID === selfID;
    const name = sanitizeText(member.name || member.sessionID || "?");
    const type = member.type === "agent" ? "agent" : "human";
    const activity = sanitizeText(member.activity?.state || "unknown");
    return {
      name: `${self ? "●" : "○"} ${name}${self ? " (you)" : ""} · member · ${type} · ${activity}`,
      value: String(member.sessionID ?? name),
    };
  });
}

export function announcementRows(announcements) {
  return (Array.isArray(announcements) ? announcements : []).map((item) => ({
    name: `${sanitizeText(item.name)} · updated ${timeLabel(item.updatedAt)}`,
    value: String(item.name),
    content: String(item.content ?? ""),
    updatedAt: item.updatedAt,
  }));
}

export function questionRows(open, messages = []) {
  const rows = [];
  const seen = new Set();
  for (const question of Array.isArray(open) ? open : []) {
    seen.add(question.id);
    const answered = Boolean(question.answeredByMessageID);
    rows.push({
      name: `${answered ? "✓" : "?"} ${sanitizeText(question.senderId || "?")}: ${oneLine(question.text)}${answered ? " (answered)" : ""}`,
      value: String(question.id),
      text: String(question.text ?? ""),
      open: !answered,
    });
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.isQuestion || !message.answeredByMessageID || seen.has(message.id)) continue;
    seen.add(message.id);
    rows.push({
      name: `✓ ${sanitizeText(message.senderId || "?")}: ${oneLine(message.text)} (answered)`,
      value: String(message.id),
      open: false,
    });
  }
  return rows;
}

export function fileRows(resources) {
  return (Array.isArray(resources) ? resources : []).map((item) => ({
    name: `${sanitizeText(item.name)} · ${formatBytes(item.size)} · ${sanitizeText(item.uploaderName || item.uploaderSessionID || "unknown")} · ${timeLabel(item.createdAt)}`,
    value: String(item.id),
    resource: item,
  }));
}

export function joinRequestRows(requests) {
  return (Array.isArray(requests) ? requests : []).map((item) => ({
    name: `${sanitizeText(item.name || item.participantId || "?")} · ${item.isAgent ? "Agent" : "Human"} · ${timeLabel(item.createdAt)}`,
    value: String(item.sessionID),
    request: item,
  }));
}

export function reminderRows(reminders) {
  return (Array.isArray(reminders) ? reminders : []).map((item) => {
    const schedule = item.schedule?.type === "cron"
      ? `cron ${sanitizeText(item.schedule.expression)} (${sanitizeText(item.schedule.timezone || "server")})`
      : `once ${timeLabel(Date.parse(item.schedule?.at ?? ""))}`;
    const next = typeof item.nextRunAt === "string" ? timeLabel(Date.parse(item.nextRunAt)) : timeLabel(item.nextRunAt);
    return {
      name: `${item.paused ? "⏸" : "●"} ${oneLine(item.text)} · ${schedule} · next ${next}`,
      value: String(item.id),
      paused: Boolean(item.paused),
      text: String(item.text ?? ""),
      schedule: item.schedule,
      nextRunAt: item.nextRunAt,
    };
  });
}

function timezoneOrThrow(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    throw new Error(`invalid timezone: ${value}`);
  }
}

/** Parse "once <ISO datetime> [timezone]" or "cron <5 fields> [timezone]". */
export function parseReminderSchedule(input) {
  const parts = String(input ?? "").trim().split(/\s+/);
  const kind = parts.shift()?.toLowerCase();
  if (kind === "cron") {
    if (parts.length < 5) throw new Error("cron needs 5 fields, for example: cron 0 9 * * *");
    if (parts.length > 6) throw new Error("cron accepts 5 fields plus an optional timezone");
    const expression = parts.slice(0, 5).join(" ");
    const timezone = parts[5] ? timezoneOrThrow(parts[5]) : undefined;
    return { type: "cron", expression, ...(timezone ? { timezone } : {}) };
  }
  if (kind === "once") {
    if (!parts.length) throw new Error("once needs an ISO datetime, for example: once 2026-11-23T09:00");
    if (parts.length > 2) throw new Error("once accepts an ISO datetime plus an optional timezone");
    const at = parts[0];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) || !Number.isFinite(Date.parse(at))) {
      throw new Error("once needs an ISO datetime, for example: 2026-11-23T09:00");
    }
    const timezone = parts[1] ? timezoneOrThrow(parts[1]) : undefined;
    if (Date.parse(at) <= Date.now()) throw new Error("once datetime must be in the future");
    return { type: "once", at, ...(timezone ? { timezone } : {}) };
  }
  throw new Error('schedule must start with "once" or "cron"');
}

function safeValue(value, token) {
  let text = String(value ?? "");
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      text = parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // Not a URL: keep the string.
  }
  return token ? text.split(token).join("***") : text;
}

export function settingsMarkdown(settings = {}) {
  const token = settings.token ? String(settings.token) : "";
  const lines = [
    `- **Server**: ${safeValue(settings.server || "not set", token)}`,
    `- **Participant**: ${safeValue(settings.participant || "?", token)}`,
    `- **Session file**: ${safeValue(settings.sessionFile || "unknown", token)}`,
    `- **Config file**: ${safeValue(settings.configFile || "none (environment only)", token)}`,
    `- **Theme**: ${safeValue(settings.theme || "dark", token)}`,
    `- **Delivery**: server long-poll, ${Math.round((settings.pollTimeoutMs ?? 20000) / 1000)}s hold`,
    `- **Request timeout**: ${Math.round((settings.requestTimeoutMs ?? 10000) / 1000)}s`,
    `- **Token**: ${token ? "set (redacted)" : "not set"}`,
  ];
  return lines.join("\n");
}

export function roomSettingsMarkdown(room = {}, { participant, sessionID, canEdit = false, agentName = "" } = {}) {
  const owner = Boolean(participant) && room.ownerId === participant;
  const admin = owner || (room.adminIds ?? []).includes(participant);
  const agentAdmin = Boolean(room.adminSessionID) && room.adminSessionID === sessionID;
  const role = owner ? "owner" : admin ? "admin" : agentAdmin ? "management agent" : "member";
  const policy = room.joinPolicy === "approval" ? "approval" : "open";
  const description = room.description ? oneLine(room.description, 300) : "not set";
  const admins = (room.adminIds ?? []).filter(Boolean).join(", ") || "none";
  const successor = room.successorId || "none";
  const management = room.adminSessionID ? (agentName || room.adminSessionID) : "none";
  return [
    `- **Name**: ${oneLine(room.name || "?", 80)}`,
    `- **Description**: ${description}`,
    `- **Join policy**: ${policy}`,
    `- **Kind**: ${room.kind === "direct" ? "direct" : "group"}`,
    `- **Owner**: ${oneLine(room.ownerId || "?", 80)}`,
    `- **Admins**: ${admins}`,
    `- **Successor**: ${successor}`,
    `- **Management agent**: ${management}`,
    `- **Your role**: ${role}`,
    `- **Editing**: ${canEdit ? "available" : "read-only"}`,
  ].join("\n");
}