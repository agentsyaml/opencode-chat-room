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

  async function call(route, { method = "GET", body, signal } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const res = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, res.statusText, data);
    return { status: res.status, data };
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
    async send(roomId, sessionID, text) {
      return (await call(`${room(roomId)}/messages`, { method: "POST", body: { sessionID, text } })).data;
    },
    async poll(roomId, sessionID, afterTs, { signal, timeoutMs = 20000 } = {}) {
      const wait = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 20000;
      const after = Number.isFinite(afterTs) && afterTs >= 0 ? afterTs : undefined;
      const params = { sessionID, roomId, excludeSelf: 0, timeout: wait, afterTs: after };
      return (await call(`/inbox?${query(params)}`, { signal })).data;
    },
    async markRead(roomId, sessionID, ts) {
      await call("/read", { method: "POST", body: { roomId, sessionID, ts } });
    },
    async createRoom(name, sessionID, ownerId, joinPolicy = "open") {
      const body = { name, sessionID, ownerId, joinPolicy };
      return (await call("/rooms", { method: "POST", body })).data;
    },
  };
}