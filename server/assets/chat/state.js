export const app = {
  $: (selector) => document.querySelector(selector),
  state: {
    room: null, myName: "", unread: 0, drafts: new Map(), rooms: new Map(),
    pollGeneration: 0, navigationGeneration: 0, draftRevision: new Map(), memberSessions: new Map(),
    retryingFailedIds: new Set(), pollController: null, memberRefreshTimer: 0, receiptRefreshTimer: 0, receiptObservationFrame: 0,
    receiptObservation: null,
    memberApiUnavailable: new Set(), receiptApiUnavailable: new Set(),
    receipts: new Map(), acknowledgedMessages: new Map(), pendingAcknowledgements: new Map(),
    pendingAction: null, watcherTimer: 0, restored: false, resizeScrollAdjusting: false, layoutScrollAdjusting: false,
    readAnchorGuard: null, userScrollIntentUntil: 0,
  },
  rendered: 0,
  firstMessageId: null,
  pollDelay: 2000,
  copyTimer: 0,
  failedRenderIds: new Set(),
};

export function createRandomId() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues) throw new Error("Secure session ID generation is unavailable");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAuth(storage, fetcher, translate = (key) => key, sessionStore) {
  const memory = Object.create(null);
  let browserIdentity, identityPersistent = false, identityConflict = false;
  const identityKey = "chat.browserIdentity";
  const validSessionID = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const parseIdentity = (value) => {
    try {
      const identity = JSON.parse(value);
      return validSessionID(identity?.sessionID) && typeof identity.name === "string" && identity.name.length <= 64
        ? { sessionID: identity.sessionID, name: identity.name } : undefined;
    } catch { return undefined; }
  };
  const read = (key) => {
    if (Object.hasOwn(memory, key)) return memory[key];
    try { return (storage ?? globalThis.localStorage).getItem(key); } catch { return null; }
  };
  const write = (key, value) => {
    const stored = value == null ? null : String(value);
    try {
      const store = storage ?? globalThis.localStorage;
      if (stored == null) store.removeItem(key);
      else store.setItem(key, stored);
      delete memory[key];
    } catch { memory[key] = stored; }
  };
  const readSession = (key) => {
    try { return (sessionStore ?? globalThis.sessionStorage).getItem(key); } catch { return null; }
  };
  const writeSession = (key, value) => {
    try {
      const store = sessionStore ?? globalThis.sessionStorage;
      if (value == null) store.removeItem(key);
      else store.setItem(key, value);
    } catch { /* Tab-scoped state is best effort. */ }
  };
  const syncTabIdentity = () => {
    writeSession("chat.sessionID", browserIdentity.sessionID);
    writeSession("chat.name", browserIdentity.name || null);
  };
  const ensureIdentity = () => {
    if (browserIdentity) return browserIdentity;
    let store;
    try {
      store = storage ?? globalThis.localStorage;
      const canonical = parseIdentity(store.getItem(identityKey));
      if (canonical) { browserIdentity = canonical; identityPersistent = true; syncTabIdentity(); return canonical; }
    } catch { /* Keep this tab's identity in memory when storage is blocked. */ }
    const previousID = readSession("chat.sessionID");
    browserIdentity = { sessionID: validSessionID(previousID) ? previousID : createRandomId(), name: validSessionID(previousID) ? (readSession("chat.name") || "").slice(0, 64) : "" };
    syncTabIdentity();
    try {
      store ||= storage ?? globalThis.localStorage;
      store.setItem(identityKey, JSON.stringify(browserIdentity));
      const saved = parseIdentity(store.getItem(identityKey));
      if (saved?.sessionID === browserIdentity.sessionID) { browserIdentity = saved; identityPersistent = true; }
      else if (saved) identityConflict = true;
    } catch { /* This page keeps its in-memory identity without claiming persistence. */ }
    return browserIdentity;
  };
  const identityError = () => {
    const error = new Error(translate("identityChanged"));
    error.identityConflict = true;
    return error;
  };
  const assertIdentity = () => {
    ensureIdentity();
    if (identityConflict) throw identityError();
    try {
      const current = parseIdentity((storage ?? globalThis.localStorage).getItem(identityKey));
      if (current && current.sessionID !== browserIdentity.sessionID || identityPersistent && !current) {
        identityConflict = true;
        throw identityError();
      }
      if (current) identityPersistent = true;
    } catch (error) {
      if (error?.identityConflict) throw error;
      identityPersistent = false;
    }
  };
  const saveIdentity = () => {
    if (!identityPersistent) return;
    try {
      const store = storage ?? globalThis.localStorage;
      const current = parseIdentity(store.getItem(identityKey));
      if (current?.sessionID !== browserIdentity.sessionID) { identityConflict = true; return; }
      store.setItem(identityKey, JSON.stringify(browserIdentity));
      if (parseIdentity(store.getItem(identityKey))?.sessionID !== browserIdentity.sessionID) identityConflict = true;
    } catch { /* Keep the preferred name in memory when persistence is blocked. */ }
  };
  const auth = {
    get sessionID() {
      return ensureIdentity().sessionID;
    },
    get roomId() {
      const active = readSession("chat.roomId");
      if (active) return active;
      const legacy = read("chat.roomId");
      if (legacy) writeSession("chat.roomId", legacy);
      return legacy || "";
    },
    set roomId(value) { writeSession("chat.roomId", value || null); write("chat.roomId", null); },
    get name() { return ensureIdentity().name; },
    set name(value) { ensureIdentity(); browserIdentity.name = String(value ?? "").slice(0, 64); writeSession("chat.name", browserIdentity.name || null); saveIdentity(); },
    get token() { return read("chat.token") || ""; }, set token(value) { write("chat.token", value || null); },
    get adminToken() { return readSession("chat.adminToken") || ""; }, set adminToken(value) { writeSession("chat.adminToken", value || null); },
    get locale() { return read("chat.locale") || "en"; }, set locale(value) { write("chat.locale", value || null); },
    get joinedRoomIds() {
      try {
        const ids = JSON.parse(readSession("chat.joinedRoomIds") || "[]");
        return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string"))] : [];
      } catch { return []; }
    },
    set joinedRoomIds(ids) { writeSession("chat.joinedRoomIds", JSON.stringify([...new Set(ids)])); },
    get roomNames() { try { return JSON.parse(readSession("chat.roomNames") || "{}"); } catch { return {}; } },
    set roomNames(value) { writeSession("chat.roomNames", JSON.stringify(value)); },
    get drafts() { try { return JSON.parse(readSession("chat.drafts") || "{}"); } catch { return {}; } },
    set drafts(value) { writeSession("chat.drafts", JSON.stringify(value)); },
    get replyDrafts() { try { return JSON.parse(readSession("chat.replyDrafts") || "{}"); } catch { return {}; } },
    set replyDrafts(value) { writeSession("chat.replyDrafts", JSON.stringify(value)); },
    get positions() { try { return JSON.parse(readSession("chat.positions") || "{}"); } catch { return {}; } },
    set positions(value) { writeSession("chat.positions", JSON.stringify(value)); },
    get readTs() { try { return JSON.parse(readSession("chat.readTs") || "{}"); } catch { return {}; } },
    set readTs(value) { writeSession("chat.readTs", JSON.stringify(value)); },
    get failedMessages() {
      try {
        const value = JSON.parse(readSession("chat.failedMessages") || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    },
    set failedMessages(value) { writeSession("chat.failedMessages", JSON.stringify(value)); },
  };
  const saveToken = (value) => { auth.token = String(value ?? "").trim(); return auth.token; };
  const apiResponse = async (url, options = {}) => {
    assertIdentity();
    const headers = { ...options.headers };
    if (typeof options.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    let response;
    try { response = await (fetcher ?? globalThis.fetch)(url, { ...options, headers }); }
    catch {
      const error = new Error(translate("networkError"));
      error.network = true;
      throw error;
    }
    assertIdentity();
    if (!response.ok) {
      const data = await response.clone().json().catch(() => ({}));
      assertIdentity();
      const error = new Error(data.error || translate("requestFailed", { status: response.status }));
      error.status = response.status;
      throw error;
    }
    return response;
  };
  const api = async (url, options) => {
    const response = await apiResponse(url, options), data = await response.json().catch(() => ({}));
    assertIdentity(); return data;
  };
  const apiBlob = async (url, options) => {
    const response = await apiResponse(url, options), blob = await response.blob();
    assertIdentity(); return blob;
  };
  const adminApi = async (url, options = {}) => {
    if (!url.startsWith("/admin/") || !auth.adminToken) throw new Error("Administration token is required");
    const response = await apiResponse(url, { ...options, headers: { ...options.headers, "X-Chat-Admin-Token": auth.adminToken } });
    const data = await response.json().catch(() => ({}));
    assertIdentity(); return data;
  };
  return { LS: auth, saveToken, api, apiBlob, adminApi };
}

const messages = {
  en: {
    brand: "OC Chat", documentTitle: "OC Chat",
    roomTitle: ({ name }) => `${name} · OC Chat`,
    tagline: "A lightweight chat room. Enter a room ID to join, or create a new one.",
    restoringSession: "Restoring your session…", retry: "Retry", roomOptions: "Options",
    languageLabel: "Language", roomIdLabel: "Room ID", roomIdPlaceholder: "Paste or enter a room ID",
    nameLabel: "Your name", namePlaceholder: "What should we call you?", joinRoom: "Join room",
    or: "or", newRoomNameLabel: "New room name", newRoomNamePlaceholder: "e.g. Weekend movie night",
    createRoom: "Create room", tokenOptional: "Access token (optional)", bearerToken: "Bearer token",
    tokenPlaceholder: "Enter if the server requires it", save: "Save",
    tokenHint: "If the server requires an access token (401), all requests will include it.",
    existingRooms: "Rooms", noRooms: "No rooms yet. Create one.", copyRoomId: "Copy room ID",
    newRoom: "Create a room",
    copyRoomIdTitle: ({ id }) => `Click to copy the full room ID: ${id}`, copied: "Copied",
    members: "Members", membersCount: ({ count }) => `Members (${count})`, noMembers: "No members yet.", profileMenu: "Your profile and settings",
    questions: "Questions", pendingQuestions: "Pending questions", refreshQuestions: "Refresh",
    announcements: "Announcements", announcementName: "Name", announcementContent: "Content",
    reminders: "Reminders", reminderSchedule: "Schedule", reminderOnce: "One time", reminderDate: "Date and time",
    reminderCron: "5-field CRON expression", reminderTimezone: "Timezone override (optional)", reminderTimezoneHint: "Leave blank to use the server timezone. An IANA timezone applies to both schedule types. The server rejects one-time times skipped or repeated by daylight-saving changes.",
    reminderText: "Reminder text", reminderTemplateHint: "Use {{time}}, {{initiator}}, and {{room}} in your message.", reminderCreate: "Create reminder",
    reminderLoading: "Loading reminders…", reminderEmpty: "No reminders yet.", reminderPaused: "Paused", reminderNext: ({ time }) => `Next: ${time}`,
    reminderPause: "Pause", reminderResume: "Resume", reminderDelete: "Delete", reminderDeleteConfirm: "Delete this reminder?",
    reminderCreated: "Reminder created.", reminderUpdated: "Reminder updated.", reminderDeleted: "Reminder deleted.",
    reminderInvalid: "Check the date, 5-field CRON expression, IANA timezone, and reminder text.", reminderLoadFailed: "Could not load reminders. Your draft is still here.",
    diagramLoading: "Rendering diagram…", diagramRenderFailed: "Diagram unavailable; showing its source.", resourceLoading: "Loading file…", resourceFailed: "This file could not be loaded.", resourceDownload: "Download", resourcePreview: "Preview", resourceHide: "Hide preview",
    announcementDelete: "Delete announcement",
    announcementNew: "New announcement", announcementEmpty: "No announcements yet.", announcementLoading: "Loading announcements…",
    announcementLoadFailed: "Could not load announcements. Your draft is still here.", announcementSaved: "Announcement saved.", announcementDeleted: "Announcement deleted.",
    announcementDuplicate: "That name already exists. Select it to edit, or choose another name.", announcementDeleteConfirm: ({ name }) => `Delete “${name}”?`, announcementCount: ({ count }) => `${count} / 5000`, announcementInvalid: "Use a name of 1–64 characters and content up to 5000 characters.",
    questionsLoading: "Loading questions…", questionsEmpty: "No unanswered questions.",
    questionsFailed: "Could not load questions. Try again.", questionsUnsupported: "Unanswered questions are unavailable on this server.", questionLabel: "Question",
    answerQuestion: "Reply", answerPlaceholder: "Write a reply…", sendAnswer: "Send reply", selectQuestion: "Reply to question", copyQuestion: "Copy question", questionCopied: "Question copied.", questionCopyFailed: "Could not copy question.",
    answerFailed: "Reply failed. Your draft is still here.", answerTooLong: "Reply must be 2,000 characters or fewer.", questionAlreadyAnswered: "This question was answered elsewhere.",
    sendAsQuestion: "Send as a question",
    adminBindingGuide: "Choose a room and an Agent in it. Send the invitation privately to finish setup.", adminRoomLabel: "Administrator room", adminDesignateAgent: "Invite Agent",
    settings: "Settings", adminAccess: "Administration", adminToken: "Administration token", openAdministration: "Open administration", administration: "Administration", designations: "Designations", adminRoom: "Administrator room", targetRoom: "Agent membership room", adminScopeNote: "Choose an Agent in the administrator room. Administrators can manage all rooms.", targetAgent: "Registered agent", designate: "Designate administrator", revokeDesignation: "Revoke designation", globalStatus: "Global status", adminTasks: "Tasks", taskText: "Task", dispatchTask: "Dispatch task", timers: "Timers", planName: "Timer name", createTimer: "Create timer", tokenRequired: "The server requires an access token (401).",
    adminLoading: "Loading administration…", refreshAdmin: "Refresh", adminRoomBadge: "admin", chooseAdminRoom: "Choose a normal room", chooseTargetRoom: "Choose an agent room", chooseAgent: "Choose a registered agent", taskTargetRoom: "Target room", taskTargetAgent: "Target agent", createAdminRoomFirst: "Create a normal room first, then select it as the admin room.", noAgents: "No registered agents", selectAdminAgent: "Choose an admin room and registered agent.", adminDesignated: "Administrator designation is active immediately and stays until you revoke it.", revokeConfirm: "Revoke this admin designation? The normal room will remain.", updateTask: "Update task", task_pending: "Pending", task_working: "Working", task_blocked: "Blocked", task_completed: "Completed", task_cancelled: "Cancelled", nextRun: ({ time, minutes }) => `Every ${minutes} min · next ${time}`, paused: "Paused", pauseTimer: "Pause", resumeTimer: "Resume", deleteTimer: "Delete", deleteTimerConfirm: ({ name }) => `Delete timer “${name}”?`,
    leave: "Leave", reconnecting: "Connection lost. Retrying…", messageList: "Message list",
    noMessages: "No messages yet. Say something.", latestMessages: "Back to latest messages",
    mentionMembers: "Choose a member to mention", messagePlaceholder: "Message · Enter to send",
    attachments: "Attachments", addFiles: "Add files", dropFilesHere: "Drop files here to attach",
    attachmentVolatile: "File attachments are held in this tab and are cleared if you reload.", retryUpload: "Retry", removeFile: "Remove",
    uploadQueued: "Waiting to upload", uploadReady: "Ready to send", uploadPercent: ({ percent }) => `Uploading ${percent}%`,
    uploadFailed: "Upload failed. Retry or remove the file.",
    fileTooLarge: "File exceeds the server's current size limit.",
    send: "Send", roomMeta: ({ members, count }) => `${members} ${members === 1 ? "member" : "members"} · ${count} ${count === 1 ? "message" : "messages"}`,
    joinArrow: "Join →", joinDirectTitle: "Click to join directly", mentionEmpty: "No matching members",
    joined: "Joined", joinAction: "Join room", unreadMessages: ({ count }) => `${count} unread`,
    mentionHint: "↑↓ Select · Enter to confirm · Esc to close", today: "Today", yesterday: "Yesterday",
    earlierMessages: "Earlier messages omitted", messagesBetweenOmitted: "Messages between this reading point and latest are omitted.", you: "You", saved: "Saved",
    savedMemory: "Saved for this tab only", copyFailed: ({ id }) => `Copy failed. Copy manually: ${id}`,
    copyMessage: "Copy", copiedMessage: "Copied", copyMessageFailed: "Could not copy. Select and copy the message manually.",
    replyMessage: "Reply", replyingTo: "Replying to", cancelReply: "Cancel reply", replyOpenOriginal: "View original message", replyOriginalUnavailable: "Original message is unavailable.",
    identityChanged: "This browser identity changed in another tab. Reload this tab before continuing.",
    networkError: "Network connection failed", requestFailed: ({ status }) => `Request failed (HTTP ${status})`,
    roomIdRequired: "Enter a room ID", nameRequired: "Enter your name", authRetry: "The server requires an access token. Enter it and try again.",
    networkRetry: "Unable to connect to the server. Check your network and try again.",
    joinFailed: ({ message }) => `Could not join: ${message}`, roomNameRequired: "Enter a room name",
    createFailed: ({ message }) => `Could not create the room: ${message}`,
    roomNotFound: "This room is gone, or you no longer have access.",
    sendAuth: "Send failed: an access token is required", sendNetwork: "Send failed. Your message is saved below.",
    sendFailed: ({ message }) => `Send failed: ${message}`,
    adminRoomDeleteDenied: "This room is designated for administration. Enter the Administration token in Settings to delete it.",
    failedMessages: "Messages not sent", retryFailed: "Retry", discardFailed: "Discard",
    roomListError: "Unable to load rooms. You can enter a room ID directly.", guest: "Guest",
    roomsLabel: "Rooms", refreshRooms: "Refresh rooms", identityLabel: ({ name }) => `Chatting as ${name}`,
    roomsMenu: "Open room list", closeRoomList: "Close room list",
    direct: "Direct", messagePrivately: "Message privately", removeMember: "Remove",
    kickConfirm: ({ name, id }) => `Remove ${name} (session ${id}) from this room?`,
    deleteRoom: "Delete room", deleteConfirm: ({ name }) => `Delete “${name}” and all its messages? This cannot be undone.`,
    allMembers: "Everyone", messageCount: ({ count }) => `${count} / 2000`,
    privacyNote: "Anyone with the shared token can read direct messages and manage rooms; the server can read them too.",
    systemJoined: ({ name }) => `${name} joined the room`, systemLeft: ({ name }) => `${name} left the room`, systemRemoved: ({ name }) => `${name} was removed from the room`,
    activity_working: "Working", activity_idle: "Foreground idle", activity_waiting: "Waiting", activity_unknown: "Status unknown", activity_offline: "Status stale",
    activityHint_working: "The agent reports active work.", activityHint_idle: "Foreground is idle; background work may continue.", activityHint_waiting: "The agent reports that it is waiting.", activityHint_unknown: "No activity report is available.", activityHint_offline: "The last status is stale; this does not prove the agent is offline.",
    receiptCount: ({ count }) => `Read by ${count}`, receiptNone: "No readers yet", receiptNotLoaded: "Read status not loaded", readerPanelTitle: "Message readers", close: "Close", departedMember: "left",
    receiptEvidence_displayed: "Shown on screen", receiptEvidence_tool: "Fetched with room tool", receiptEvidence_context: "In agent context",
  },
  "zh-CN": {
    brand: "OC Chat", documentTitle: "OC Chat", roomTitle: ({ name }) => `${name} · OC Chat`,
    tagline: "一个轻量的聊天房间。输入房间 ID 加入，或直接新建一个。", languageLabel: "语言",
    restoringSession: "正在恢复会话…", retry: "重试", roomOptions: "选项",
    roomIdLabel: "房间 ID", roomIdPlaceholder: "粘贴或输入房间 ID", nameLabel: "你的昵称",
    namePlaceholder: "怎么称呼你", joinRoom: "加入房间", or: "或", newRoomNameLabel: "新房间名称",
    newRoomNamePlaceholder: "例如：周末电影夜", createRoom: "创建新房间", tokenOptional: "访问令牌（可选）",
    bearerToken: "Bearer Token", tokenPlaceholder: "服务器要求时填写", save: "保存",
    tokenHint: "若服务器设置了访问令牌（401），所有请求都会带上它。", existingRooms: "房间",
    noRooms: "还没有房间，创建一个吧。", copyRoomId: "复制房间 ID",
    newRoom: "创建房间",
    copyRoomIdTitle: ({ id }) => `点击复制完整房间 ID：${id}`, copied: "已复制", members: "成员",
    membersCount: ({ count }) => `成员 ${count}`, noMembers: "暂无成员", settings: "设置", profileMenu: "个人资料和设置",
    questions: "提问", pendingQuestions: "待回答的问题", refreshQuestions: "刷新",
    announcements: "公告栏", announcementName: "名称", announcementContent: "内容",
    reminders: "提醒", reminderSchedule: "计划", reminderOnce: "单次", reminderDate: "日期和时间",
    reminderCron: "5 字段 CRON 表达式", reminderTimezone: "时区覆盖（可选）", reminderTimezoneHint: "留空则使用服务器时区。填写 IANA 时区会应用于两种计划。服务器会拒绝夏令时调整中不存在或重复的单次时间。",
    reminderText: "提醒内容", reminderTemplateHint: "可使用 {{time}}、{{initiator}} 和 {{room}}。", reminderCreate: "创建提醒",
    reminderLoading: "正在加载提醒…", reminderEmpty: "暂无提醒。", reminderPaused: "已暂停", reminderNext: ({ time }) => `下次：${time}`,
    reminderPause: "暂停", reminderResume: "恢复", reminderDelete: "删除", reminderDeleteConfirm: "确定删除此提醒？",
    reminderCreated: "提醒已创建。", reminderUpdated: "提醒已更新。", reminderDeleted: "提醒已删除。",
    reminderInvalid: "请检查日期、5 字段 CRON 表达式、IANA 时区和提醒内容。", reminderLoadFailed: "无法加载提醒，草稿仍已保留。",
    diagramLoading: "正在渲染图表…", diagramRenderFailed: "图表无法显示，以下为源代码。", resourceLoading: "正在加载文件…", resourceFailed: "无法加载此文件。", resourceDownload: "下载", resourcePreview: "预览", resourceHide: "收起预览",
    announcementDelete: "删除公告",
    announcementNew: "新建公告", announcementEmpty: "暂无公告。", announcementLoading: "正在加载公告…",
    announcementLoadFailed: "无法加载公告，草稿仍已保留。", announcementSaved: "公告已保存。", announcementDeleted: "公告已删除。",
    announcementDuplicate: "此名称已存在。请选择该公告进行编辑，或使用其他名称。", announcementDeleteConfirm: ({ name }) => `删除“${name}”？`, announcementCount: ({ count }) => `${count} / 5000`, announcementInvalid: "名称需为 1–64 个字符，内容不能超过 5000 个字符。",
    questionsLoading: "正在加载问题…", questionsEmpty: "没有待回答的问题。",
    questionsFailed: "无法加载问题，请重试。", questionsUnsupported: "此服务器不支持查看待回答问题。", questionLabel: "问题",
    answerQuestion: "回复", answerPlaceholder: "写下回复…", sendAnswer: "发送回复", selectQuestion: "回复此问题", copyQuestion: "复制问题", questionCopied: "问题已复制。", questionCopyFailed: "无法复制问题。",
    answerFailed: "回复失败，草稿仍已保留。", answerTooLong: "回复不能超过 2,000 个字符。", questionAlreadyAnswered: "此问题已由其他人回答。",
    sendAsQuestion: "作为问题发送",
    adminBindingGuide: "选择管理员房间和其中的 Agent，再将邀请私下发送给该 Agent 完成设置。", adminRoomLabel: "管理员房间", adminDesignateAgent: "邀请 Agent",
    adminAccess: "管理", adminToken: "管理令牌", openAdministration: "打开管理面板", administration: "管理面板", designations: "管理绑定", adminRoom: "管理员房间", targetRoom: "Agent 所属房间", adminScopeNote: "请选择管理员房间内的 Agent。管理员可以管理所有房间。", adminRoomBadge: "管理", targetAgent: "已注册 Agent", designate: "指定管理员", revokeDesignation: "撤销绑定", globalStatus: "全局状态", adminTasks: "任务", taskText: "任务内容", dispatchTask: "派发任务", timers: "定时任务", planName: "定时任务名称", createTimer: "创建定时任务",
    adminLoading: "正在加载管理面板…", refreshAdmin: "刷新", adminRoomBadge: "管理", chooseAdminRoom: "选择普通房间", chooseTargetRoom: "选择 Agent 房间", chooseAgent: "选择已注册 Agent", taskTargetRoom: "任务目标房间", taskTargetAgent: "任务目标 Agent", createAdminRoomFirst: "请先按普通流程创建房间，再选作管理房间。", noAgents: "没有已注册的 Agent", selectAdminAgent: "请选择管理房间和已注册的 Agent。", adminDesignated: "管理员已立即生效，长期有效，直到撤销。", revokeConfirm: "撤销此管理绑定？普通房间会保留。", updateTask: "更新任务", task_pending: "待处理", task_working: "进行中", task_blocked: "受阻", task_completed: "已完成", task_cancelled: "已取消", nextRun: ({ time, minutes }) => `每 ${minutes} 分钟 · 下次 ${time}`, paused: "已暂停", pauseTimer: "暂停", resumeTimer: "恢复", deleteTimer: "删除", deleteTimerConfirm: ({ name }) => `删除定时任务“${name}”？`,
    tokenRequired: "服务器要求访问令牌（401）。", leave: "离开", reconnecting: "连接中断，正在重试…",
    messageList: "消息列表", noMessages: "还没有消息，说点什么吧。", latestMessages: "回到最新消息",
    mentionMembers: "选择要提及的成员", messagePlaceholder: "输入消息，Enter 发送",
    attachments: "附件", addFiles: "添加文件", dropFilesHere: "将文件拖到这里添加",
    attachmentVolatile: "附件仅保存在当前标签页，刷新页面后会清除。", retryUpload: "重试", removeFile: "移除",
    uploadQueued: "等待上传", uploadReady: "可以发送", uploadPercent: ({ percent }) => `正在上传 ${percent}%`,
    uploadFailed: "上传失败，请重试或移除文件。",
    fileTooLarge: "文件超过服务器当前大小限制。",
    send: "发送", roomMeta: ({ members, count }) => `${members} 人 · ${count} 条消息`, joinArrow: "加入 →",
    joinDirectTitle: "点击直接加入", mentionEmpty: "没有匹配的成员", mentionHint: "↑↓ 选择 · Enter 确认 · Esc 关闭",
    joined: "已加入", joinAction: "加入房间", unreadMessages: ({ count }) => `${count} 条未读`,
    today: "今天", yesterday: "昨天", earlierMessages: "更早的消息已省略", messagesBetweenOmitted: "此阅读位置与最新消息之间的部分消息已省略。", you: "我", saved: "已保存",
    savedMemory: "仅保存于当前标签页", copyFailed: ({ id }) => `复制失败，请手动复制：${id}`,
    copyMessage: "复制", copiedMessage: "已复制", copyMessageFailed: "复制失败，请手动选择并复制消息。",
    replyMessage: "回复", replyingTo: "回复给", cancelReply: "取消回复", replyOpenOriginal: "查看原始消息", replyOriginalUnavailable: "原始消息不可用。",
    identityChanged: "此浏览器身份已在另一个标签页中更改，请重新加载此标签页后继续。",
    networkError: "网络连接失败", requestFailed: ({ status }) => `请求失败（HTTP ${status}）`,
    roomIdRequired: "请输入房间 ID", nameRequired: "请输入你的昵称", authRetry: "服务器要求访问令牌，请填写后重试",
    networkRetry: "无法连接服务器，请检查网络后重试", joinFailed: ({ message }) => `加入失败：${message}`,
    roomNameRequired: "请输入房间名称", createFailed: ({ message }) => `创建失败：${message}`,
    roomNotFound: "房间不存在，或你已被移出房间", sendAuth: "发送失败：需要访问令牌",
    sendNetwork: "发送失败，消息已保存在下方", sendFailed: ({ message }) => `发送失败：${message}`,
    adminRoomDeleteDenied: "此房间用于管理。请先在设置中输入管理令牌，再删除房间。",
    failedMessages: "未发送的消息", retryFailed: "重试", discardFailed: "删除",
    roomListError: "无法加载房间列表，可直接输入房间 ID 加入。", guest: "访客", roomsLabel: "房间列表",
    refreshRooms: "刷新房间", identityLabel: ({ name }) => `当前昵称：${name}`, roomsMenu: "打开房间列表", closeRoomList: "关闭房间列表", direct: "私聊",
    messagePrivately: "私聊", removeMember: "移除", kickConfirm: ({ name, id }) => `确定将 ${name}（会话 ${id}）移出此房间？`,
    deleteRoom: "删除房间", deleteConfirm: ({ name }) => `删除“${name}”及全部聊天记录？此操作无法撤销。`,
    allMembers: "所有人", messageCount: ({ count }) => `${count} / 2000`,
    privacyNote: "持有共享令牌的人都可以读取私聊内容和管理房间；服务器也可以读取私聊内容。",
    systemJoined: ({ name }) => `${name} 加入了房间`, systemLeft: ({ name }) => `${name} 离开了房间`, systemRemoved: ({ name }) => `${name} 被移出了房间`,
    activity_working: "工作中", activity_idle: "前台空闲", activity_waiting: "等待中", activity_unknown: "状态未知", activity_offline: "状态已过期",
    activityHint_working: "Agent 正在报告工作状态。", activityHint_idle: "前台空闲；后台任务仍可能继续。", activityHint_waiting: "Agent 正在报告等待状态。", activityHint_unknown: "暂无活动状态报告。", activityHint_offline: "最近的状态已过期；这不能证明 Agent 已离线。",
    receiptCount: ({ count }) => `已读 ${count} 人`, receiptNone: "尚无人已读", receiptNotLoaded: "尚未加载已读状态", readerPanelTitle: "消息已读情况", close: "关闭", departedMember: "已离开",
    receiptEvidence_displayed: "已显示在屏幕上", receiptEvidence_tool: "通过房间工具读取", receiptEvidence_context: "进入上下文",
  },
};

app.t = (key, values = {}) => {
  const entry = messages[app.locale][key] ?? messages.en[key] ?? key;
  const text = typeof entry === "function" ? entry(values) : entry;
  return String(text).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
};
export const { LS, saveToken, api, apiBlob, adminApi } = createAuth(undefined, undefined, (key, values) => app.t(key, values));
app.LS = LS;
app.api = api;
app.apiBlob = apiBlob;
app.adminApi = adminApi;
app.setToken = saveToken;
app.locale = LS.locale === "zh-CN" ? "zh-CN" : "en";
app.state.joinedIds = new Set(LS.joinedRoomIds);
app.state.drafts = new Map(Object.entries(LS.drafts));
app.state.positions = new Map(Object.entries(LS.positions).map(([id, value]) => [id, value && typeof value === "object" ? value : Number(value) || 0]));
app.state.lastReadTs = new Map(Object.entries(LS.readTs).map(([id, value]) => [id, Number(value) || 0]));
app.state.roomNames = new Map(Object.entries(LS.roomNames));
app.state.failedMessages = new Map(Object.entries(LS.failedMessages).map(([id, items]) => [id, Array.isArray(items) ? items.filter((item) => item && typeof item.id === "string" && typeof item.text === "string") : []]));
app.saveDraft = (roomId, text) => {
  app.state.drafts.set(roomId, text);
  LS.drafts = Object.fromEntries(app.state.drafts);
};
app.clearDraft = (roomId) => {
  app.state.drafts.delete(roomId);
  LS.drafts = Object.fromEntries(app.state.drafts);
};
app.saveFailedMessages = (roomId, items) => {
  if (items.length) app.state.failedMessages.set(roomId, items);
  else app.state.failedMessages.delete(roomId);
  LS.failedMessages = Object.fromEntries(app.state.failedMessages);
};
app.savePosition = (roomId, position) => {
  app.state.positions.set(roomId, position);
  LS.positions = Object.fromEntries(app.state.positions);
};
app.saveReadTs = (roomId, timestamp) => {
  app.state.lastReadTs.set(roomId, timestamp);
  LS.readTs = Object.fromEntries(app.state.lastReadTs);
};
app.clearPosition = (roomId) => {
  app.state.positions.delete(roomId);
  LS.positions = Object.fromEntries(app.state.positions);
  app.state.lastReadTs.delete(roomId);
  LS.readTs = Object.fromEntries(app.state.lastReadTs);
};
app.saveJoinedIds = () => { LS.joinedRoomIds = [...app.state.joinedIds]; };
app.saveRoomNames = () => { LS.roomNames = Object.fromEntries(app.state.roomNames); };
app.setText = (element, key, values = {}) => {
  element.dataset.i18n = key;
  element._i18nValues = values;
  element.textContent = app.t(key, values);
};
app.applyLocale = () => {
  document.documentElement.lang = app.locale;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = element._flashKey
      ? app.t(element._flashKey)
      : app.t(element.dataset.i18n, element._i18nValues || {});
  });
  for (const attribute of ["aria-label", "aria-placeholder", "title", "placeholder"]) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, app.t(element.getAttribute(`data-i18n-${attribute}`), element._i18nValues || {}));
    });
  }
  document.querySelectorAll(".locale-select").forEach((select) => { select.value = app.locale; });
  app.autoGrow?.(app.$("#msgInput"));
  app.updateDraftCount?.();
  app.updateMentionList?.();
  app.renderFailedMessages?.();
  if (app.state.room) {
    app.renderHead();
    app.renderMembers();
    app.rerenderMessages();
  } else app.updateTitle();
};
app.setLocale = (locale) => {
  app.locale = locale === "zh-CN" ? "zh-CN" : "en";
  LS.locale = app.locale;
  app.applyLocale();
};

