import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hasAdminCapability, isOperator } from "./admin-auth";
import { binding, digest, exec, isAgentMember, many, matchesHash, newSecret, one, queue, tx, validCurrent } from "./admin-state";
import type { Binding } from "./admin-state";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const statuses = ["pending", "working", "blocked", "completed", "cancelled"] as const;
type TaskStatus = typeof statuses[number];
const auth = (request: Request, b: Binding) => isOperator(request) || hasAdminCapability(request, b);
type TaskRow = { id: string; admin_room_id: string; admin_generation: number; target_room_id: string; target_session_id: string; target_owner_id: string; target_membership_id: string; text: string; status: string; progress: string; delivery_token_hash: string; created_at: number; updated_at: number };
type DeliveryRow = { id: string; admissionID: string; adminRoomId: string; generation: number; recipientRoomId: string; membershipID: string; kind: string; text: string; taskId: string | null; taskToken: string | null; createdAt: number };
type TaskView = { id: string; adminRoomId: string; generation: number; targetRoomId: string; targetSessionID: string; text: string; status: string; progress: string; createdAt: number; updatedAt: number };
type AckDelivery = { id: string; admin_room_id: string; generation: number; recipient_room_id: string; session_id: string; owner_id: string; membership_id: string; kind: string };
const revokeTaskDelivery = (db: Database, roomID: string, taskID: string) => {
  exec(db, "DELETE FROM admin_deliveries WHERE admin_room_id=? AND kind='task' AND task_id=? AND acknowledged=0", roomID, taskID);
  // A delivered prompt cannot be recalled; revoke its token so it cannot report progress.
  exec(db, "UPDATE admin_deliveries SET task_token=NULL WHERE admin_room_id=? AND kind='task' AND task_id=?", roomID, taskID);
};

export async function adminTaskRoutes(request: Request, url: URL): Promise<Response | undefined> {
  const base = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/tasks$/);
  const update = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/tasks\/([^/]+)$/);
  if (base && request.method === "GET") return tx(db => {
    const b = binding(db, decodeURIComponent(base[1]!));
    if (!b) return { error: "admin room not found", status: 404 };
    if (!auth(request, b)) return { error: "unauthorized", status: 401 };
    if (!isOperator(request) && !validCurrent(db, b)) return { error: "binding is no longer active", status: 409 };
    return { tasks: many<TaskView>(db, "SELECT id,admin_room_id AS adminRoomId,admin_generation AS generation,target_room_id AS targetRoomId,target_session_id AS targetSessionID,text,status,progress,created_at AS createdAt,updated_at AS updatedAt FROM admin_tasks WHERE admin_room_id=? ORDER BY created_at DESC LIMIT 200", b.room_id) };
  }).then(result => "status" in result ? json({ error: result.error }, result.status) : json(result));
  if (base && request.method === "POST") return createTask(request, decodeURIComponent(base[1]!));
  if (update && request.method === "PATCH") return updateTask(request, decodeURIComponent(update[1]!), decodeURIComponent(update[2]!));
  if (url.pathname === "/supervision/inbox" && request.method === "GET") return inbox(request, url);
  if (url.pathname === "/supervision/ack" && request.method === "POST") return acknowledge(request);
  const progress = url.pathname.match(/^\/supervision\/tasks\/([^/]+)\/progress$/);
  if (progress && request.method === "POST") return reportProgress(request, decodeURIComponent(progress[1]!));
  return undefined;
}

async function createTask(request: Request, roomID: string): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || typeof body.targetRoomId !== "string" || !body.targetRoomId || typeof body.targetSessionID !== "string" || !body.targetSessionID || typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > 2000) return json({ error: "invalid task" }, 400);
  const targetRoomID = body.targetRoomId, targetSessionID = body.targetSessionID, text = body.text.trim();
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!auth(request, b)) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    const recipient = one<{ receiver_owner_id: string | null; membership_id: string }>(db, "SELECT receiver_owner_id,membership_id FROM registry WHERE room_id=? AND session_id=?", targetRoomID, targetSessionID);
    if (!recipient || !isAgentMember(db, targetRoomID, targetSessionID, recipient.receiver_owner_id ?? "", recipient.membership_id)) return { status: 409 as const };
    const id = randomUUID(), now = Date.now(), taskToken = newSecret();
    exec(db, "INSERT INTO admin_tasks(id,admin_room_id,admin_generation,target_room_id,target_session_id,target_owner_id,target_membership_id,text,status,progress,delivery_token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending','',?,?,?)",
      id, roomID, b.generation, targetRoomID, targetSessionID, recipient.receiver_owner_id ?? "", recipient.membership_id, text, digest(taskToken), now, now);
    queue(db, b, "task", text, id, taskToken, { roomID: targetRoomID, sessionID: targetSessionID, ownerID: recipient.receiver_owner_id ?? "", membershipID: recipient.membership_id });
    return { task: { id, adminRoomId: roomID, generation: b.generation, targetRoomId: targetRoomID, targetSessionID, text, status: "pending", progress: "", createdAt: now, updatedAt: now } };
  });
  if ("status" in result) return json({ error: result.status === 404 ? "admin room not found" : result.status === 401 ? "unauthorized" : "active agent target not found" }, result.status);
  return json(result, 201);
}

