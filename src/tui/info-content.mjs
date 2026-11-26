// Pure formatting for the CLI parity commands. No terminal or network code, so
// the row text and the settings redaction can be checked directly in tests.
import { sanitizeText } from "./messages.mjs";
import { t } from "./i18n.mjs";

const oneLine = (value, max = 100) => {
  const text = sanitizeText(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function timeLabel(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return t("time.unknown");
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
    const type = member.type === "agent" ? t("member.typeAgent") : t("member.typeHuman");
    const activity = sanitizeText(member.activity?.state || t("member.activityUnknown"));
    return {
      name: t("member.row", {
        marker: self ? "●" : "○",
        name: self ? t("member.self", { name }) : name,
        type,
        activity,
      }),
      value: String(member.sessionID ?? name),
    };
  });
}

export function announcementRows(announcements) {
  return (Array.isArray(announcements) ? announcements : []).map((item) => ({
    name: t("announcement.row", { name: sanitizeText(item.name), time: timeLabel(item.updatedAt) }),
    value: String(item.name),
    content: String(item.content ?? ""),
    updatedAt: item.updatedAt,
  }));
}

export function questionRows(open, messages = []) {
  const rows = [];
  const seen = new Set();
  const rowOf = (marker, sender, text, answered) => t("question.row", {
    marker,
    sender: sanitizeText(sender || "?"),
    text: oneLine(text),
    answered: answered ? t("question.answered") : "",
  });
  for (const question of Array.isArray(open) ? open : []) {
    seen.add(question.id);
    const answered = Boolean(question.answeredByMessageID);
    rows.push({
      name: rowOf(answered ? "✓" : "?", question.senderId, question.text, answered),
      value: String(question.id),
      text: String(question.text ?? ""),
      open: !answered,
    });
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.isQuestion || !message.answeredByMessageID || seen.has(message.id)) continue;
    seen.add(message.id);
    rows.push({
      name: rowOf("✓", message.senderId, message.text, true),
      value: String(message.id),
      open: false,
    });
  }
  return rows;
}

export function fileRows(resources) {
  return (Array.isArray(resources) ? resources : []).map((item) => ({
    name: t("file.row", {
      name: sanitizeText(item.name),
      size: formatBytes(item.size),
      uploader: sanitizeText(item.uploaderName || item.uploaderSessionID || t("file.uploaderUnknown")),
      time: timeLabel(item.createdAt),
    }),
    value: String(item.id),
    resource: item,
  }));
}

export function joinRequestRows(requests) {
  return (Array.isArray(requests) ? requests : []).map((item) => ({
    name: t("join.row", {
      name: sanitizeText(item.name || item.participantId || "?"),
      type: item.isAgent ? t("common.agent") : t("common.human"),
      time: timeLabel(item.createdAt),
    }),
    value: String(item.sessionID),
    request: item,
  }));
}

