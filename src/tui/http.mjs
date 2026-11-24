// Minimal runtime-neutral HTTP client for the central chat-room server. Uses
// global fetch; requests fail fast on a dead center and honor caller aborts.
const JOIN_PENDING = "Join request submitted. You are not a member yet; a human administrator must approve it.";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const HINTS = {
  401: "unauthorized: check the server token (CHAT_ROOM_SERVER_TOKEN)",
  403: "forbidden: your session is not a room member or lacks permission",
  404: "not found: the room or resource does not exist",
  409: "conflict: you are not a room member, or the name is already in use",
};

function apiError(status, statusText, data) {
  const hint = HINTS[status];
  if (hint) return new ApiError(`${hint} (HTTP ${status})`, status);
  const serverText = typeof data?.error === "string" ? data.error.trim() : "";
  const detail = serverText || statusText || "request failed";
  return new ApiError(`HTTP ${status}: ${detail}`, status);
}

function query(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

export function createApi({ url, token, requestTimeoutMs = 10000 }) {
  const base = String(url ?? "").replace(/\/+$/, "");

  async function call(route, { method = "GET", body, signal, timeoutMs = requestTimeoutMs, headers: extra = {}, parseJson = true } = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) headers["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    // Binary downloads must not be cloned and JSON-parsed; that would duplicate the
    // whole payload in memory before the caller reads it.
    const data = parseJson || !res.ok
      ? await res.clone().json().catch(() => ({}))
      : {};
    if (!res.ok) throw apiError(res.status, res.statusText, data);
    return { status: res.status, data, response: res };
  }

  const room = (roomId) => `/rooms/${encodeURIComponent(roomId)}`;

  return {
    async listRooms(sessionID) {
      return (await call(`/rooms?${query({ sessionID })}`)).data;
    },
    async getRoom(roomId) {
      return (await call(room(roomId))).data;
    },
    async history(roomId, sessionID, beforeSeq, limit = 100) {
      const pageSize = Math.min(200, Math.max(1, Math.floor(limit)));
      const params = { limit: pageSize, excludeSessionID: sessionID, beforeSeq };
      const { data } = await call(`${room(roomId)}/history?${query(params)}`);
      return data;
    },
    async join(roomId, sessionID, name) {
      const { status, data } = await call(`${room(roomId)}/join`, {
        method: "POST",
        body: { sessionID, participantId: name, participantName: name },
      });
      if (status === 202) {
        return { pending: true, message: typeof data.message === "string" ? data.message : JOIN_PENDING };
      }
      return { pending: false, room: data };
    },
    async joinStatus(roomId, sessionID) {
      const { data } = await call(`${room(roomId)}/join-requests/status?${query({ sessionID })}`);
      return data.status === "pending" || data.status === "joined" ? data.status : "none";
    },
    async leave(roomId, sessionID) {
      await call(`${room(roomId)}/leave`, { method: "POST", body: { sessionID } });
    },
    async send(roomId, sessionID, text, { replyToMessageID, isQuestion, clientMessageID } = {}) {
      return (await call(`${room(roomId)}/messages`, {
        method: "POST",
        body: { sessionID, text, ...(replyToMessageID ? { replyToMessageID } : {}), ...(isQuestion ? { isQuestion: true } : {}), ...(clientMessageID ? { clientMessageID } : {}) },
      })).data;
    },
    async poll(roomId, sessionID, afterTs, { signal, timeoutMs = 20000 } = {}) {
      const wait = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 20000;
      const after = Number.isFinite(afterTs) && afterTs >= 0 ? afterTs : undefined;
      const params = { sessionID, roomId, excludeSelf: 0, timeout: wait, afterTs: after };
      // The inbox holds the request for up to `wait`; the normal request timeout
      // must not cut that long poll short and report a false disconnect.
      const longPollTimeout = Math.max(requestTimeoutMs, wait + 5000);
      return (await call(`/inbox?${query(params)}`, { signal, timeoutMs: longPollTimeout })).data;
    },
    async markRead(roomId, sessionID, ts) {
      await call("/read", { method: "POST", body: { roomId, sessionID, ts } });
    },
    async members(roomId) {
      return (await call(`${room(roomId)}/members`)).data.members ?? [];
    },
    async announcements(roomId) {
      return (await call(`${room(roomId)}/announcements`)).data.announcements ?? [];
    },
    async saveAnnouncement(roomId, name, content, sessionID) {
      return (await call(`${room(roomId)}/announcements/${encodeURIComponent(name)}`, {
        method: "PUT", body: { sessionID, content },
      })).data.announcement;
    },
    async deleteAnnouncement(roomId, name, sessionID) {
      await call(`${room(roomId)}/announcements/${encodeURIComponent(name)}`, { method: "DELETE", body: { sessionID } });
    },
    async questions(roomId) {
      return (await call(`${room(roomId)}/questions`)).data.questions ?? [];
    },
    async answerQuestion(roomId, questionId, sessionID, text) {
      return (await call(`${room(roomId)}/questions/${encodeURIComponent(questionId)}/answers`, {
        method: "POST", body: { sessionID, text },
      })).data;
    },
    async reminders(roomId, sessionID) {
      return (await call(`${room(roomId)}/reminders?${query({ sessionID })}`)).data.reminders ?? [];
    },
    async createReminder(roomId, sessionID, text, schedule) {
      return (await call(`${room(roomId)}/reminders`, { method: "POST", body: { sessionID, text, schedule } })).data.reminder;
    },
    async updateReminder(roomId, reminderId, sessionID, patch) {
      return (await call(`${room(roomId)}/reminders/${encodeURIComponent(reminderId)}`, {
        method: "PATCH", body: { sessionID, ...patch },
      })).data.reminder;
    },
    async deleteReminder(roomId, reminderId, sessionID) {
      await call(`${room(roomId)}/reminders/${encodeURIComponent(reminderId)}`, { method: "DELETE", body: { sessionID } });
    },
    async recall(roomId, messageId, sessionID) {
      return (await call(`${room(roomId)}/messages/${encodeURIComponent(messageId)}/recall`, {
        method: "POST", body: { sessionID },
      })).data;
    },
    async reveal(roomId, messageId, sessionID) {
      return (await call(`${room(roomId)}/messages/${encodeURIComponent(messageId)}/content?${query({ sessionID })}`)).data;
    },
    async resources(roomId, sessionID, limit = 500, offset = 0) {
      return (await call(`${room(roomId)}/resources?${query({ limit, offset })}`, {
        headers: { "x-session-id": sessionID },
      })).data;
    },
    async resourceContent(roomId, resourceId) {
      const { response } = await call(`${room(roomId)}/resources/${encodeURIComponent(resourceId)}/content`, {
        parseJson: false,
      });
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
    },
    async deleteResource(roomId, resourceId, sessionID) {
      const { data } = await call(`${room(roomId)}/resources/${encodeURIComponent(resourceId)}`, {
        method: "DELETE",
        body: {},
        headers: { "x-session-id": sessionID },
      });
      return data;
    },
    async joinRequests(roomId, sessionID) {
      const { status, data } = await call(`${room(roomId)}/join-requests?${query({ sessionID })}`);
      return { status, requests: Array.isArray(data) ? data : [] };
    },
    async decideJoin(roomId, requestSessionID, sessionID, decision) {
      const { data } = await call(`${room(roomId)}/join-requests/${encodeURIComponent(requestSessionID)}/${decision}`, {
        method: "POST",
        body: { sessionID },
      });
      return data;
    },
    async uploadResource(roomId, sessionID, filename, bytes) {
      const { data } = await call(`${room(roomId)}/resources`, {
        method: "POST",
        body: bytes,
        headers: { "x-session-id": sessionID, "x-file-name": encodeURIComponent(filename), "Content-Type": "application/octet-stream" },
      });
      return data.resource;
    },
    async createRoom(name, sessionID, ownerId, joinPolicy = "open") {
      const body = { name, sessionID, ownerId, joinPolicy };
      return (await call("/rooms", { method: "POST", body })).data;
    },
    async updateRoom(roomId, sessionID, patch) {
      const body = { sessionID, ...patch };
      return (await call(`${room(roomId)}`, { method: "PATCH", body })).data;
    },
    async deleteRoom(roomId, sessionID) {
      return (await call(`${room(roomId)}`, { method: "DELETE", body: { sessionID } })).data;
    },
  };
}