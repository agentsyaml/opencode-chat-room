import { randomUUID } from "node:crypto";

export type TaskStep = { text: string; done: boolean };
export type TaskRecord = {
  id: string; roomId: string; title: string; description: string; assignee: string | null;
  status: "todo" | "doing" | "done"; creatorName: string; creatorSessionID: string;
  dueDate: string; participants: string[]; conclusion: string; steps: TaskStep[];
  createdAt: number; updatedAt: number;
};
export type TaskApi = { tasks: TaskRecord[]; names: Map<string, string>; admins: Set<string>; clock: number; clearUrls: string[] };

export async function installTaskRoutes(page: any, api: TaskApi) {
  const readSteps = (value: unknown): TaskStep[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 30) return null;
    const steps: TaskStep[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") return null;
      const text = String((entry as TaskStep).text ?? "").trim();
      if (!text || text.length > 300) return null;
      steps.push({ text, done: (entry as TaskStep).done === true });
    }
    return steps;
  };
  const readParticipants = (value: unknown): string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return null;
    const current = new Set(api.names.values());
    const names = [...new Set(value as string[])];
    return names.every((name) => current.has(name)) ? names : null;
  };
  await page.route(/\/rooms\/[^/]+\/tasks(?:\/[^/]+)?(?:\?.*)?$/, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(request.postData() || "{}"); } catch { body = {}; }
    const reply = (status: number, payload: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    const match = /^\/rooms\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return reply(404, { error: "Not found" });
    const roomId = decodeURIComponent(match[1]!), taskId = match[2] ? decodeURIComponent(match[2]) : "";
    const sessionID = method === "GET" ? url.searchParams.get("sessionID") || "" : String(body.sessionID || "");
    const callerName = api.names.get(sessionID) || "";
    if (method === "GET" && !taskId) {
      return reply(200, { tasks: api.tasks.filter((task) => task.roomId === roomId) });
    }
    if (method === "POST" && !taskId) {
      if (!callerName) return reply(403, { error: "Not a room member" });
      const title = String(body.title ?? "").trim();
      if (!title) return reply(400, { error: "Title required" });
      const dueDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : "";
      const participants = readParticipants(body.participants);
      const steps = readSteps(body.steps);
      if (!participants || !steps) return reply(400, { error: "Invalid task fields" });
      const stamp = ++api.clock;
      const task: TaskRecord = {
        id: randomUUID(), roomId: roomId, title, description: String(body.description ?? ""),
        assignee: body.assignee ? String(body.assignee) : null, status: "todo",
        creatorName: callerName, creatorSessionID: sessionID, createdAt: stamp, updatedAt: stamp,
        dueDate, participants, conclusion: String(body.conclusion ?? ""), steps,
      };
      api.tasks.push(task);
      return reply(201, { task });
    }
    if (method === "DELETE" && !taskId) {
      if (!callerName) return reply(403, { error: "Not a room member" });
      api.clearUrls.push(url.pathname);
      const admin = api.admins.has(sessionID);
      const before = api.tasks.length;
      api.tasks = api.tasks.filter((item) => !(item.roomId === roomId && item.status === "done"
        && (admin || item.creatorSessionID === sessionID)));
      return reply(200, { ok: true, count: before - api.tasks.length });
    }
    const task = api.tasks.find((item) => item.id === taskId && item.roomId === roomId);
    if (!task) return reply(404, { error: "Task not found" });
    const admin = api.admins.has(sessionID);
    const creator = task.creatorSessionID === sessionID;
    if (method === "PATCH") {
      const fields = Object.keys(body).filter((key) => key !== "sessionID");
      const assignee = Boolean(task.assignee) && task.assignee === callerName;
      const statusOnly = fields.length === 1 && fields[0] === "status";
      const stepsOnly = fields.length === 1 && fields[0] === "steps";
      if (!admin && !creator && !(assignee && (statusOnly || stepsOnly))) {
        return reply(403, { error: "Not allowed" });
      }
      const nextSteps = body.steps === undefined ? null : readSteps(body.steps);
      const nextParticipants = body.participants === undefined ? null : readParticipants(body.participants);
      if ((body.steps !== undefined && !nextSteps) || (body.participants !== undefined && !nextParticipants)) {
        return reply(400, { error: "Invalid task fields" });
      }
      if (assignee && !admin && !creator && stepsOnly) {
        const before = task.steps;
        const sameText = Boolean(nextSteps) && nextSteps!.length === before.length
          && nextSteps!.every((step, index) => step.text === before[index]!.text);
        if (!sameText) return reply(403, { error: "Assignee may only toggle steps" });
      }
      if (body.status !== undefined) {
        const status = String(body.status);
        if (!["todo", "doing", "done"].includes(status)) return reply(400, { error: "Invalid status" });
        task.status = status as TaskRecord["status"];
      }
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (!title) return reply(400, { error: "Title required" });
        task.title = title;
      }
      if (body.description !== undefined) task.description = String(body.description ?? "");
      if (body.assignee !== undefined) task.assignee = body.assignee ? String(body.assignee) : null;
      if (body.dueDate !== undefined) {
        task.dueDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : "";
      }
      if (nextParticipants) task.participants = nextParticipants;
      if (body.conclusion !== undefined) task.conclusion = String(body.conclusion ?? "");
      if (nextSteps) task.steps = nextSteps;
      task.updatedAt = ++api.clock;
      return reply(200, { task });
    }
    if (method === "DELETE") {
      if (!admin && !creator) return reply(403, { error: "Not allowed" });
      api.tasks = api.tasks.filter((item) => item !== task);
      return reply(200, { ok: true });
    }
    return reply(405, { error: "Method not allowed" });
  });
}