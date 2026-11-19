import { LS } from "./state.js";
import { isRoomAdmin } from "./admin-badge.js";

// Pending join state is browser-local; the server remains authoritative.
export function initJoinRequests(app) {
  const $ = app.$;
  const pendingIds = (app.state.pendingJoinIds ??= new Set());
  let pending = { roomId: "", name: "", status: "", timer: 0, generation: 0, checking: false, cancelling: false };
  let requests = [], requestsRoomId = "", requestsGeneration = 0, requestsLoading = false, deniedRoomId = "";
  let requestSignature = "";

  const panel = $("#memberPanel"), section = $("#joinRequests"), list = $("#joinRequestList");
  const card = $("#joinPending"), title = $("#joinPendingTitle"), body = $("#joinPendingBody"), hint = $("#joinPendingHint");
  const notice = $("#joinNotice"), noticeText = $("#joinNoticeText");
  const roomNameFor = (roomId) => app.state.availableRooms?.find((item) => item.id === roomId)?.name
    || app.state.rooms.get(roomId)?.room.name || roomId;
  const approveText = (request) => app.t("joinRequestApproveLabel", { name: request.name });
  const denyText = (request) => app.t("joinRequestDenyLabel", { name: request.name });

  app.showJoinPending = (roomId, name) => {
    clearTimeout(pending.timer);
    pending = { roomId, name, status: "pending", timer: 0, generation: pending.generation + 1, checking: false, cancelling: false };
    pendingIds.add(roomId);
    const roomName = roomNameFor(roomId);
    app.setText(title, "joinPendingTitle");
    app.setText(body, "joinPendingBody", { name: roomName });
    app.setText(hint, "joinPendingHint");
    app.setText(noticeText, "joinPendingNotice", { name: roomName });
    notice.hidden = $("#chatView").hidden;
    hint.hidden = false;
    card.hidden = false;
    $("#joinError").hidden = true;
    renderPendingActions();
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
    scheduleCheck();
    if ($("#joinView").hidden) return;
    title.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest" });
  };

  function renderPendingActions() {
    const waiting = pending.status === "pending";
    const gone = pending.status === "gone";
    $("#btnJoinPendingStop").hidden = !waiting;
    $("#btnJoinPendingAgain").hidden = waiting || gone;
    $("#btnJoinNoticeStop").hidden = !waiting;
    $("#btnJoinNoticeAgain").hidden = waiting || gone;
    $("#btnJoinPendingStop").disabled = Boolean(pending.cancelling);
    $("#btnJoinNoticeStop").disabled = Boolean(pending.cancelling);
  }

  function closePending(keepWaiting = false) {
    clearTimeout(pending.timer);
    pending.timer = 0;
    pending.cancelling = false;
    pending.generation++;
    card.hidden = true;
    notice.hidden = true;
    if (!keepWaiting) {
      pending.roomId = "";
      pending.name = "";
      pending.status = "";
    }
  }

  function scheduleCheck(delay = 4000) {
    clearTimeout(pending.timer);
    if (!pending.roomId || pending.status !== "pending") return;
    pending.timer = setTimeout(() => void checkPending(), delay);
  }

  async function checkPending() {
    if (pending.checking || !pending.roomId || pending.status !== "pending") return;
    if (document.hidden) { scheduleCheck(); return; }
    const generation = pending.generation, roomId = pending.roomId;
    pending.checking = true;
    try {
      const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/join-requests/status?sessionID=${encodeURIComponent(LS.sessionID)}`);
      if (generation !== pending.generation) return;
      if (result.status === "joined") {
        const name = pending.name || LS.name;
        pendingIds.delete(roomId);
        closePending();
        void app.joinRoom(roomId, name);
        return;
      }
      if (result.status === "pending") {
        app.setText(hint, "joinPendingHint");
        hint.hidden = false;
        scheduleCheck();
        return;
      }
      pendingIds.delete(roomId);
      pending.status = "none";
      app.setText(title, "joinPendingGoneTitle");
      app.setText(body, "joinPendingGoneBody");
      app.setText(noticeText, "joinPendingGoneBody");
      notice.hidden = $("#chatView").hidden;
      hint.hidden = true;
      renderPendingActions();
      renderRoomLists();
      rethrowFocus($("#joinView").hidden ? $("#btnJoinNoticeAgain") : $("#btnJoinPendingAgain"));
    } catch (error) {
      if (generation !== pending.generation) return;
      if (error.status === 404) {
        pendingIds.delete(roomId);
        pending.status = "gone";
        app.setText(title, "joinPendingGoneTitle");
        app.setText(body, "joinPendingRoomGone");
        app.setText(noticeText, "joinPendingRoomGone");
        notice.hidden = $("#chatView").hidden;
        hint.hidden = true;
        renderPendingActions();
        renderRoomLists();
      } else {
        app.setText(hint, "joinPendingError");
        hint.hidden = false;
        scheduleCheck(8000);
      }
    } finally {
      pending.checking = false;
    }
  }

  function rethrowFocus(element) {
    if (!element || element.hidden) return;
    element.focus({ preventScroll: true });
  }

  function renderPendingCopy() {
    if (!pending.roomId) return;
    const roomName = roomNameFor(pending.roomId);
    if (pending.status === "pending") {
      app.setText(title, "joinPendingTitle");
      app.setText(body, "joinPendingBody", { name: roomName });
      app.setText(hint, "joinPendingHint");
      app.setText(noticeText, "joinPendingNotice", { name: roomName });
      notice.hidden = $("#chatView").hidden;
      hint.hidden = false;
    } else if (pending.status === "none") {
      app.setText(title, "joinPendingGoneTitle");
      app.setText(body, "joinPendingGoneBody");
      app.setText(noticeText, "joinPendingGoneBody");
      notice.hidden = $("#chatView").hidden;
      hint.hidden = true;
    } else if (pending.status === "gone") {
      app.setText(title, "joinPendingGoneTitle");
      app.setText(body, "joinPendingRoomGone");
      app.setText(noticeText, "joinPendingRoomGone");
      notice.hidden = $("#chatView").hidden;
      hint.hidden = true;
    }
    renderPendingActions();
  }

  app.refreshJoinRequests = () => void refreshRequests();
  app.clearJoinRequests = () => {
    deniedRoomId = ""; requestsGeneration++; requests = []; requestsRoomId = ""; requestSignature = "";
    renderRequests();
  };

  async function refreshRequests() {
    const room = app.state.room;
    if (deniedRoomId && deniedRoomId !== room?.id) deniedRoomId = "";
    if (!room || room.kind === "direct" || room.joinPolicy !== "approval" || !isRoomAdmin(app) || deniedRoomId === room.id) {
      requestsGeneration++;
      requests = []; requestsRoomId = ""; requestSignature = "";
      renderRequests();
      return;
    }
    if (requestsLoading) return;
    const generation = ++requestsGeneration, roomId = room.id;
    requestsLoading = true;
    try {
      const data = await app.api(`/rooms/${encodeURIComponent(roomId)}/join-requests?sessionID=${encodeURIComponent(LS.sessionID)}`);
      if (generation !== requestsGeneration || app.state.room?.id !== roomId) return;
      requestsRoomId = roomId;
      requests = Array.isArray(data.requests)
        ? data.requests.filter((request) => request && typeof request.sessionID === "string" && request.sessionID && typeof request.name === "string")
        : [];
      renderRequests();
    } catch (error) {
      if (generation !== requestsGeneration || app.state.room?.id !== roomId) return;
      if (error.status === 403) { deniedRoomId = roomId; requests = []; renderRequests(); }
      else $("#joinRequestsStatus").textContent = app.t("joinRequestsLoadFailed");
    } finally {
      requestsLoading = false;
    }
  }

  function renderRequests() {
    const room = app.state.room;
    const visible = Boolean(room && room.kind !== "direct" && room.joinPolicy === "approval" && isRoomAdmin(app) && deniedRoomId !== room.id);
    section.hidden = !visible;
    if (!visible) {
      list.textContent = ""; requestSignature = "";
      updateBadge(0);
      return;
    }
    if (requestsRoomId && requestsRoomId !== room.id) {
      requests = []; requestsRoomId = room.id; requestSignature = "";
    }
    const count = requests.length;
    $("#joinRequestsHint").hidden = !room.adminSessionID;
    $("#joinRequestsEmpty").hidden = count > 0;
    const countNode = $("#joinRequestsCount");
    countNode.textContent = count > 99 ? "99+" : String(count);
    countNode.hidden = !count;
    const signature = `${room.id}\0${app.locale}\0${requests.map((item) => `${item.sessionID}\0${item.name}\0${item.isAgent}\0${item.createdAt}`).join("\u0001")}`;
    if (signature === requestSignature) { updateBadge(count); return; }
    const active = list.contains(document.activeElement)
      ? { id: document.activeElement.closest("[data-request-session]")?.dataset.requestSession, action: document.activeElement.dataset.requestAction }
      : undefined;
    requestSignature = signature;
    list.textContent = "";
    for (const request of requests) list.append(requestRow(request));
    if (active) {
      const row = list.querySelector(`[data-request-session="${CSS.escape(active.id || "")}"]`);
      const target = row?.querySelector(`[data-request-action="${active.action || ""}"]`);
      target?.focus({ preventScroll: true });
    }
    updateBadge(count);
  }

  function requestRow(request) {
    const item = document.createElement("li"), info = document.createElement("div"), name = document.createElement("span");
    const meta = document.createElement("span"), kind = document.createElement("span"), actions = document.createElement("div");
    item.className = "join-request-item"; item.dataset.requestSession = request.sessionID;
    info.className = "join-request-info";
    name.className = "join-request-name"; name.textContent = request.name;
    meta.className = "join-request-meta";
    const time = Number(request.createdAt);
    meta.textContent = app.t("joinRequestTime", { time: app.fmtTime(Number.isFinite(time) && time > 0 ? time : Date.now()) });
    kind.className = `join-request-kind${request.isAgent ? " agent" : ""}`;
    kind.textContent = request.isAgent ? app.t("joinRequestAgent") : app.t("joinRequestHuman");
    info.append(name, kind, meta);
    actions.className = "join-request-actions";
    const approve = actionButton("approve", app.t("joinRequestApprove"), approveText(request));
    const deny = actionButton("deny", app.t("joinRequestDeny"), denyText(request));
    approve.className = "btn primary small"; deny.className = "btn ghost small danger-text";
    approve.addEventListener("click", () => void decide(request, "approve", item, approve, deny));
    deny.addEventListener("click", () => void decide(request, "deny", item, approve, deny));
    actions.append(approve, deny); item.append(info, actions);
    return item;
  }

  function actionButton(action, label, ariaLabel) {
    const button = document.createElement("button");
    button.type = "button"; button.dataset.requestAction = action;
    button.textContent = label; button.setAttribute("aria-label", ariaLabel);
    return button;
  }

  async function decide(request, action, item, approve, deny) {
    const room = app.state.room;
    if (!room) return;
    const index = requests.findIndex((entry) => entry.sessionID === request.sessionID);
    item.setAttribute("aria-busy", "true"); approve.disabled = true; deny.disabled = true;
    try {
      await app.api(`/rooms/${encodeURIComponent(room.id)}/join-requests/${encodeURIComponent(request.sessionID)}/${action}`, {
        method: "POST", body: JSON.stringify({ sessionID: LS.sessionID }),
      });
      requests = requests.filter((entry) => entry.sessionID !== request.sessionID);
      requestSignature = "";
      app.setText($("#joinRequestsStatus"), action === "approve" ? "joinRequestApproved" : "joinRequestDenied", { name: request.name });
      renderRequests();
      focusAfterRequest(index);
      if (action === "approve") void app.refreshRoomMeta?.();
    } catch (error) {
      if (error.status === 404) {
        requests = requests.filter((entry) => entry.sessionID !== request.sessionID);
        requestSignature = "";
        app.setText($("#joinRequestsStatus"), "joinRequestAlreadyHandled");
        renderRequests();
        focusAfterRequest(index);
      } else if (error.status === 403) {
        deniedRoomId = room.id; requests = []; renderRequests();
      } else {
        item.removeAttribute("aria-busy"); approve.disabled = false; deny.disabled = false;
        app.setText($("#joinRequestsStatus"), "joinRequestActionFailed", { message: error.message });
        if (error.status === 409) void refreshRequests();
      }
    }
  }

  function focusAfterRequest(index) {
    const rows = [...list.querySelectorAll(".join-request-item")];
    const row = rows[Math.min(index, rows.length - 1)];
    const target = row?.querySelector('[data-request-action="approve"]') || $("#joinRequestsTitle");
    target?.focus({ preventScroll: true });
  }

  function updateBadge(count) {
    const badge = $("#joinRequestBadge"), button = $("#btnMembers");
    $("#joinRequestBadgeCount").textContent = count > 99 ? "99+" : String(count);
    badge.title = count ? app.t("membersWithRequests", { count }) : "";
    badge.hidden = !count;
    button.setAttribute("aria-label", count ? app.t("membersWithRequests", { count }) : app.t("members"));
  }

  function renderRoomLists() {
    app.renderRoomOptions($("#roomList"), app.state.availableRooms || []);
    app.renderRoomOptions($("#roomListChat"), app.state.availableRooms || []);
  }

  async function cancelPending() {
    if (!pending.roomId || pending.status !== "pending" || pending.cancelling) return;
    const generation = pending.generation, roomId = pending.roomId;
    pending.cancelling = true;
    renderPendingActions();
    try {
      await app.api(`/rooms/${encodeURIComponent(roomId)}/join-requests?sessionID=${encodeURIComponent(LS.sessionID)}`, { method: "DELETE", body: "{}" });
      if (generation !== pending.generation) return;
      pendingIds.delete(roomId);
      closePending();
      ($("#joinView").hidden ? $("#msgInput") : $("#inRoomId"))?.focus({ preventScroll: true });
    } catch (error) {
      if (generation !== pending.generation) return;
      if (error.status === 404) {
        pendingIds.delete(roomId);
        closePending();
        ($("#joinView").hidden ? $("#msgInput") : $("#inRoomId"))?.focus({ preventScroll: true });
        return;
      }
      app.setText(hint, "joinPendingCancelError");
      hint.hidden = false;
      app.setText(noticeText, "joinPendingCancelError");
      notice.hidden = $("#chatView").hidden;
    } finally {
      if (generation === pending.generation) {
        pending.cancelling = false;
        renderPendingActions();
      }
    }
  }

  function requestAgain() {
    if (pending.roomId) void app.joinRoom(pending.roomId, pending.name || LS.name);
  }

  $("#btnJoinPendingStop").addEventListener("click", () => void cancelPending());
  $("#btnJoinNoticeStop").addEventListener("click", () => void cancelPending());
  $("#btnJoinPendingAgain").addEventListener("click", requestAgain);
  $("#btnJoinNoticeAgain").addEventListener("click", requestAgain);
  $("#btnMembers").addEventListener("click", () => {
    setTimeout(() => { if (!$("#memberPanel").hidden) void refreshRequests(); }, 0);
  });
  document.addEventListener("chat-room-activated", (event) => {
    const roomId = event.detail;
    if (pending.roomId === roomId) {
      pendingIds.delete(roomId);
      closePending();
    }
    deniedRoomId = ""; requests = []; requestsRoomId = roomId || ""; requestSignature = "";
    renderRequests();
    void refreshRequests();
    renderRoomLists();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (pending.roomId && pending.status === "pending" && !pending.timer) scheduleCheck(0);
    if (!panel.hidden) void refreshRequests();
  });

  // Locale changes must relabel rows and the open request card without another round trip.
  const applyLocale = app.applyLocale;
  app.applyLocale = () => {
    applyLocale();
    renderPendingCopy();
    renderRequests();
  };

  renderRequests();
}