async function updateTask(request: Request, roomID: string, taskID: string): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || (body.status !== undefined && !statuses.includes(body.status as typeof statuses[number])) ||
    (body.progress !== undefined && (typeof body.progress !== "string" || body.progress.length > 2000))) return json({ error: "invalid task update" }, 400);
  const update = body as { status?: TaskStatus; progress?: string };
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!auth(request, b)) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    const task = one<TaskRow>(db, "SELECT * FROM admin_tasks WHERE id=? AND admin_room_id=?", taskID, roomID);
    if (!task || task.admin_generation !== b.generation) return { status: 404 as const };
    const status = update.status ?? task.status;
    if (task.status === "completed" || task.status === "cancelled") return { status: 409 as const };
    const progress = update.progress === undefined ? task.progress : update.progress.trim();
    const updatedAt = Date.now();
    const terminal = status === "completed" || status === "cancelled";
    exec(db, "UPDATE admin_tasks SET status=?,progress=?,delivery_token_hash=?,updated_at=? WHERE id=? AND admin_generation=?", status, progress, terminal ? "" : task.delivery_token_hash, updatedAt, taskID, b.generation);
    if (terminal) revokeTaskDelivery(db, roomID, taskID);
    return { task: { id: taskID, adminRoomId: roomID, generation: b.generation, targetRoomId: task.target_room_id,
      targetSessionID: task.target_session_id, text: task.text, status, progress, createdAt: task.created_at, updatedAt } };
  });
  if ("status" in result) return json({ error: result.status === 401 ? "unauthorized" : result.status === 404 ? "task not found" : "binding is no longer active" }, result.status);
  return json(result);
}

async function reportProgress(request: Request, taskID: string): Promise<Response> {
  const body: unknown = await request.json();
  const sessionID = request.headers.get("x-chat-agent-session") ?? "";
  const ownerID = request.headers.get("x-chat-agent-owner") ?? "";
  if (!object(body) || typeof body.taskToken !== "string" || typeof body.status !== "string" ||
    !statuses.includes(body.status as TaskStatus) || typeof body.progress !== "string" || body.progress.length > 2000) return json({ error: "invalid task progress" }, 400);
  const update = body as { taskToken: string; status: TaskStatus; progress: string };
  const result = await tx(db => {
    const task = one<TaskRow>(db, "SELECT * FROM admin_tasks WHERE id=?", taskID);
    if (!task) return false;
    const b = binding(db, task.admin_room_id);
    if (!b || task.admin_generation !== b.generation || task.status === "completed" || task.status === "cancelled" || !validCurrent(db, b) ||
      sessionID !== task.target_session_id || ownerID !== task.target_owner_id ||
      !isAgentMember(db, task.target_room_id, task.target_session_id, task.target_owner_id, task.target_membership_id) ||
       !task.delivery_token_hash || !matchesHash(update.taskToken, task.delivery_token_hash)) return null;
    const terminal = update.status === "completed" || update.status === "cancelled";
    exec(db, "UPDATE admin_tasks SET status=?,progress=?,delivery_token_hash=?,updated_at=? WHERE id=? AND admin_generation=?",
      update.status, update.progress.trim(), terminal ? "" : task.delivery_token_hash, Date.now(), taskID, b.generation);
    if (terminal) revokeTaskDelivery(db, b.room_id, taskID);
    return true;
  });
  if (result === null) return json({ error: "task progress credential rejected" }, 401);
  return result ? json({ ok: true }) : json({ error: "task not found" }, 404);
}

async function inbox(request: Request, url: URL): Promise<Response> {
  const sessionID = url.searchParams.get("sessionID") ?? "";
  const ownerID = url.searchParams.get("receiverOwnerID") ?? "";
  const adminRoomID = url.searchParams.get("adminRoomId");
  if (!sessionID || sessionID.length > 128 || ownerID.length > 128) return json({ error: "invalid agent identity" }, 400);
  return adminRoomID ? protectedInbox(request, sessionID, ownerID, adminRoomID) : taskInbox(sessionID, ownerID);
}

function pruneStale(db: Database, sessionID: string, ownerID: string): void {
  db.query(`DELETE FROM admin_deliveries AS d WHERE d.acknowledged=0 AND d.session_id=? AND d.owner_id=? AND (
    NOT EXISTS(SELECT 1 FROM admin_rooms a WHERE a.room_id=d.admin_room_id AND a.generation=d.generation AND EXISTS(
      SELECT 1 FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END
      WHERE g.room_id=a.target_room_id AND g.session_id=a.session_id AND g.membership_id=a.membership_id AND coalesce(g.receiver_owner_id,'')=a.receiver_owner_id AND (g.protocol IN ('v1','v2') OR coalesce(g.host,'')!='')))
    OR NOT EXISTS(SELECT 1 FROM registry g JOIN rooms r ON r.id=g.room_id JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN r.kind='direct' THEN g.session_id ELSE g.name END
      WHERE g.room_id=d.recipient_room_id AND g.session_id=d.session_id AND g.membership_id=d.membership_id AND coalesce(g.receiver_owner_id,'')=d.owner_id AND (g.protocol IN ('v1','v2') OR coalesce(g.host,'')!='')))`)
    .run(sessionID, ownerID);
}

