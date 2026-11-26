// Central-mode HTTP app: page serving, auth gate and ordered route wiring.
import { RoomError } from "../src/rooms/room-service.ts";
import { adminRoutes } from "./admin-routes.ts";
import { addressingRoutes } from "./addressing-routes.ts";
import type { ChannelController } from "./channels.ts";
import { historyRoute } from "./history-route.ts";
import { joinRequestRoutes } from "./join-requests.ts";
import { memberRoutes } from "./member-routes.ts";
import { messageRecallRoutes } from "./message-recall-routes.ts";
import { roomManagement } from "./newrooms.ts";
import { resourceRoutes } from "./resource-routes.ts";
import { roomReminderRoutes } from "./room-reminders.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { pageRoutes } from "./routes/pages.ts";
import { questionRoutes } from "./routes/questions.ts";
import { roomActionRoutes } from "./routes/room-actions.ts";
import { roomCreateRoute, roomDetailRoutes, roomListRoutes } from "./routes/rooms.ts";

export type AppOptions = {
  here: string;
  token?: string;
  serveWakeUrl: string;
  channeld: () => ChannelController | undefined;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function createApp(options: AppOptions): (req: Request) => Promise<Response> {
  // Database callbacks finish synchronously before any HTTP or long-poll wait.
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const page = await pageRoutes(req, url, options.here, options.channeld()?.enabled ?? false);
    if (page) return page;
    // ponytail: F1 — reject non-JSON POSTs; a text/plain simple request from a
    // malicious page would otherwise mutate rooms cross-origin (no preflight)
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.headers.get("content-type")?.includes("application/json") &&
      !(/^\/rooms\/[^/]+\/resources$/.test(p) && req.method === "POST")
    ) {
      return json({ error: "content-type must be application/json" }, 415);
    }
    if (options.token && req.headers.get("authorization") !== `Bearer ${options.token}`) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      const reminders = await roomReminderRoutes(req, url);
      if (reminders) return reminders;
      const admin = await adminRoutes(req, url); if (admin) return admin;
      const resource = await resourceRoutes(req, url);
      if (resource) return resource;
      const history = await historyRoute(url);
      if (history) return history;
      const addressing = await addressingRoutes(req, url);
      if (addressing) return addressing;
      const recall = await messageRecallRoutes(req, url);
      if (recall) return recall;
      const channel = await options.channeld()?.handle(req, url);
      if (channel) return channel;
      const listed = await roomListRoutes(req, url);
      if (listed) return listed;
      const members = await memberRoutes(req, url);
      if (members) return members;
      const joinRequests = await joinRequestRoutes(req, url);
      if (joinRequests) return joinRequests;
      const management = await roomManagement(req, url);
      if (management) return management;
      const created = await roomCreateRoute(req, url);
      if (created) return created;
      const inbox = await inboxRoutes(req, url);
      if (inbox) return inbox;
      const actions = await roomActionRoutes(req, url, options.serveWakeUrl);
      if (actions) return actions;
      const questions = await questionRoutes(req, url, options.serveWakeUrl);
      if (questions) return questions;
      const detail = await roomDetailRoutes(req, url);
      if (detail) return detail;
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof SyntaxError) return json({ error: "invalid JSON body" }, 400);
      if (err instanceof RoomError) {
        return json(
          { error: err.message },
          err.code === "ROOM_NOT_FOUND" ? 404 : err.code === "NOT_OWNER" ? 403 : 409,
        );
      }
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}