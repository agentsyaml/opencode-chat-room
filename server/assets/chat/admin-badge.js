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

// One label per member: the owner outranks human administrators, who outrank the
// designated agent. Names are the stable identity shared by rooms and members.
export function memberRole(app, member) {
  const room = app.state.room;
  if (!room || !member || room.kind === "direct") return "";
  if (member.name === room.ownerId) return "owner";
  if ((room.adminIds ?? []).includes(member.name)) return "admin";
  return isAdminAgent(app, member.sessionID) ? "agent" : "";
}

function badge(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  node.title = text;
  return node;
}

export function adminAgentBadge(app) {
  return badge("admin-agent-badge", app.t("adminAgentLabel"));
}

export function memberRoleBadge(app, member) {
  const role = memberRole(app, member);
  if (role === "owner") return badge("admin-badge owner-badge", app.t("roomOwnerBadge"));
  if (role === "admin") return badge("admin-badge", app.t("roomAdminBadge"));
  if (role === "agent") return adminAgentBadge(app);
  return null;
}