app.intlLocale = () => app.locale === "zh-CN" ? "zh-CN" : "en-US";
app.fmtTime = (timestamp) => {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString()
    ? `${app.t("today")} ${app.timeHM(timestamp)}`
    : new Intl.DateTimeFormat(app.intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
};
app.timeHM = (timestamp) => new Date(timestamp).toLocaleTimeString(app.intlLocale(), { hour: "2-digit", minute: "2-digit" });
app.dayText = (timestamp) => {
  const date = new Date(timestamp), now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = Math.round((today - thatDay) / 86400000);
  if (difference === 0) return app.t("today");
  if (difference === 1) return app.t("yesterday");
  return new Intl.DateTimeFormat(app.intlLocale(), { month: "short", day: "numeric" }).format(date);
};
app.flash = (button, key) => {
  const output = button.querySelector("[data-flash-output]");
  button._flashKey = key;
  if (output) {
    output._flashKey = key; output.hidden = false; output.textContent = app.t(key);
    button.classList.add("is-flashing");
    if (button.dataset.i18nAriaLabel) button.setAttribute("aria-label", app.t(key));
  } else button.textContent = app.t(key);
  setTimeout(() => {
    if (button._flashKey !== key) return;
    delete button._flashKey;
    if (output) {
      delete output._flashKey; output.hidden = true; output.textContent = app.t(output.dataset.i18n, output._i18nValues || {});
      button.classList.remove("is-flashing");
      if (button.dataset.i18nAriaLabel) button.setAttribute("aria-label", app.t(button.dataset.i18nAriaLabel));
    } else button.textContent = app.t(button.dataset.i18n, button._i18nValues || {});
  }, 1200);
};
app.updateTitle = () => {
  const title = app.state.room ? app.t("roomTitle", { name: app.state.room.name }) : app.t("documentTitle");
  const active = app.state.room?.id;
  let total = 0;
  for (const [id, entry] of app.state.rooms) total += id === active ? app.state.unread : entry.unreadIds.size + (entry.unreadOverflow ? 100 : 0);
  document.title = total ? `(${total}) ${title}` : title;
};
app.setOnline = (online) => { app.$("#connBar").hidden = online; };
app.showSendError = (key, values = {}) => {
  app.setText(app.$("#sendError"), key, values);
  app.$("#sendError").hidden = false;
};
app.hideSendError = () => { app.$("#sendError").hidden = true; };
app.showJoinError = (key, values = {}) => {
  app.setText(app.$("#joinError"), key, values);
  app.$("#joinError").hidden = false;
};
app.hideJoinError = () => { app.$("#joinError").hidden = true; };
