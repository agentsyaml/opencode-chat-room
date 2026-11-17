// The administrator is one designated session, never every agent in the room.
export function isAdminAgent(app, sessionID) {
  const admin = app.state.room?.adminSessionID;
  return Boolean(admin) && sessionID === admin;
}

// Browser sessions are people; the backend binds the real membership and re-checks it.
export function isRoomAdmin(app) {
  const room = app.state.room;
  return Boolean(room) && (app.state.myName === room.ownerId || (room.adminIds ?? []).includes(app.state.myName));
}

// Human administrators may remove any non-owner member; the designated agent only ordinary members.
export function canRemoveMember(app, target, selfIsAgent, sessionID) {
  const room = app.state.room;
  if (!room || room.kind === "direct" || !target || target.name === room.ownerId) return false;
  if (!selfIsAgent && isRoomAdmin(app)) return true;
  return isAdminAgent(app, sessionID) && !(room.adminIds ?? []).includes(target.name);
}

export function adminAgentBadge(app) {
  const badge = document.createElement("span");
  badge.className = "admin-agent-badge";
  badge.textContent = app.t("adminAgentLabel");
  badge.title = app.t("adminAgentLabel");
  return badge;
}