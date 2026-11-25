import { extraLocales } from "./locales/index.js";

// Upper bound on messages kept in memory per open room; older pages load on scroll.
export const LOADED_MESSAGE_LIMIT = 5000;

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
    readAnchorGuard: null, userScrollIntentUntil: 0, listMetrics: { height: 0, top: 0, client: 0 }, followBottom: true, threadPointerDown: false,
  },
  rendered: 0,
  firstMessageId: null,
  locale: "en",
  pollDelay: 2000,
  copyTimer: 0,
  failedRenderIds: new Set(),
};

// Phones and tablets lack the hardware keyboard the shortcut hint assumes.
// iPadOS reports a desktop Macintosh UA, so touch points identify it there.
export function isMobileDevice() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

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

// Media cached by the service worker belongs to a browser identity; drop it whenever
// that identity changes and keep only the current identity record.
const clearMediaCache = () => {
  try { globalThis.navigator?.serviceWorker?.controller?.postMessage({ type: "CLEAR_MEDIA_CACHE" }); } catch { /* Cache cleanup is best effort. */ }
};

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
    const priorID = readSession("chat.sessionID");
    let store;
    try {
      store = storage ?? globalThis.localStorage;
      const canonical = parseIdentity(store.getItem(identityKey));
      if (canonical) {
        browserIdentity = canonical;
        identityPersistent = true;
        if (priorID && priorID !== canonical.sessionID) { clearMediaCache(); void postMediaIdentity(); }
        syncTabIdentity();
        return canonical;
      }
    } catch { /* Keep this tab's identity in memory when storage is blocked. */ }
    browserIdentity = { sessionID: validSessionID(priorID) ? priorID : createRandomId(), name: validSessionID(priorID) ? (readSession("chat.name") || "").slice(0, 64) : "" };
    if (priorID && priorID !== browserIdentity.sessionID) { clearMediaCache(); void postMediaIdentity(); }
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
    get theme() { return read("chat.theme") || "system"; }, set theme(value) { write("chat.theme", value || null); },
    get contentTransition() { return read("chat.contentTransition") === "1"; }, set contentTransition(value) { write("chat.contentTransition", value ? "1" : null); },
    get pageStep() { const raw = read("chat.pageStep"); const value = Number(raw); return raw !== null && raw !== "" && Number.isFinite(value) ? Math.min(200, Math.max(20, Math.round(value))) : 90; }, set pageStep(value) { const next = Number(value); write("chat.pageStep", Number.isFinite(next) ? String(Math.min(200, Math.max(20, Math.round(next)))) : null); },

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
  const saveToken = (value) => {
    const next = String(value ?? "").trim();
    const changed = next !== auth.token;
    auth.token = next;
    // A token change can change what the person may see, so cached images must not
    // survive into the new identity. An empty value is the sign-out path.
    if (changed) { clearMediaCache(); void postMediaIdentity(); }
    return auth.token;
  };
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
  return { LS: auth, saveToken, api, apiBlob };
}

