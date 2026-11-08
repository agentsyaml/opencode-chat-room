import { hasAdminCapability, isOperator } from "./admin-auth";
import type { Database } from "bun:sqlite";
import { binding, exec, many, one, tx, validCurrent } from "./admin-state";
import type { Binding } from "./admin-state";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const auth = (request: Request, b: Binding) => isOperator(request) || hasAdminCapability(request, b);
const planRows = (db: Database, id: string) => many(db,
  "SELECT id,admin_room_id AS adminRoomId,name,interval_seconds AS intervalSeconds,text,paused,next_run_at AS nextRunAt,created_at AS createdAt FROM admin_plans WHERE admin_room_id=? ORDER BY created_at DESC LIMIT 200", id);

export async function adminPlanRoutes(request: Request, url: URL): Promise<Response | undefined> {
  const base = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/plans$/);
  const child = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/plans\/([^/]+)$/);
  if (!base && !child) return undefined;
  const roomID = decodeURIComponent((base ?? child)![1]!);
  if (base && request.method === "GET") return tx(db => {
    const b = binding(db, roomID);
    if (!b) return { error: "admin room not found", status: 404 };
    if (!auth(request, b)) return { error: "unauthorized", status: 401 };
    if (!isOperator(request) && !validCurrent(db, b)) return { error: "binding is no longer active", status: 409 };
    return { plans: planRows(db, roomID) };
  }).then(result => "status" in result ? json({ error: result.error }, result.status) : json(result));
  if (base && request.method === "POST") return createPlan(request, roomID);
  if (child && request.method === "PATCH") return updatePlan(request, roomID, decodeURIComponent(child[2]!));
  if (child && request.method === "DELETE") return deletePlan(request, roomID, decodeURIComponent(child[2]!));
  return json({ error: "method not allowed" }, 405);
}

async function createPlan(request: Request, roomID: string): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 64 ||
    typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > 2000 ||
    !Number.isInteger(body.intervalSeconds) || (body.intervalSeconds as number) < 60 || (body.intervalSeconds as number) > 2_592_000) return json({ error: "invalid plan" }, 400);
  const name = body.name.trim(), text = body.text.trim(), interval = body.intervalSeconds as number;
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!auth(request, b)) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    const id = crypto.randomUUID(), now = Date.now();
    exec(db, "INSERT INTO admin_plans VALUES(?,?,?,?,?,0,?,?)", id, roomID, name, interval, text, now + interval * 1000, now);
    return { plan: { id, adminRoomId: roomID, name, intervalSeconds: interval, text, paused: false, nextRunAt: now + interval * 1000, createdAt: now } };
  });
  if ("status" in result) return json({ error: result.status === 401 ? "unauthorized" : result.status === 404 ? "admin room not found" : "binding is no longer active" }, result.status);
  return json(result, 201);
}

async function updatePlan(request: Request, roomID: string, planID: string): Promise<Response> {
  const body: unknown = await request.json();
  if (!object(body) || typeof body.paused !== "boolean") return json({ error: "paused must be boolean" }, 400);
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return { status: 404 as const };
    if (!auth(request, b)) return { status: 401 as const };
    if (!validCurrent(db, b)) return { status: 409 as const };
    const plan = one<{ id: string; next_run_at: number; interval_seconds: number }>(db,
      "SELECT id,next_run_at,interval_seconds FROM admin_plans WHERE id=? AND admin_room_id=?", planID, roomID);
    if (!plan) return { status: 404 as const };
    const next = body.paused ? plan.next_run_at : Date.now() + plan.interval_seconds * 1000;
    exec(db, "UPDATE admin_plans SET paused=?,next_run_at=? WHERE id=?", body.paused ? 1 : 0, next, planID);
    if (body.paused) exec(db, "DELETE FROM admin_deliveries WHERE admin_room_id=? AND kind='supervision' AND task_id=? AND acknowledged=0", roomID, `plan:${planID}`);
    return { ok: true, nextRunAt: next };
  });
  if ("status" in result) return json({ error: result.status === 401 ? "unauthorized" : result.status === 404 ? "plan not found" : "binding is no longer active" }, result.status);
  return json(result);
}

async function deletePlan(request: Request, roomID: string, planID: string): Promise<Response> {
  const result = await tx(db => {
    const b = binding(db, roomID);
    if (!b) return 404;
    if (!auth(request, b)) return 401;
    if (!validCurrent(db, b)) return 409;
    exec(db, "DELETE FROM admin_deliveries WHERE admin_room_id=? AND kind='supervision' AND task_id=? AND acknowledged=0", roomID, `plan:${planID}`);
    return exec(db, "DELETE FROM admin_plans WHERE id=? AND admin_room_id=?", planID, roomID).changes ? 200 : 404;
  });
  return json(result === 200 ? { ok: true } : { error: result === 401 ? "unauthorized" : result === 409 ? "binding is no longer active" : "plan not found" }, result);
}