export function reminderRows(reminders) {
  return (Array.isArray(reminders) ? reminders : []).map((item) => {
    const schedule = item.schedule?.type === "cron"
      ? t("reminder.cron", {
        expression: sanitizeText(item.schedule.expression),
        timezone: sanitizeText(item.schedule.timezone || t("common.server")),
      })
      : t("reminder.once", { time: timeLabel(Date.parse(item.schedule?.at ?? "")) });
    const next = typeof item.nextRunAt === "string" ? timeLabel(Date.parse(item.nextRunAt)) : timeLabel(item.nextRunAt);
    return {
      name: t("reminder.row", {
        marker: item.paused ? "⏸" : "●",
        text: oneLine(item.text),
        schedule,
        time: next,
      }),
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
    throw new Error(t("schedule.timezone", { value }));
  }
}

/** Parse "once <ISO datetime> [timezone]" or "cron <5 fields> [timezone]". */
export function parseReminderSchedule(input) {
  const parts = String(input ?? "").trim().split(/\s+/);
  const kind = parts.shift()?.toLowerCase();
  if (kind === "cron") {
    if (parts.length < 5) throw new Error(t("schedule.cronFields"));
    if (parts.length > 6) throw new Error(t("schedule.cronAccept"));
    const expression = parts.slice(0, 5).join(" ");
    const timezone = parts[5] ? timezoneOrThrow(parts[5]) : undefined;
    return { type: "cron", expression, ...(timezone ? { timezone } : {}) };
  }
  if (kind === "once") {
    if (!parts.length) throw new Error(t("schedule.onceNeeds"));
    if (parts.length > 2) throw new Error(t("schedule.onceAccept"));
    const at = parts[0];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) || !Number.isFinite(Date.parse(at))) {
      throw new Error(t("schedule.onceInvalid"));
    }
    const timezone = parts[1] ? timezoneOrThrow(parts[1]) : undefined;
    if (Date.parse(at) <= Date.now()) throw new Error(t("schedule.onceFuture"));
    return { type: "once", at, ...(timezone ? { timezone } : {}) };
  }
  throw new Error(t("schedule.start"));
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
    `- **${t("settings.labelServer")}**: ${safeValue(settings.server || t("common.notSet"), token)}`,
    `- **${t("settings.labelParticipant")}**: ${safeValue(settings.participant || "?", token)}`,
    `- **${t("settings.labelLanguage")}**: ${safeValue(settings.language || "en", token)}`,
    `- **${t("settings.labelSessionFile")}**: ${safeValue(settings.sessionFile || t("common.unknown"), token)}`,
    `- **${t("settings.labelConfigFile")}**: ${safeValue(settings.configFile || t("settings.environmentOnly"), token)}`,
    `- **${t("settings.labelTheme")}**: ${safeValue(settings.theme || "dark", token)}`,
    `- **${t("settings.labelDelivery")}**: ${t("settings.deliveryValue", { seconds: Math.round((settings.pollTimeoutMs ?? 20000) / 1000) })}`,
    `- **${t("settings.labelRequestTimeout")}**: ${t("settings.requestTimeoutValue", { seconds: Math.round((settings.requestTimeoutMs ?? 10000) / 1000) })}`,
    `- **${t("settings.labelToken")}**: ${token ? t("settings.tokenSet") : t("common.notSet")}`,
    `- **${t("room.labelEditing")}**: ${t("settings.editAvailable")}`,
  ];
  return lines.join("\n");
}

export function roomSettingsMarkdown(room = {}, { participant, sessionID, canEdit = false, agentName = "" } = {}) {
  const owner = Boolean(participant) && room.ownerId === participant;
  const admin = owner || (room.adminIds ?? []).includes(participant);
  const agentAdmin = Boolean(room.adminSessionID) && room.adminSessionID === sessionID;
  const role = owner ? t("room.roleOwner")
    : admin ? t("room.roleAdmin")
      : agentAdmin ? t("room.roleManagement")
        : t("room.roleMember");
  const policy = room.joinPolicy === "approval" ? t("room.policyApproval") : t("room.policyOpen");
  const description = room.description ? oneLine(room.description, 300) : t("common.notSet");
  const admins = (room.adminIds ?? []).filter(Boolean).join(", ") || t("common.none");
  const successor = room.successorId || t("common.none");
  const management = room.adminSessionID ? (agentName || room.adminSessionID) : t("common.none");
  const label = (key) => `- **${t(key)}**`;
  return [
    `${label("room.labelName")}: ${oneLine(room.name || "?", 80)}`,
    `${label("room.labelDescription")}: ${description}`,
    `${label("room.labelJoinPolicy")}: ${policy}`,
    `${label("room.labelKind")}: ${room.kind === "direct" ? t("room.kindDirect") : t("room.kindGroup")}`,
    `${label("room.labelOwner")}: ${oneLine(room.ownerId || "?", 80)}`,
    `${label("room.labelAdmins")}: ${admins}`,
    `${label("room.labelSuccessor")}: ${successor}`,
    `${label("room.labelManagement")}: ${management}`,
    `${label("room.labelRole")}: ${role}`,
    `${label("room.labelEditing")}: ${canEdit ? t("room.editingAvailable") : t("room.editingReadOnly")}`,
  ].join("\n");
}