export const messages = {
  en: {
    brand: "OC Chat", documentTitle: "OC Chat",
    roomTitle: ({ name }) => `${name} · OC Chat`,
    tagline: "A lightweight chat room. Enter a room ID to join, or create a new one.",
    restoringSession: "Restoring your session…", retry: "Retry", roomOptions: "Options",
    languageLabel: "Language", roomIdLabel: "Room ID", roomIdPlaceholder: "Paste or enter a room ID",
    nameLabel: "Your name", namePlaceholder: "What should we call you?", joinRoom: "Join room",
    or: "or", newRoomNameLabel: "New room name", newRoomNamePlaceholder: "e.g. Weekend movie night",
    createRoom: "Create room", joinRoomTitle: "Join a room", joinRoomHint: "Someone shared a room ID with you? Paste it here.",
    createRoomTitle: "Create a room", createRoomHint: "Start a new room and invite people with its ID.",
    requireApproval: "Require approval to join", requireApprovalHint: "New members need a human administrator's approval. Agents may also be approved by the administrator agent.",
    joinPolicyEditHint: "New members need a human administrator's approval. Turning this off clears all pending requests.", joinPolicyOpenConfirm: "Turn off approval? All pending join requests will be cleared.",
    approvalRequired: "Approval required", joinRequired: "Approval required", joinPendingStatus: "Approval pending",
    joinPendingTitle: "Waiting for approval", joinApprovalPrompt: ({ name }) => `Request to join “${name}”? A human administrator must approve it.`, joinPendingBody: ({ name }) => `Your request to join “${name}” was sent. A human administrator must approve it before you can join.`,
    joinPendingHint: "You can leave this page; the request stays pending. Check the room list later.", joinPendingNotice: ({ name }) => `Request sent to join “${name}”. Waiting for a human administrator.`, joinPendingCancel: "Cancel request", joinPendingCancelError: "Could not cancel the request. Try again.",
    joinPendingGoneTitle: "Request not pending", joinPendingGoneBody: "It may have been denied or cleared. You can send a new request.", joinPendingAgain: "Request again",
    joinPendingError: "Could not check the request. Try again.", joinPendingRoomGone: "This room is gone, or you no longer have access.",
    joinNameTaken: "That name is already used in this room. Choose another name.",
    joinRequestsTitle: "Join requests", joinRequestsHint: "Agent requests can also be approved by the administrator agent.", joinRequestsEmpty: "No pending requests.",
    joinRequestsLoadFailed: "Could not load join requests.", joinRequestAlreadyHandled: "This request was already handled.", joinRequestApprove: "Approve", joinRequestDeny: "Deny", joinRequestAgent: "Agent", joinRequestHuman: "Human",
    joinRequestApproveLabel: ({ name }) => `Approve ${name}`, joinRequestDenyLabel: ({ name }) => `Deny ${name}`,
    joinRequestTime: ({ time }) => `Requested ${time}`, joinRequestApproved: ({ name }) => `${name} approved.`, joinRequestDenied: ({ name }) => `${name} denied.`,
    joinRequestActionFailed: ({ message }) => `Could not update the request: ${message}`, membersWithRequests: ({ count }) => `Members, ${count} join request${count === 1 ? "" : "s"} pending`,
    accessKeyTitle: "Access key", accessKeyHint: "This server asks for an access key. It stays in this browser and is sent with each request.",
    tokenOptional: "Access token (optional)", bearerToken: "Bearer token",
    tokenPlaceholder: "Enter if the server requires it", save: "Save",
    tokenHint: "If the server requires an access token (401), all requests will include it.",
    existingRooms: "Rooms", noRooms: "No rooms yet. Create one.", copyRoomId: "Copy room ID", loadingHistory: "Loading earlier messages",
    editRoom: "Edit room", editRoomSections: "Edit room sections", editRoomDetails: "Room details", editRoomJoining: "Joining & approval", editRoomMembers: "Members & roles", editRoomOwnership: "Ownership", roomOwnerOnlyTitle: "Owner or administrator only", roomOwnerOnlyNote: ({ owner }) => `Only the room owner or a room administrator can change these settings. This room belongs to ${owner}.`, roomNameLabel: "Room name", roomDescriptionLabel: "Description", adminAgentLabel: "Administrator agent", roomOwnerBadge: "Owner", roomAdminBadge: "Admin",
    adminIdsLabel: "Human administrators", adminIdsHint: "These members can edit room details, manage members, delete files, and choose a successor. The owner always has the same powers.", adminIdsEmpty: "No other members are in this room yet.", newOwnerLabel: "New owner", newOwnerHint: "Hand the room to another person who is in it. Only the owner can do this; agents cannot own a room.",
    successorLabel: "Successor if the owner leaves", successorNone: "Longest-present member", successorHint: "If the owner leaves, this person becomes owner. If an administrator leaves, this person takes that role. Leave empty to use the longest-present member.", ownerOnlySettingsNote: "Only the owner can change the administrator agent or hand off the room.", adminAgentHint: "The designated agent can use the admin tool to inspect this room and its history. Only the owner can change this; leave empty for none.",
    noAdminAgent: "None", openQuestions: ({ count }) => `${count} unanswered question${count === 1 ? "" : "s"}`,
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
    reminderEdit: "Edit", reminderEditHeading: "Edit reminder", reminderSave: "Save changes",
    reminderCreated: "Reminder created.", reminderUpdated: "Reminder updated.", reminderDeleted: "Reminder deleted.",
    reminderInvalid: "Check the date, 5-field CRON expression, IANA timezone, and reminder text.", reminderLoadFailed: "Could not load reminders. Your draft is still here.",
    diagramLoading: "Rendering diagram…", diagramRenderFailed: "Diagram unavailable; showing its source.", resourceLoading: "Loading file…", resourceFailed: "This file could not be loaded.", resourceDownload: "Download", resourceMoreActions: "More actions for {name}", resourcePreview: "Preview", resourceHide: "Hide preview", docPreviewEyebrow: "Markdown preview", docPreviewFileEyebrow: "File preview", docPreviewFailed: "This document could not be loaded.", docPreviewEmpty: "This document is empty.", docPreviewTooLarge: "This file is too large to preview (over 2 MB). Download it instead.", sidePaneResize: "Resize side pane", zoomImage: "Open image", imagePreviewTitle: "Image preview", imageZoomControls: "Image zoom", zoomIn: "Zoom in", zoomOut: "Zoom out", zoomReset: "Reset zoom", openDiagram: "Open diagram", diagramViewerTitle: "Diagram", diagramZoomControls: "Diagram zoom", diagramFit: "Fit", installTitle: "Install OC Chat", installBody: "Add it to your home screen for a full-screen chat.", installAction: "Install", installHow: "How to install", installNotNow: "Not now", installIosGuide: "Tap Share, then Add to Home Screen.",
    pwaUpdateTitle: "Update available", pwaUpdateBody: "A new version is ready. Reload now, or update the next time you open the app.", pwaUpdateNow: "Update now", pwaUpdateLater: "Later",
    announcementDelete: "Delete announcement",
    announcementNew: "New announcement", announcementEmpty: "No announcements yet.", announcementLoading: "Loading announcements…",
    announcementLoadFailed: "Could not load announcements. Your draft is still here.", announcementSaved: "Announcement saved.", announcementDeleted: "Announcement deleted.",
    announcementDuplicate: "That name already exists. Select it to edit, or choose another name.", announcementDeleteConfirm: ({ name }) => `Delete “${name}”?`, announcementCount: ({ count }) => `${count} / 5000`, announcementInvalid: "Use a name of 1–64 characters and content up to 5000 characters.",
    questionsLoading: "Loading questions…", questionsEmpty: "No unanswered questions.",
    questionsFailed: "Could not load questions. Try again.", questionsUnsupported: "Unanswered questions are unavailable on this server.", questionLabel: "Question",
    answerQuestion: "Reply", answerPlaceholder: "Write a reply…", sendAnswer: "Send reply", selectQuestion: "Reply to question", copyQuestion: "Copy question", questionCopied: "Question copied.", questionCopyFailed: "Could not copy question.",
    answerFailed: "Reply failed. Your draft is still here.", answerTooLong: "Reply must be 5,000 characters or fewer.", questionAlreadyAnswered: "This question was answered elsewhere.",
    adminBindingGuide: "Choose a room and an Agent in it. Send the invitation privately to finish setup.", adminRoomLabel: "Administrator room", adminDesignateAgent: "Invite Agent",
    settings: "Settings", adminAccess: "Administration", adminToken: "Administration token", openAdministration: "Open administration", administration: "Administration", designations: "Designations", adminRoom: "Administrator room", targetRoom: "Agent membership room", adminScopeNote: "Choose an Agent in the administrator room. Administrators can manage all rooms.", targetAgent: "Registered agent", designate: "Designate administrator", revokeDesignation: "Revoke designation", globalStatus: "Global status", adminTasks: "Tasks", taskText: "Task", dispatchTask: "Dispatch task", timers: "Timers", planName: "Timer name", createTimer: "Create timer", tokenRequired: "The server requires an access token (401).",
    themeLabel: "Theme", themeSystem: "System", themeLight: "Light", themeDark: "Dark", themeForest: "Forest", themeSand: "Sand",
    settingsLocalHint: "Language, theme, transition, and scrolling preferences are saved in this browser.",
    settingsSections: "Settings sections", settingsGeneral: "General", settingsAppearance: "Appearance", settingsConnection: "Connection",
    settingsLanguageHint: "Applies right away and is saved in this browser.", settingsThemeHint: "Saved in this browser. System follows your device.", settingsTokenHint: "Stored only in this browser. Needed only when the server asks for it.",
    contentTransition: "Room content transition", contentTransitionHint: "Slide messages in when switching rooms with Alt+Arrow. Off by default.",
    pageStep: "Page scroll distance", pageStepHint: "How far PageUp and PageDown move per press, as a percentage of the conversation height. Default 90%.",
    adminLoading: "Loading administration…", refreshAdmin: "Refresh", adminRoomBadge: "admin", chooseAdminRoom: "Choose a normal room", chooseTargetRoom: "Choose an agent room", chooseAgent: "Choose a registered agent", taskTargetRoom: "Target room", taskTargetAgent: "Target agent", createAdminRoomFirst: "Create a normal room first, then select it as the admin room.", noAgents: "No registered agents", selectAdminAgent: "Choose an admin room and registered agent.", adminDesignated: "Administrator designation is active immediately and stays until you revoke it.", revokeConfirm: "Revoke this admin designation? The normal room will remain.", updateTask: "Update task", task_pending: "Pending", task_working: "Working", task_blocked: "Blocked", task_completed: "Completed", task_cancelled: "Cancelled", nextRun: ({ time, minutes }) => `Every ${minutes} min · next ${time}`, paused: "Paused", pauseTimer: "Pause", resumeTimer: "Resume", deleteTimer: "Delete", deleteTimerConfirm: ({ name }) => `Delete timer “${name}”?`,
    leave: "Leave", reconnecting: "Connection lost. Retrying…", messageList: "Message list",
    noMessages: "No messages yet. Say something.", latestMessages: "Back to latest messages",
    mentionMembers: "Choose a member to mention", messagePlaceholder: "Message · Enter to send",
    attachments: "Attachments", addFiles: "Add files", dropFilesHere: "Drop files here to attach",
    attachmentVolatile: "Pasted files are recovered after reload; picked files stay in this tab.", attachmentNotPersisted: "This file is too large to save for reload. Keep this tab open until it is sent.", retryUpload: "Retry", removeFile: "Remove",
    uploadQueued: "Waiting to upload", uploadReady: "Ready to send", sendAsFileFailed: "Upload failed. Your text is still in the composer.", uploadPercent: ({ percent }) => `Uploading ${percent}%`,
    uploadFailed: ({ reason } = {}) => reason ? `Upload failed (${reason}). Retry or remove the file.` : "Upload failed. Retry or remove the file.",
    fileUnreadable: "This file cannot be read: it may be a temporary file from another app, or still in the cloud. Save it to disk (or take a screenshot) and attach that.",
    fileTooLarge: "File exceeds the server's current size limit.",
    send: "Send", roomMeta: ({ members, count }) => `${members} ${members === 1 ? "member" : "members"} · ${count} ${count === 1 ? "message" : "messages"}`,
    joinArrow: "Join →", joinDirectTitle: "Click to join directly", mentionEmpty: "No matching members",
    joined: "Joined", joinAction: "Join room", unreadMessages: ({ count }) => `${count} unread`,
    mentionHint: "↑↓ Select · Enter to confirm · Esc to close", today: "Today", yesterday: "Yesterday",

    shortcutsTitle: "Keyboard shortcuts", shortcutsLead: "ChatRoom shortcuts. Press {modifier} + / to open this list.",
    shortcutsOpen: "All shortcuts",
    shortcutsWriting: "Writing", shortcutsSend: "Send the message", shortcutsNewline: "Start a new line",
    shortcutsMention: "Choose a member to mention", shortcutsRooms: "Rooms", shortcutsSearch: "Search and commands", shortcutsOpenPalette: "Open search and commands",
    shortcutsSwitchRoom: "Switch to the previous or next room", shortcutsNumberRoom: "Switch to a joined room by number", shortcutsReading: "Reading",
    shortcutsScroll: "Scroll messages while typing", shortcutsJump: "Jump to the start or end of the conversation", shortcutsMenus: "Menus and dialogs",
    shortcutsClose: "Close the open menu, panel, or dialog",
    paletteTitle: "Search and commands", paletteSearchLabel: "Search messages",
    palettePlaceholder: "Search messages, or type / for commands", paletteScopeRoom: "This room", paletteScopeAll: "All rooms",
    paletteScopeHint: "Tab switches between this room and all joined rooms", paletteSearchMode: "Search", paletteCommandMode: "Commands",
    paletteSearching: "Searching…", paletteNoResults: "No messages found.", paletteNoCommands: "No matching commands.",
    paletteResults: ({ count }) => `${count} result${count === 1 ? "" : "s"}`, paletteCommandsHint: "Common commands",
    paletteHint: "↑↓ or Alt+1–9 select · Enter open · Tab scope · Esc close", paletteSearchFailed: "Search failed. Try again.",
    paletteLeaveRoom: "Leave room", paletteJumpLatest: "Jump to latest",
    filesTitle: "Files", filesEyebrow: "Room files", filesFilter: "Uploaded by", filesEveryone: "Everyone",
    filesUnknownUploader: "Unknown uploader", filesSummary: ({ count, size }) => `${count} file${count === 1 ? "" : "s"} · ${size}`,
    filesLoading: "Loading files…", filesLoadFailed: "Could not load files. Try again.", filesEmpty: "No files in this room yet.",
    filesEmptyFiltered: "No files from this uploader.", filesLoadMore: "Load more",
    filesHint: "Preview images, audio, video, Markdown, text, code, and PDF. Download any file.",
    filesPreviewFailed: "Could not load this preview.", filesDownloadFailed: "Could not download this file.",
    filesPreviewLabel: ({ name }) => `Preview ${name}`, filesDownloadLabel: ({ name }) => `Download ${name}`,
    filesDeleteLabel: ({ name }) => `Delete ${name}`, filesRefresh: "Refresh files",
    tasksTitle: "Tasks", tasksEyebrow: "Room tasks", tasksRefresh: "Refresh tasks", tasksMenuLabel: "Task actions",
    tasksClearCompleted: "Clear completed", tasksClearConfirm: ({ count }) => `Clear ${count} completed task${count === 1 ? "" : "s"}? This cannot be undone.`,
    tasksClearFailed: "Could not clear completed tasks. Try again.",
    tasksLoading: "Loading tasks…", tasksLoadFailed: "Could not load tasks. Try again.", tasksEmpty: "No tasks yet. Add the first one.",
    tasksEmptyFiltered: "No tasks with this status.", tasksCreate: "Add task", tasksTitleLabel: "Title",
    tasksTitlePlaceholder: "What needs doing?", tasksDescriptionLabel: "Description", tasksDescriptionPlaceholder: "Add details, links, or acceptance notes",
    tasksAssigneeLabel: "Assignee", tasksUnassigned: "Unassigned", tasksFilterLabel: "Show", tasksFilterAll: "All statuses",
    tasksDueDateLabel: "Due date", tasksDueOn: ({ date }) => `Due ${date}`, tasksOverdue: "Overdue",
    tasksParticipantsLabel: "Participants", tasksParticipantsMeta: ({ names }) => `Participants: ${names}`,
    tasksConclusionLabel: "Conclusion", tasksConclusionPlaceholder: "What was the outcome?",
    tasksStepsLabel: "Steps", tasksAddStep: "Add step", tasksRemoveStep: "Remove step", tasksStepPlaceholder: "Describe a step",
    tasksStepDoneLabel: "Step done", tasksStepsHint: "Up to 30 steps. Check the ones that are done.",
    tasksStepsProgress: ({ done, total }) => `${done} of ${total} step${total === 1 ? "" : "s"} done`,
    tasksStatusTodo: "To do", tasksStatusDoing: "Doing", tasksStatusDone: "Done",
    tasksSummary: ({ count }) => `${count} task${count === 1 ? "" : "s"}`, tasksCreator: ({ name }) => `Created by ${name}`, tasksUpdated: ({ time }) => `Updated ${time}`,
    tasksEditLabel: ({ title }) => `Edit ${title}`, tasksDeleteLabel: ({ title }) => `Delete ${title}`, tasksStatusFor: ({ title }) => `Status for ${title}`,
    tasksInvalid: "Add a title of 1–200 characters.", tasksCreateFailed: "Could not add this task. Try again.", tasksUpdateFailed: "Could not update this task. Try again.",
    tasksDeleteFailed: "Could not delete this task. Try again.", tasksDeleteConfirm: ({ title }) => `Delete “${title}”? This cannot be undone.`,
    earlierMessages: "Earlier messages omitted", messagesBetweenOmitted: "Messages between this reading point and latest are omitted.", you: "You", saved: "Saved",
    savedMemory: "Saved for this tab only", copyFailed: ({ id }) => `Copy failed. Copy manually: ${id}`,
    copyMessage: "Copy", copiedMessage: "Copied", copyMessageFailed: "Could not copy. Select and copy the message manually.", wrapCode: "Wrap code",
    replyMessage: "Reply", replyingTo: "Replying to", cancelReply: "Cancel reply", replyOpenOriginal: "View original message", replyOriginalUnavailable: "Original message is unavailable.", replyOriginalRecalled: "Original message was recalled.",
    forwardMessage: "Forward", forwardTitle: "Forward message", forwardHint: "Choose where to forward this message.",
    forwardConfirm: ({ target }) => `Forward this message to ${target}?`, forwardNoTargets: "No forward targets are configured for this room.",
    forwardUnavailable: "Forwarding is not available on this server.", forwardLoadFailed: "Could not load forward targets.",
    forwardFailed: ({ message }) => `Forward failed: ${message}`,
    recallMessage: "Recall", recallSystemMessage: "Recall this room notice", recallSystemConfirm: "Recall this room notice? Everyone will see it as recalled.", recallConfirm: "Recall this message? Everyone will see it as recalled.", recallAdminConfirm: ({ name }) => `Recall ${name}'s message? Everyone will see it as recalled.`, recallFailed: "Could not recall this message.", messageRecalled: "Message recalled", recalledBy: ({ name }) => `Recalled by ${name}`, showRecalled: "View original", hideRecalled: "Hide original", revealFailed: "Load failed. Retry",
    identityChanged: "This browser identity changed in another tab. Reload this tab before continuing.",
    networkError: "Network connection failed", requestFailed: ({ status }) => `Request failed (HTTP ${status})`,
    roomIdRequired: "Enter a room ID", nameRequired: "Enter your name", authRetry: "The server requires an access token. Enter it and try again.",
    networkRetry: "Unable to connect to the server. Check your network and try again.",
    joinFailed: ({ message }) => `Could not join: ${message}`, roomNameRequired: "Enter a room name",
    createFailed: ({ message }) => `Could not create the room: ${message}`,
    roomNotFound: "This room is gone, or you no longer have access.",
    sendAuth: "Send failed: an access token is required", sendNetwork: "Send failed. Your message is saved below.",
    sendFailed: ({ message }) => `Send failed: ${message}`,
    adminRoomDeleteDenied: "This room is designated for administration. Only the room owner can delete it.",
    failedMessages: "Messages not sent", retryFailed: "Retry", discardFailed: "Discard",
    roomListError: "Unable to load rooms. You can enter a room ID directly.", guest: "Guest",
    roomsLabel: "Rooms", refreshRooms: "Refresh rooms", identityLabel: ({ name }) => `Chatting as ${name}`,
    roomsMenu: "Open room list", closeRoomList: "Close room list",
    direct: "Direct", messagePrivately: "Message privately", removeMember: "Remove",
    kickConfirm: ({ name }) => `Remove ${name} from this room? They can rejoin with the room ID.`,
    leaveRoomConfirm: ({ name }) => `Leave “${name}”? You will leave this room; you can rejoin later with its ID.`,
    deleteRoom: "Delete room", deleteConfirm: ({ name }) => `Delete “${name}” and all its messages? This cannot be undone.`,
    allMembers: "Everyone", messageCount: ({ count }) => `${count} / 5000`,
    pasteAsFile: ({ count }) => `Pasted ${count} characters saved as a text file`,
    sendAsFile: ({ count }) => `${count} characters exceed the limit; sending as a text file`,
    privacyNote: "Anyone with the shared token can read direct messages and manage rooms; the server can read them too.",
    resourceDelete: "Delete file", resourceDeleting: "Deleting…", resourceDeleteConfirm: ({ name }) => `Delete “${name}”? This cannot be undone.`, resourceDeleted: "File deleted.", resourceDeleteFailed: "Could not delete this file.",
    systemJoined: ({ name }) => `${name} joined the room`, systemLeft: ({ name }) => `${name} left the room`, systemRemoved: ({ name }) => `${name} was removed from the room`,
    systemDesignated: ({ actor, name }) => `${actor} designated ${name} as administrator`, systemRevoked: ({ actor }) => `${actor} revoked the administrator designation`, systemRenamed: ({ actor, from, to }) => `${actor} renamed the room from "${from}" to "${to}"`, systemDescribed: ({ actor }) => `${actor} updated the room description`, systemHanded: ({ actor, name }) => `${actor} handed the room to ${name}`, systemAdminsUpdated: ({ actor }) => `${actor} updated the room administrators`, systemSuccessorNamed: ({ actor, name }) => `${actor} named ${name} as the room successor`, systemSuccessorCleared: ({ actor }) => `${actor} cleared the room successor`, systemJoinPolicy: ({ actor, policy }) => policy === "approval" ? `${actor} now requires approval to join this room` : `${actor} opened this room to join without approval`,
    systemForwarded: ({ target }) => `Forwarded to ${target}`, systemForwardFailed: ({ target, reason }) => `Forward to ${target} failed: ${reason}`,
    activity_working: "Working", activity_idle: "Foreground idle", activity_waiting: "Waiting", activity_unknown: "Status unknown", activity_offline: "Status stale",
    activityHint_working: "The agent reports active work.", activityHint_idle: "Foreground is idle; background work may continue.", activityHint_waiting: "The agent reports that it is waiting.", activityHint_unknown: "No activity report is available.", activityHint_offline: "The last status is stale; this does not prove the agent is offline.",
    receiptCount: ({ count }) => `Read by ${count}`, receiptNone: "No readers yet", receiptNotLoaded: "Read status not loaded", readerPanelTitle: "Message readers", close: "Close", departedMember: "left",
    confirmTitle: "Please confirm", cancel: "Cancel", confirmAction: "Confirm",
    receiptEvidence_displayed: "Shown on screen", receiptEvidence_tool: "Fetched with room tool", receiptEvidence_context: "In agent context",
  },
  "zh-CN": {
    brand: "OC Chat", documentTitle: "OC Chat", roomTitle: ({ name }) => `${name} · OC Chat`,
    tagline: "一个轻量的聊天房间。输入房间 ID 加入，或直接新建一个。", languageLabel: "语言",
    restoringSession: "正在恢复会话…", retry: "重试", roomOptions: "选项",
    roomIdLabel: "房间 ID", roomIdPlaceholder: "粘贴或输入房间 ID", nameLabel: "你的昵称",
    namePlaceholder: "怎么称呼你", joinRoom: "加入房间", or: "或", newRoomNameLabel: "新房间名称",
    newRoomNamePlaceholder: "例如：周末电影夜", createRoom: "创建新房间", tokenOptional: "访问令牌（可选）",
    joinRoomTitle: "加入房间", joinRoomHint: "有人把房间 ID 分享给你？粘贴到这里。",
    createRoomTitle: "创建房间", createRoomHint: "新建一个房间，再把房间 ID 发给别人。",
    requireApproval: "加入需要审核", requireApprovalHint: "新成员需经人类管理员审核；Agent 也可以由管理员 Agent 审核。",
    joinPolicyEditHint: "新成员需经人类管理员审核。关闭后，所有待审核申请都会被清除。", joinPolicyOpenConfirm: "关闭加入审核？所有待审核的加入申请都会被清除。",
    approvalRequired: "需审核加入", joinRequired: "需审核加入", joinPendingStatus: "等待审核",
    joinPendingTitle: "等待审核", joinApprovalPrompt: ({ name }) => `申请加入“${name}”？需要人类管理员审核通过。`, joinPendingBody: ({ name }) => `加入“${name}”的申请已发送，需人类管理员审核通过后才能进入。`,
    joinPendingHint: "可以离开此页面，申请会保留；稍后可在房间列表查看。", joinPendingNotice: ({ name }) => `已发送加入“${name}”的申请，正在等待人类管理员审核。`, joinPendingCancel: "取消申请", joinPendingCancelError: "取消申请失败，请重试。",
    joinPendingGoneTitle: "申请已不在等待", joinPendingGoneBody: "申请可能已被拒绝或清除，可以重新发送。", joinPendingAgain: "重新申请",
    joinPendingError: "无法检查申请状态，请重试。", joinPendingRoomGone: "房间不存在，或你已无权访问。",
    joinNameTaken: "这个昵称已被房间里的成员使用，请换一个。",
    joinRequestsTitle: "加入申请", joinRequestsHint: "Agent 的申请也可以由管理员 Agent 审核。", joinRequestsEmpty: "暂无待审核申请。",
    joinRequestsLoadFailed: "无法加载加入申请。", joinRequestAlreadyHandled: "这个申请已经被处理过了。", joinRequestApprove: "通过", joinRequestDeny: "拒绝", joinRequestAgent: "Agent", joinRequestHuman: "人类",
    joinRequestApproveLabel: ({ name }) => `通过 ${name} 的加入申请`, joinRequestDenyLabel: ({ name }) => `拒绝 ${name} 的加入申请`,
    joinRequestTime: ({ time }) => `申请于 ${time}`, joinRequestApproved: ({ name }) => `已通过 ${name} 的申请。`, joinRequestDenied: ({ name }) => `已拒绝 ${name} 的申请。`,
    joinRequestActionFailed: ({ message }) => `操作失败：${message}`, membersWithRequests: ({ count }) => `成员，${count} 个待审核加入申请`,
    accessKeyTitle: "访问密钥", accessKeyHint: "这个服务器需要访问密钥。密钥保存在当前浏览器里，并随每个请求发送。",
    bearerToken: "Bearer Token", tokenPlaceholder: "服务器要求时填写", save: "保存",
    tokenHint: "若服务器设置了访问令牌（401），所有请求都会带上它。", existingRooms: "房间",
    noRooms: "还没有房间，创建一个吧。", copyRoomId: "复制房间 ID", loadingHistory: "正在加载更早的消息",
    editRoom: "编辑房间", editRoomSections: "编辑房间分区", editRoomDetails: "房间信息", editRoomJoining: "加入与审核", editRoomMembers: "成员与角色", editRoomOwnership: "所有权", roomOwnerOnlyTitle: "仅房主或管理员可修改", roomOwnerOnlyNote: ({ owner }) => `只有房主或房间管理员可以修改这些设置。这个房间属于 ${owner}。`, roomNameLabel: "房间名称", roomDescriptionLabel: "描述", adminAgentLabel: "管理员 Agent", roomOwnerBadge: "房主", roomAdminBadge: "管理员",
    adminIdsLabel: "成员管理员", adminIdsHint: "这些成员可以修改房间信息、管理成员、删除文件并指定接任者。房主始终拥有这些权限。", adminIdsEmpty: "房间里暂无其他成员。", newOwnerLabel: "新房主", newOwnerHint: "可以把房间交给房间里的另一个人。只有房主可以操作；Agent 不能成为房主。",
    successorLabel: "房主离开后的接任者", successorNone: "最早加入的成员", successorHint: "房主离开后，此人接任房主；管理员离开后，此人接任管理员。留空则最早加入的成员接任房主。", ownerOnlySettingsNote: "只有房主可以更改管理员 Agent 或移交房间。", adminAgentHint: "被指定的 Agent 可用 admin 工具查看此房间及其历史。只有房主可以更改，留空表示不指定。",
    noAdminAgent: "不指定", openQuestions: ({ count }) => `${count} 个待回答的问题`,
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
    reminderEdit: "编辑", reminderEditHeading: "编辑提醒", reminderSave: "保存修改",
    reminderCreated: "提醒已创建。", reminderUpdated: "提醒已更新。", reminderDeleted: "提醒已删除。",
    reminderInvalid: "请检查日期、5 字段 CRON 表达式、IANA 时区和提醒内容。", reminderLoadFailed: "无法加载提醒，草稿仍已保留。",
    diagramLoading: "正在渲染图表…", diagramRenderFailed: "图表无法显示，以下为源代码。", resourceLoading: "正在加载文件…", resourceFailed: "无法加载此文件。", resourceDownload: "下载", resourceMoreActions: "{name} 的更多操作", resourcePreview: "预览", resourceHide: "收起预览", docPreviewEyebrow: "Markdown 预览", docPreviewFileEyebrow: "文件预览", docPreviewFailed: "无法加载此文档。", docPreviewEmpty: "此文档为空。", docPreviewTooLarge: "文件太大，无法预览（超过 2 MB），请下载查看。", sidePaneResize: "调整侧边栏宽度", zoomImage: "查看大图", imagePreviewTitle: "图片预览", imageZoomControls: "图片缩放", zoomIn: "放大", zoomOut: "缩小", zoomReset: "重置缩放", openDiagram: "查看图表", diagramViewerTitle: "图表", diagramZoomControls: "图表缩放", diagramFit: "适应窗口", installTitle: "安装 OC Chat", installBody: "添加到主屏幕，获得全屏聊天体验。", installAction: "安装", installHow: "如何安装", installNotNow: "暂不", installIosGuide: "点击共享按钮，然后选择“添加到主屏幕”。",
    pwaUpdateTitle: "有可用更新", pwaUpdateBody: "新版本已准备好。可以立即刷新，或下次打开时再升级。", pwaUpdateNow: "立即升级", pwaUpdateLater: "稍后",
    announcementDelete: "删除公告",
    announcementNew: "新建公告", announcementEmpty: "暂无公告。", announcementLoading: "正在加载公告…",
    announcementLoadFailed: "无法加载公告，草稿仍已保留。", announcementSaved: "公告已保存。", announcementDeleted: "公告已删除。",
    announcementDuplicate: "此名称已存在。请选择该公告进行编辑，或使用其他名称。", announcementDeleteConfirm: ({ name }) => `删除“${name}”？`, announcementCount: ({ count }) => `${count} / 5000`, announcementInvalid: "名称需为 1–64 个字符，内容不能超过 5000 个字符。",
    questionsLoading: "正在加载问题…", questionsEmpty: "没有待回答的问题。",
    questionsFailed: "无法加载问题，请重试。", questionsUnsupported: "此服务器不支持查看待回答问题。", questionLabel: "问题",
    answerQuestion: "回复", answerPlaceholder: "写下回复…", sendAnswer: "发送回复", selectQuestion: "回复此问题", copyQuestion: "复制问题", questionCopied: "问题已复制。", questionCopyFailed: "无法复制问题。",
    answerFailed: "回复失败，草稿仍已保留。", answerTooLong: "回复不能超过 5,000 个字符。", questionAlreadyAnswered: "此问题已由其他人回答。",
    adminBindingGuide: "选择管理员房间和其中的 Agent，再将邀请私下发送给该 Agent 完成设置。", adminRoomLabel: "管理员房间", adminDesignateAgent: "邀请 Agent",
    adminAccess: "管理", adminToken: "管理令牌", openAdministration: "打开管理面板", administration: "管理面板", designations: "管理绑定", adminRoom: "管理员房间", targetRoom: "Agent 所属房间", adminScopeNote: "请选择管理员房间内的 Agent。管理员可以管理所有房间。", adminRoomBadge: "管理", targetAgent: "已注册 Agent", designate: "指定管理员", revokeDesignation: "撤销绑定", globalStatus: "全局状态", adminTasks: "任务", taskText: "任务内容", dispatchTask: "派发任务", timers: "定时任务", planName: "定时任务名称", createTimer: "创建定时任务",
    adminLoading: "正在加载管理面板…", refreshAdmin: "刷新", adminRoomBadge: "管理", chooseAdminRoom: "选择普通房间", chooseTargetRoom: "选择 Agent 房间", chooseAgent: "选择已注册 Agent", taskTargetRoom: "任务目标房间", taskTargetAgent: "任务目标 Agent", createAdminRoomFirst: "请先按普通流程创建房间，再选作管理房间。", noAgents: "没有已注册的 Agent", selectAdminAgent: "请选择管理房间和已注册的 Agent。", adminDesignated: "管理员已立即生效，长期有效，直到撤销。", revokeConfirm: "撤销此管理绑定？普通房间会保留。", updateTask: "更新任务", task_pending: "待处理", task_working: "进行中", task_blocked: "受阻", task_completed: "已完成", task_cancelled: "已取消", nextRun: ({ time, minutes }) => `每 ${minutes} 分钟 · 下次 ${time}`, paused: "已暂停", pauseTimer: "暂停", resumeTimer: "恢复", deleteTimer: "删除", deleteTimerConfirm: ({ name }) => `删除定时任务“${name}”？`,
    tokenRequired: "服务器要求访问令牌（401）。",
    themeLabel: "主题", themeSystem: "跟随系统", themeLight: "浅色", themeDark: "深色", themeForest: "森林", themeSand: "沙丘",
    settingsLocalHint: "语言、主题、过渡和滚动选项保存在当前浏览器中。", settingsSections: "设置分区", settingsGeneral: "通用", settingsAppearance: "外观", settingsConnection: "连接",
    settingsLanguageHint: "立即生效，并保存在当前浏览器中。", settingsThemeHint: "保存在当前浏览器中。跟随系统会使用设备的外观设置。", settingsTokenHint: "仅保存在当前浏览器中，仅在服务器要求时填写。",
    contentTransition: "内容区域过渡", contentTransitionHint: "使用 Alt+方向键切换房间时，让消息内容按方向滑动。默认关闭。", pageStep: "翻页距离", pageStepHint: "每次按 PageUp 或 PageDown 滚动会话高度的百分比。默认 90%。", leave: "离开", reconnecting: "连接中断，正在重试…",
    messageList: "消息列表", noMessages: "还没有消息，说点什么吧。", latestMessages: "回到最新消息",
    mentionMembers: "选择要提及的成员", messagePlaceholder: "输入消息，Enter 发送",
    attachments: "附件", addFiles: "添加文件", dropFilesHere: "将文件拖到这里添加",
    attachmentVolatile: "粘贴的文件刷新后可恢复；文件选择器添加的文件仅在当前标签页有效。", attachmentNotPersisted: "文件过大，无法在刷新后恢复。发送完成前请保持此标签页打开。", retryUpload: "重试", removeFile: "移除",
    uploadQueued: "等待上传", uploadReady: "可以发送", sendAsFileFailed: "上传失败，文字仍在输入框中。", uploadPercent: ({ percent }) => `正在上传 ${percent}%`,
    uploadFailed: ({ reason } = {}) => reason ? `上传失败（${reason}），请重试或移除文件。` : "上传失败，请重试或移除文件。",
    fileUnreadable: "这个文件读不出来：它可能是其他 App 的临时文件，或者还在云端。请先保存到本地（或截图）再发送。",
    fileTooLarge: "文件超过服务器当前大小限制。",
    send: "发送", roomMeta: ({ members, count }) => `${members} 人 · ${count} 条消息`, joinArrow: "加入 →",
    joinDirectTitle: "点击直接加入", mentionEmpty: "没有匹配的成员", mentionHint: "↑↓ 选择 · Enter 确认 · Esc 关闭",

    shortcutsTitle: "键盘快捷键", shortcutsLead: "ChatRoom 快捷键。按 {modifier} + / 打开此列表。",
    shortcutsOpen: "全部快捷键",
    shortcutsWriting: "输入", shortcutsSend: "发送消息", shortcutsNewline: "换行",
    shortcutsMention: "选择要提及的成员", shortcutsRooms: "房间", shortcutsSearch: "搜索与命令", shortcutsOpenPalette: "打开搜索与命令面板",
    shortcutsSwitchRoom: "切换到上一个或下一个房间", shortcutsNumberRoom: "按编号切换到已加入的房间", shortcutsReading: "阅读",
    shortcutsScroll: "输入时滚动消息", shortcutsJump: "跳到会话开头或结尾", shortcutsMenus: "菜单和对话框",
    shortcutsClose: "关闭当前菜单、面板或对话框",
    paletteTitle: "搜索与命令", paletteSearchLabel: "搜索消息",
    palettePlaceholder: "搜索消息，输入 / 使用命令", paletteScopeRoom: "当前房间", paletteScopeAll: "全部房间",
    paletteScopeHint: "按 Tab 在当前房间和全部已加入房间之间切换", paletteSearchMode: "搜索", paletteCommandMode: "命令",
    paletteSearching: "正在搜索…", paletteNoResults: "没有找到消息。", paletteNoCommands: "没有匹配的命令。",
    paletteResults: ({ count }) => `${count} 条结果`, paletteCommandsHint: "常用命令",
    paletteHint: "↑↓ 或 Alt+1–9 选择 · Enter 打开 · Tab 切换范围 · Esc 关闭", paletteSearchFailed: "搜索失败，请重试。",
    paletteLeaveRoom: "离开房间", paletteJumpLatest: "跳到最新消息",
    filesTitle: "文件", filesEyebrow: "房间文件", filesFilter: "上传者", filesEveryone: "所有人",
    filesUnknownUploader: "未知上传者", filesSummary: ({ count, size }) => `${count} 个文件 · ${size}`,
    filesLoading: "正在加载文件…", filesLoadFailed: "无法加载文件，请重试。", filesEmpty: "这个房间还没有文件。",
    filesEmptyFiltered: "此上传者没有文件。", filesLoadMore: "加载更多",
    filesHint: "可预览图片、音频、视频、Markdown、文本、代码和 PDF，所有文件都可下载。",
    filesPreviewFailed: "无法加载预览。", filesDownloadFailed: "无法下载此文件。",
    filesPreviewLabel: ({ name }) => `预览 ${name}`, filesDownloadLabel: ({ name }) => `下载 ${name}`,
    filesDeleteLabel: ({ name }) => `删除 ${name}`, filesRefresh: "刷新文件",
    tasksTitle: "任务", tasksEyebrow: "房间任务", tasksRefresh: "刷新任务", tasksMenuLabel: "任务操作",
    tasksClearCompleted: "清除已完成任务", tasksClearConfirm: ({ count }) => `清除 ${count} 个已完成任务？此操作无法撤销。`,
    tasksClearFailed: "无法清除已完成任务，请重试。",
    tasksLoading: "正在加载任务…", tasksLoadFailed: "无法加载任务，请重试。", tasksEmpty: "还没有任务，添加第一个吧。",
    tasksEmptyFiltered: "此状态下没有任务。", tasksCreate: "添加任务", tasksTitleLabel: "标题",
    tasksTitlePlaceholder: "需要做什么？", tasksDescriptionLabel: "描述", tasksDescriptionPlaceholder: "补充细节、链接或完成标准",
    tasksAssigneeLabel: "负责人", tasksUnassigned: "未指派", tasksFilterLabel: "显示", tasksFilterAll: "全部状态",
    tasksDueDateLabel: "截止日期", tasksDueOn: ({ date }) => `截止 ${date}`, tasksOverdue: "已逾期",
    tasksParticipantsLabel: "参与人员", tasksParticipantsMeta: ({ names }) => `参与人员：${names}`,
    tasksConclusionLabel: "结论", tasksConclusionPlaceholder: "最终结果如何？",
    tasksStepsLabel: "完成步骤", tasksAddStep: "添加步骤", tasksRemoveStep: "删除步骤", tasksStepPlaceholder: "描述一个步骤",
    tasksStepDoneLabel: "步骤已完成", tasksStepsHint: "最多 30 个步骤，勾选已完成的步骤。",
    tasksStepsProgress: ({ done, total }) => `已完成 ${done}/${total} 步`,
    tasksStatusTodo: "待办", tasksStatusDoing: "进行中", tasksStatusDone: "已完成",
    tasksSummary: ({ count }) => `${count} 个任务`, tasksCreator: ({ name }) => `由 ${name} 创建`, tasksUpdated: ({ time }) => `更新于 ${time}`,
    tasksEditLabel: ({ title }) => `编辑 ${title}`, tasksDeleteLabel: ({ title }) => `删除 ${title}`, tasksStatusFor: ({ title }) => `${title} 的状态`,
    tasksInvalid: "标题需为 1–200 个字符。", tasksCreateFailed: "无法添加任务，请重试。", tasksUpdateFailed: "无法更新任务，请重试。",
    tasksDeleteFailed: "无法删除任务，请重试。", tasksDeleteConfirm: ({ title }) => `删除“${title}”？此操作无法撤销。`,
    joined: "已加入", joinAction: "加入房间", unreadMessages: ({ count }) => `${count} 条未读`,
    today: "今天", yesterday: "昨天", earlierMessages: "更早的消息已省略", messagesBetweenOmitted: "此阅读位置与最新消息之间的部分消息已省略。", you: "我", saved: "已保存",
    savedMemory: "仅保存于当前标签页", copyFailed: ({ id }) => `复制失败，请手动复制：${id}`,
    copyMessage: "复制", copiedMessage: "已复制", copyMessageFailed: "复制失败，请手动选择并复制消息。", wrapCode: "自动换行",
    replyMessage: "回复", replyingTo: "回复给", cancelReply: "取消回复", replyOpenOriginal: "查看原始消息", replyOriginalUnavailable: "原始消息不可用。", replyOriginalRecalled: "原消息已撤回。",
    forwardMessage: "转发", forwardTitle: "转发消息", forwardHint: "选择把这条消息转发到哪里。",
    forwardConfirm: ({ target }) => `把这条消息转发到 ${target}？`, forwardNoTargets: "这个房间没有配置转发目标。",
    forwardUnavailable: "此服务器未开启转发功能。", forwardLoadFailed: "无法加载转发目标。",
    forwardFailed: ({ message }) => `转发失败：${message}`,
    recallMessage: "撤回", recallSystemMessage: "撤回这条房间通知", recallSystemConfirm: "撤回这条房间通知？所有人都会看到“消息已撤回”。", recallConfirm: "撤回这条消息？所有人都会看到“消息已撤回”。", recallAdminConfirm: ({ name }) => `撤回 ${name} 的消息？所有人都会看到“消息已撤回”。`, recallFailed: "撤回失败，请重试。", messageRecalled: "消息已撤回", recalledBy: ({ name }) => `${name} 撤回`, showRecalled: "查看原文", hideRecalled: "收起原文", revealFailed: "加载失败，重试",
    identityChanged: "此浏览器身份已在另一个标签页中更改，请重新加载此标签页后继续。",
    networkError: "网络连接失败", requestFailed: ({ status }) => `请求失败（HTTP ${status}）`,
    roomIdRequired: "请输入房间 ID", nameRequired: "请输入你的昵称", authRetry: "服务器要求访问令牌，请填写后重试",
    networkRetry: "无法连接服务器，请检查网络后重试", joinFailed: ({ message }) => `加入失败：${message}`,
    roomNameRequired: "请输入房间名称", createFailed: ({ message }) => `创建失败：${message}`,
    roomNotFound: "房间不存在，或你已被移出房间", sendAuth: "发送失败：需要访问令牌",
    sendNetwork: "发送失败，消息已保存在下方", sendFailed: ({ message }) => `发送失败：${message}`,
    adminRoomDeleteDenied: "此房间已指定管理员。只有房主可以删除此房间。",
    failedMessages: "未发送的消息", retryFailed: "重试", discardFailed: "删除",
    roomListError: "无法加载房间列表，可直接输入房间 ID 加入。", guest: "访客", roomsLabel: "房间列表",
    refreshRooms: "刷新房间", identityLabel: ({ name }) => `当前昵称：${name}`, roomsMenu: "打开房间列表", closeRoomList: "关闭房间列表", direct: "私聊",
    messagePrivately: "私聊", removeMember: "移除", kickConfirm: ({ name }) => `确定将 ${name} 移出此房间？对方仍可用房间 ID 重新加入。`,
    leaveRoomConfirm: ({ name }) => `离开“${name}”？你将离开这个房间，之后可以用房间 ID 重新加入。`,
    deleteRoom: "删除房间", deleteConfirm: ({ name }) => `删除“${name}”及全部聊天记录？此操作无法撤销。`,
    allMembers: "所有人", messageCount: ({ count }) => `${count} / 5000`,
    pasteAsFile: ({ count }) => `已把粘贴的 ${count} 个字符保存为文本文件`,
    sendAsFile: ({ count }) => `${count} 个字符超出上限，将作为文本文件发送`,
    privacyNote: "持有共享令牌的人都可以读取私聊内容和管理房间；服务器也可以读取私聊内容。", resourceDelete: "删除文件", resourceDeleting: "正在删除…", resourceDeleteConfirm: ({ name }) => `确定删除“${name}”？此操作无法撤销。`, resourceDeleted: "文件已删除。", resourceDeleteFailed: "无法删除此文件。",
    systemJoined: ({ name }) => `${name} 加入了房间`, systemLeft: ({ name }) => `${name} 离开了房间`, systemRemoved: ({ name }) => `${name} 被移出了房间`,
    systemDesignated: ({ actor, name }) => `${actor} 指定 ${name} 为管理员`, systemRevoked: ({ actor }) => `${actor} 撤销了管理员指定`, systemRenamed: ({ actor, from, to }) => `${actor} 将房间名称从“${from}”改为“${to}”`, systemDescribed: ({ actor }) => `${actor} 更新了房间描述`, systemHanded: ({ actor, name }) => `${actor} 将房间移交给了 ${name}`, systemAdminsUpdated: ({ actor }) => `${actor} 更新了房间管理员`, systemSuccessorNamed: ({ actor, name }) => `${actor} 指定 ${name} 为房间继任者`, systemSuccessorCleared: ({ actor }) => `${actor} 清除了房间继任者`, systemJoinPolicy: ({ actor, policy }) => policy === "approval" ? `${actor} 开启了加入审核，新成员需要管理员批准` : `${actor} 关闭了加入审核，新成员可以直接加入`,
    systemForwarded: ({ target }) => `已转发到 ${target}`, systemForwardFailed: ({ target, reason }) => `转发到 ${target} 失败：${reason}`,
    activity_working: "工作中", activity_idle: "前台空闲", activity_waiting: "等待中", activity_unknown: "状态未知", activity_offline: "状态已过期",
    activityHint_working: "Agent 正在报告工作状态。", activityHint_idle: "前台空闲；后台任务仍可能继续。", activityHint_waiting: "Agent 正在报告等待状态。", activityHint_unknown: "暂无活动状态报告。", activityHint_offline: "最近的状态已过期；这不能证明 Agent 已离线。",
    receiptCount: ({ count }) => `已读 ${count} 人`, receiptNone: "尚无人已读", receiptNotLoaded: "尚未加载已读状态", readerPanelTitle: "消息已读情况", close: "关闭", departedMember: "已离开",
    confirmTitle: "请确认", cancel: "取消", confirmAction: "确认",
    receiptEvidence_displayed: "已显示在屏幕上", receiptEvidence_tool: "通过房间工具读取", receiptEvidence_context: "进入上下文",
  },
  ...extraLocales,
};

