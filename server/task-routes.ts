import { clearCompletedTasks, createTask, deleteTask, listTasks, updateTask } from "../src/rooms/tasks.ts";
import { jsonObject } from "./json-body.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MAX_SESSION = 128;

function sessionID(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION ? value : undefined;
}

export async function taskRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const collection = url.pathname.match(/^\/rooms\/([^/]+)\/tasks$/);
  const item = url.pathname.match(/^\/rooms\/([^/]+)\/tasks\/([^/]+)$/);
  if (!collection && !item) return undefined;
  let roomID: string, taskID: string | undefined;
  try {
    roomID = decodeURIComponent((collection ?? item)![1]!);
    taskID = item ? decodeURIComponent(item[2]!) : undefined;
  } catch {
    return json({ error: "invalid path" }, 400);
  }
  if (collection) {
    if (req.method === "GET") {
      const session = sessionID(url.searchParams.get("sessionID"));
      if (!session) return json({ error: "sessionID is required" }, 400);
      const result = await listTasks(roomID, session);
      return "error" in result ? json({ error: result.error }, result.status) : json({ tasks: result.tasks });
    }
    if (req.method !== "POST" && req.method !== "DELETE") return json({ error: "method not allowed" }, 405);
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const session = sessionID(body.sessionID);
    if (!session) return json({ error: "sessionID is required" }, 400);
    if (req.method === "DELETE") {
      const result = await clearCompletedTasks(roomID, session);
      return "error" in result ? json({ error: result.error }, result.status) : json({ ok: true, count: result.count });
    }
    const fields = { title: body.title, description: body.description, assignee: body.assignee, dueDate: body.dueDate, participants: body.participants, conclusion: body.conclusion, steps: body.steps };
    const result = await createTask(roomID, session, fields);
    return "error" in result ? json({ error: result.error }, result.status) : json({ task: result.task }, 201);
  }
  if (req.method !== "PATCH" && req.method !== "DELETE") return json({ error: "method not allowed" }, 405);
  const body = await jsonObject<Record<string, unknown>>(req);
  if (!body) return json({ error: "JSON object body is required" }, 400);
  const session = sessionID(body.sessionID);
  if (!session) return json({ error: "sessionID is required" }, 400);
  if (req.method === "DELETE") {
    const result = await deleteTask(roomID, taskID!, session);
    return "error" in result ? json({ error: result.error }, result.status) : json({ ok: true });
  }
  const result = await updateTask(roomID, taskID!, session, { title: body.title, description: body.description, assignee: body.assignee, status: body.status, dueDate: body.dueDate, participants: body.participants, conclusion: body.conclusion, steps: body.steps });
  return "error" in result ? json({ error: result.error }, result.status) : json({ task: result.task });
}