export const app = {
  $: (selector) => document.querySelector(selector),
  state: {
    room: null, myName: "", unread: 0, drafts: new Map(), rooms: new Map(),
    pollGeneration: 0, navigationGeneration: 0, draftRevision: new Map(), memberSessions: new Map(),
    retryingFailedIds: new Set(), pollController: null, memberRefreshTimer: 0, receiptRefreshTimer: 0, receiptObservationFrame: 0,
    receiptObservation: null,
    memberApiUnavailable: new Set(), receiptApiUnavailable: new Set(),
    receipts: new Map(), acknowledgedMessages: new Map(), pendingAcknowledgements: new Map(),
    pendingAction: null, watcherTimer: 0, restored: false,
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
    get positions() { try { return JSON.parse(readSession("chat.positions") || "{}"); } catch { return {}; } },
    set positions(value) { writeSession("chat.positions", JSON.stringify(value)); },
    get failedMessages() {
      try {
        const value = JSON.parse(readSession("chat.failedMessages") || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    },
    set failedMessages(value) { writeSession("chat.failedMessages", JSON.stringify(value)); },
  };
  const saveToken = (value) => { auth.token = String(value ?? "").trim(); return auth.token; };
  const api = async (url, options = {}) => {
    assertIdentity();
    const headers = { ...options.headers };
    if (options.body) headers["Content-Type"] = "application/json";
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    let response;
    try { response = await (fetcher ?? globalThis.fetch)(url, { ...options, headers }); }
    catch {
      const error = new Error(translate("networkError"));
      error.network = true;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    assertIdentity();
    if (!response.ok) {
      const error = new Error(data.error || translate("requestFailed", { status: response.status }));
      error.status = response.status;
      throw error;
    }
    return data;
  };
  return { LS: auth, saveToken, api };
}

const messages = {
  en: {
    brand: "Casual Chat", documentTitle: "Casual Chat · Lightweight Chatroom",
    roomTitle: ({ name }) => `${name} · Casual Chat`,
    tagline: "A lightweight chat room. Enter a room ID to join, or create a new one.",
    languageLabel: "Language", roomIdLabel: "Room ID", roomIdPlaceholder: "Paste or enter a room ID",
    nameLabel: "Your name", namePlaceholder: "What should we call you?", joinRoom: "Join room",
    or: "or", newRoomNameLabel: "New room name", newRoomNamePlaceholder: "e.g. Weekend movie night",
    createRoom: "Create room", tokenOptional: "Access token (optional)", bearerToken: "Bearer token",
    tokenPlaceholder: "Enter if the server requires it", save: "Save",
    tokenHint: "If the server requires an access token (401), all requests will include it.",
    existingRooms: "Rooms", noRooms: "No rooms yet. Create one.", copyRoomId: "Copy room ID",
    newRoom: "Create a room",
    copyRoomIdTitle: ({ id }) => `Click to copy the full room ID: ${id}`, copied: "Copied",
    members: "Members", membersCount: ({ count }) => `Members (${count})`, noMembers: "No members yet.",
    settings: "Settings", tokenRequired: "The server requires an access token (401).",
    leave: "Leave", reconnecting: "Connection lost. Retrying…", messageList: "Message list",
    noMessages: "No messages yet. Say something.", latestMessages: "Back to latest messages",
    mentionMembers: "Choose a member to mention", messagePlaceholder: "Message · Enter sends · Shift+Enter adds a line",
    send: "Send", roomMeta: ({ members, count }) => `${members} ${members === 1 ? "member" : "members"} · ${count} ${count === 1 ? "message" : "messages"}`,
    joinArrow: "Join →", joinDirectTitle: "Click to join directly", mentionEmpty: "No matching members",
    joined: "Joined", joinAction: "Join room", unreadMessages: ({ count }) => `${count} unread`,
    mentionHint: "↑↓ Select · Enter to confirm · Esc to close", today: "Today", yesterday: "Yesterday",
    earlierMessages: "Earlier messages omitted", you: "You", saved: "Saved",
    savedMemory: "Saved for this tab only", copyFailed: ({ id }) => `Copy failed. Copy manually: ${id}`,
    copyCode: "Copy code", copiedCode: "Copied", copyCodeFailed: "Could not copy code. Select and copy it manually.",
    copyMessage: "Copy", copiedMessage: "Copied", copyMessageFailed: "Could not copy. Select and copy the message manually.",
    identityChanged: "This browser identity changed in another tab. Reload this tab before continuing.",
    networkError: "Network connection failed", requestFailed: ({ status }) => `Request failed (HTTP ${status})`,
    roomIdRequired: "Enter a room ID", nameRequired: "Enter your name", authRetry: "The server requires an access token. Enter it and try again.",
    networkRetry: "Unable to connect to the server. Check your network and try again.",
    joinFailed: ({ message }) => `Could not join: ${message}`, roomNameRequired: "Enter a room name",
    createFailed: ({ message }) => `Could not create the room: ${message}`,
    roomNotFound: "This room is gone, or you no longer have access.",
    sendAuth: "Send failed: an access token is required", sendNetwork: "Send failed. Your message is saved below.",
    sendFailed: ({ message }) => `Send failed: ${message}`,
    failedMessages: "Messages not sent", retryFailed: "Retry", discardFailed: "Discard",
    roomListError: "Unable to load rooms. You can enter a room ID directly.", guest: "Guest",
    roomsLabel: "Rooms", refreshRooms: "Refresh rooms", identityLabel: ({ name }) => `Chatting as ${name}`,
    direct: "Direct", messagePrivately: "Message privately", removeMember: "Remove",
    kickConfirm: ({ name, id }) => `Remove ${name} (session ${id}) from this room?`,
    deleteRoom: "Delete room", deleteConfirm: ({ name }) => `Delete “${name}” and all its messages? This cannot be undone.`,
    allMembers: "Everyone", messageCount: ({ count }) => `${count} / 2000`,
    privacyNote: "Anyone with the shared token can read direct messages and manage rooms; the server can read them too.",
    systemJoined: ({ name }) => `${name} joined the room`, systemLeft: ({ name }) => `${name} left the room`, systemRemoved: ({ name }) => `${name} was removed from the room`,
    activity_working: "Working", activity_idle: "Foreground idle", activity_waiting: "Waiting", activity_unknown: "Status unknown", activity_offline: "Status stale",
    activityHint_working: "The agent reports active work.", activityHint_idle: "Foreground is idle; background work may continue.", activityHint_waiting: "The agent reports that it is waiting.", activityHint_unknown: "No activity report is available.", activityHint_offline: "The last status is stale; this does not prove the agent is offline.",
    receiptCount: ({ count }) => `Read by ${count}`, departedMember: "left",
    receiptEvidence_displayed: "Shown on screen", receiptEvidence_tool: "Fetched with room tool", receiptEvidence_context: "Full message reached agent context preparation (not proof of understanding)",
  },
  "zh-CN": {
    brand: "闲叙", documentTitle: "闲叙 · 轻量聊天室", roomTitle: ({ name }) => `${name} · 闲叙`,
    tagline: "一个轻量的聊天房间。输入房间 ID 加入，或直接新建一个。", languageLabel: "语言",
    roomIdLabel: "房间 ID", roomIdPlaceholder: "粘贴或输入房间 ID", nameLabel: "你的昵称",
    namePlaceholder: "怎么称呼你", joinRoom: "加入房间", or: "或", newRoomNameLabel: "新房间名称",
    newRoomNamePlaceholder: "例如：周末电影夜", createRoom: "创建新房间", tokenOptional: "访问令牌（可选）",
    bearerToken: "Bearer Token", tokenPlaceholder: "服务器要求时填写", save: "保存",
    tokenHint: "若服务器设置了访问令牌（401），所有请求都会带上它。", existingRooms: "房间",
    noRooms: "还没有房间，创建一个吧。", copyRoomId: "复制房间 ID",
    newRoom: "创建房间",
    copyRoomIdTitle: ({ id }) => `点击复制完整房间 ID：${id}`, copied: "已复制", members: "成员",
    membersCount: ({ count }) => `成员 ${count}`, noMembers: "暂无成员", settings: "设置",
    tokenRequired: "服务器要求访问令牌（401）。", leave: "离开", reconnecting: "连接中断，正在重试…",
    messageList: "消息列表", noMessages: "还没有消息，说点什么吧。", latestMessages: "回到最新消息",
    mentionMembers: "选择要提及的成员", messagePlaceholder: "输入消息，Enter 发送，Shift+Enter 换行",
    send: "发送", roomMeta: ({ members, count }) => `${members} 人 · ${count} 条消息`, joinArrow: "加入 →",
    joinDirectTitle: "点击直接加入", mentionEmpty: "没有匹配的成员", mentionHint: "↑↓ 选择 · Enter 确认 · Esc 关闭",
    joined: "已加入", joinAction: "加入房间", unreadMessages: ({ count }) => `${count} 条未读`,
    today: "今天", yesterday: "昨天", earlierMessages: "更早的消息已省略", you: "我", saved: "已保存",
    savedMemory: "仅保存于当前标签页", copyFailed: ({ id }) => `复制失败，请手动复制：${id}`,
    copyCode: "复制代码", copiedCode: "已复制", copyCodeFailed: "复制失败，请手动选择并复制代码。",
    copyMessage: "复制", copiedMessage: "已复制", copyMessageFailed: "复制失败，请手动选择并复制消息。",
    identityChanged: "此浏览器身份已在另一个标签页中更改，请重新加载此标签页后继续。",
    networkError: "网络连接失败", requestFailed: ({ status }) => `请求失败（HTTP ${status}）`,
    roomIdRequired: "请输入房间 ID", nameRequired: "请输入你的昵称", authRetry: "服务器要求访问令牌，请填写后重试",
    networkRetry: "无法连接服务器，请检查网络后重试", joinFailed: ({ message }) => `加入失败：${message}`,
    roomNameRequired: "请输入房间名称", createFailed: ({ message }) => `创建失败：${message}`,
    roomNotFound: "房间不存在，或你已被移出房间", sendAuth: "发送失败：需要访问令牌",
    sendNetwork: "发送失败，消息已保存在下方", sendFailed: ({ message }) => `发送失败：${message}`,
    failedMessages: "未发送的消息", retryFailed: "重试", discardFailed: "删除",
    roomListError: "无法加载房间列表，可直接输入房间 ID 加入。", guest: "访客", roomsLabel: "房间列表",
    refreshRooms: "刷新房间", identityLabel: ({ name }) => `当前昵称：${name}`, direct: "私聊",
    messagePrivately: "私聊", removeMember: "移除", kickConfirm: ({ name, id }) => `确定将 ${name}（会话 ${id}）移出此房间？`,
    deleteRoom: "删除房间", deleteConfirm: ({ name }) => `删除“${name}”及全部聊天记录？此操作无法撤销。`,
    allMembers: "所有人", messageCount: ({ count }) => `${count} / 2000`,
    privacyNote: "持有共享令牌的人都可以读取私聊内容和管理房间；服务器也可以读取私聊内容。",
    systemJoined: ({ name }) => `${name} 加入了房间`, systemLeft: ({ name }) => `${name} 离开了房间`, systemRemoved: ({ name }) => `${name} 被移出了房间`,
    activity_working: "工作中", activity_idle: "前台空闲", activity_waiting: "等待中", activity_unknown: "状态未知", activity_offline: "状态已过期",
    activityHint_working: "Agent 正在报告工作状态。", activityHint_idle: "前台空闲；后台任务仍可能继续。", activityHint_waiting: "Agent 正在报告等待状态。", activityHint_unknown: "暂无活动状态报告。", activityHint_offline: "最近的状态已过期；这不能证明 Agent 已离线。",
    receiptCount: ({ count }) => `已读 ${count} 人`, departedMember: "已离开",
    receiptEvidence_displayed: "已显示在屏幕上", receiptEvidence_tool: "通过房间工具读取", receiptEvidence_context: "完整消息已进入 Agent 上下文准备阶段（不代表已理解）",
  },
};

app.t = (key, values = {}) => {
  const entry = messages[app.locale][key] ?? messages.en[key] ?? key;
  const text = typeof entry === "function" ? entry(values) : entry;
  return String(text).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
};
export const { LS, saveToken, api } = createAuth(undefined, undefined, (key, values) => app.t(key, values));
app.LS = LS;
app.api = api;
app.setToken = saveToken;
app.locale = LS.locale === "zh-CN" ? "zh-CN" : "en";
app.state.joinedIds = new Set(LS.joinedRoomIds);
app.state.drafts = new Map(Object.entries(LS.drafts));
app.state.positions = new Map(Object.entries(LS.positions).map(([id, value]) => [id, Number(value) || 0]));
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
app.clearPosition = (roomId) => {
  app.state.positions.delete(roomId);
  LS.positions = Object.fromEntries(app.state.positions);
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
  for (const attribute of ["aria-label", "title", "placeholder"]) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, app.t(element.getAttribute(`data-i18n-${attribute}`), element._i18nValues || {}));
    });
  }
  document.querySelectorAll(".locale-select").forEach((select) => { select.value = app.locale; });
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
  button._flashKey = key;
  button.textContent = app.t(key);
  setTimeout(() => {
    if (button._flashKey !== key) return;
    delete button._flashKey;
    button.textContent = app.t(button.dataset.i18n, button._i18nValues || {});
  }, 1200);
};
app.updateTitle = () => {
  const title = app.state.room ? app.t("roomTitle", { name: app.state.room.name }) : app.t("documentTitle");
  document.title = app.state.unread ? `(${app.state.unread}) ${title}` : title;
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