app.t = (key, values = {}) => {
  const entry = messages[app.locale][key] ?? messages.en[key] ?? key;
  const text = typeof entry === "function" ? entry(values) : entry;
  return String(text).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
};
export const { LS, saveToken, api, apiBlob } = createAuth(undefined, undefined, (key, values) => app.t(key, values));
app.LS = LS;
app.api = api;
app.apiBlob = apiBlob;
app.setToken = saveToken;
// The service worker partitions its image cache by this hash; raw credentials never
// leave the page. A missing controller is fine: the identity is posted on controllerchange.
async function postMediaIdentity() {
  try {
    const controller = globalThis.navigator?.serviceWorker?.controller;
    const subtle = globalThis.crypto?.subtle;
    if (!controller || !subtle) return;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`${LS.token}\n${LS.sessionID}`));
    const identity = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    controller.postMessage({ type: "SET_MEDIA_IDENTITY", identity });
  } catch { /* Image caching stays disabled until an identity can be posted. */ }
}
app.postMediaIdentity = postMediaIdentity;
export const SUPPORTED_LOCALES = ["en", "zh-CN", "ja", "ko", "fr", "de", "es", "it"];
const intlLocales = { en: "en-US", "zh-CN": "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES", it: "it-IT" };
app.locale = messages[LS.locale] ? LS.locale : "en";
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
    const text = element._flashKey
      ? app.t(element._flashKey)
      : app.t(element.dataset.i18n, element._i18nValues || {});
    // Controls with icons keep the graphic and swap only the text label.
    const label = element.querySelector(":scope > .i18n-label");
    if (label) label.textContent = text; else element.textContent = text;
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
  app.locale = messages[locale] ? locale : "en";
  LS.locale = app.locale;
  app.applyLocale();
};

app.intlLocale = () => intlLocales[app.locale] || "en-US";
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
app.setOnline = (online) => {
  app.$("#connBar").hidden = online;
  // A recovered connection makes the network send warning stale, but an auth
  // or validation error still needs the user's attention.
  if (online) app.hideSendError("sendNetwork");
};
app.showSendError = (key, values = {}) => {
  const node = app.$("#sendError");
  app.setText(node, key, values);
  node.dataset.errorKey = key;
  node.hidden = false;
};
app.hideSendError = (key) => {
  const node = app.$("#sendError");
  if (key && node.dataset.errorKey !== key) return;
  node.hidden = true;
  delete node.dataset.errorKey;
};
app.showJoinError = (key, values = {}) => {
  app.setText(app.$("#joinError"), key, values);
  app.$("#joinError").hidden = false;
};
app.hideJoinError = () => { app.$("#joinError").hidden = true; };