async function taskInbox(sessionID: string, ownerID: string): Promise<Response> {
  const result = await tx(db => {
    pruneStale(db, sessionID, ownerID);
    const deliveries = many<DeliveryRow>(db, `SELECT d.id,d.admission_id AS admissionID,d.admin_room_id AS adminRoomId,d.generation,
      d.recipient_room_id AS recipientRoomId,d.membership_id AS membershipID,d.kind,d.text,d.task_id AS taskId,d.task_token AS taskToken,d.created_at AS createdAt
      FROM admin_deliveries d JOIN admin_tasks t ON t.id=d.task_id AND t.admin_room_id=d.admin_room_id AND t.admin_generation=d.generation
      AND t.target_room_id=d.recipient_room_id AND t.target_session_id=d.session_id AND t.target_owner_id=d.owner_id AND t.target_membership_id=d.membership_id
      WHERE d.session_id=? AND d.owner_id=? AND d.kind='task' AND d.acknowledged=0 ORDER BY d.created_at LIMIT 100`, sessionID, ownerID)
      .map(({ taskToken, recipientRoomId, membershipID, ...delivery }) => ({ ...delivery, targetRoomId: recipientRoomId, ...(taskToken ? { taskToken } : {}) }));
    const supervisionRoomIds = many<{ admin_room_id: string }>(db, `SELECT DISTINCT d.admin_room_id FROM admin_deliveries d JOIN admin_rooms a ON a.room_id=d.admin_room_id
      WHERE d.session_id=a.session_id AND d.owner_id=a.receiver_owner_id AND d.membership_id=a.membership_id AND d.recipient_room_id=a.target_room_id
      AND d.generation=a.generation AND d.session_id=? AND d.owner_id=? AND d.kind='supervision' AND d.acknowledged=0 ORDER BY d.admin_room_id LIMIT 100`, sessionID, ownerID).map(row => row.admin_room_id);
    return { deliveries, supervisionRoomIds };
  });
  return json(result);
}

async function protectedInbox(request: Request, sessionID: string, ownerID: string, roomID: string): Promise<Response> {
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    const operator = isOperator(request);
    if (!operator && (sessionID !== b.session_id || ownerID !== b.receiver_owner_id || !hasAdminCapability(request, b))) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    pruneStale(db, b.session_id, b.receiver_owner_id);
    return { deliveries: many<DeliveryRow>(db, `SELECT id,admission_id AS admissionID,admin_room_id AS adminRoomId,generation,
      recipient_room_id AS recipientRoomId,membership_id AS membershipID,kind,text,task_id AS taskId,task_token AS taskToken,created_at AS createdAt
      FROM admin_deliveries WHERE admin_room_id=? AND generation=? AND recipient_room_id=? AND session_id=? AND owner_id=? AND membership_id=? AND kind='supervision' AND acknowledged=0 ORDER BY created_at LIMIT 100`,
    roomID, b.generation, b.target_room_id, b.session_id, b.receiver_owner_id, b.membership_id).map(({ taskToken, membershipID, recipientRoomId, ...delivery }) => delivery) };
  });
  if ("status" in result) return json({ error: result.status === 401 ? "unauthorized" : result.status === 404 ? "admin room not found" : "binding is no longer active" }, result.status);
  return json(result);
}

async function acknowledge(request: Request): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || typeof body.id !== "string" || typeof body.sessionID !== "string" || typeof body.receiverOwnerID !== "string") return json({ error: "invalid acknowledgement" }, 400);
  const ack = body as { id: string; sessionID: string; receiverOwnerID: string };
  const ok = await tx(db => {
    const delivery = one<AckDelivery>(db, "SELECT * FROM admin_deliveries WHERE id=? AND acknowledged=0", ack.id);
    if (!delivery || delivery.session_id !== ack.sessionID || delivery.owner_id !== ack.receiverOwnerID) return false;
    const b = binding(db, delivery.admin_room_id);
    if (!b || b.generation !== delivery.generation || !validCurrent(db, b) ||
      !isAgentMember(db, delivery.recipient_room_id, delivery.session_id, delivery.owner_id, delivery.membership_id)) return false;
    if (delivery.kind === "supervision" && (delivery.recipient_room_id !== b.target_room_id ||
      delivery.session_id !== b.session_id || delivery.owner_id !== b.receiver_owner_id || delivery.membership_id !== b.membership_id ||
      (!isOperator(request) && !hasAdminCapability(request, b)))) return false;
    if (delivery.kind !== "task" && delivery.kind !== "supervision") return false;
    return exec(db, "UPDATE admin_deliveries SET acknowledged=1 WHERE id=? AND acknowledged=0", ack.id).changes === 1;
  });
  return json({ ok });
}
