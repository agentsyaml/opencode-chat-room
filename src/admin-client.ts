import { loadAdminCapability, saveAdminCapability, type AdminIdentity } from "./admin-credentials";
import type { CenterOpts } from "./center-client";
import type { QueueTransport } from "./queue-transport";
import { z } from "zod";

export type AdminContext = { sessionID: string };
export type AdminArgs = {
  action: "admin_claim" | "admin_overview" | "admin_history";
  roomId?: string; enrollmentKey?: string; targetRoomId?: string;
  limit?: number;
};
export const adminToolSchema = z.object({
  action: z.enum(["admin_claim", "admin_overview", "admin_history"]),
  roomId: z.string().optional(), enrollmentKey: z.string().optional(), targetRoomId: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const adminToolDescription = "Administer an operator-enrolled room: overview and history. This tool never joins a room.";
const safe = (value: string) => encodeURIComponent(value);

async function send(opts: CenterOpts, path: string, method: string, body?: unknown,
  capability?: string, sessionID?: string, ownerID?: string): Promise<Record<string, unknown>> {
  const base = new URL(opts.center);
  const headers: Record<string, string> = { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  if (body !== undefined || method === "DELETE") headers["Content-Type"] = "application/json";
  if (capability) headers["X-Chat-Admin-Capability"] = capability;
  if (sessionID) headers["X-Chat-Agent-Session"] = sessionID;
  if (ownerID !== undefined) headers["X-Chat-Agent-Owner"] = ownerID;
  const target = new URL(`${opts.center.replace(/\/+$/, "")}${path}`);
  if (target.origin !== base.origin) throw new Error("invalid admin request origin");
  const response = await fetch(target, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (new URL(response.url || base.href).origin !== base.origin) throw new Error("admin request origin changed");
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : `center error ${response.status}`), { status: response.status });
  return data;
}

export function protectedAdminRequest(opts: CenterOpts, path: string, method: "GET" | "POST",
  capability: string, sessionID: string, ownerID: string, body?: unknown): Promise<Record<string, unknown>> {
  return send(opts, path, method, body, capability, sessionID, ownerID);
}

export async function adminTool(args: AdminArgs, context: AdminContext, opts: CenterOpts,
  transport: QueueTransport): Promise<string> {
  if (!opts.center) return "error: admin actions require central mode";
  const roomId = args.roomId?.trim();
  if (!roomId) return "error: roomId is required";
  const ownerID = transport.receiverOwnerID;
  if (args.action === "admin_claim") {
    if (!args.enrollmentKey?.trim()) return "error: enrollmentKey is required";
    if (transport.protocol === "v2" && !ownerID) return "error: this runtime has no verified receiver owner identity";
    const identity: AdminIdentity = { center: opts.center, roomId, sessionID: context.sessionID, ownerID: ownerID ?? "" };
    try {
      const result = await send(opts, `/admin/rooms/${safe(roomId)}/claim`, "POST", {
        sessionID: context.sessionID, receiverOwnerID: ownerID ?? "", enrollmentKey: args.enrollmentKey,
      });
      if (typeof result.capability !== "string" || !result.capability) throw new Error("invalid admin claim response");
      await saveAdminCapability(identity, result.capability);
      return "admin room enrolled for this agent session";
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      const detail = typeof status === "number" ? ` (HTTP ${status})` : "";
      return `error: admin claim failed${detail}. If enrollment expired or saving failed, ask the operator to reset enrollment.`;
    }
  }
  if (transport.protocol === "v2" && !ownerID) return "error: this runtime has no verified receiver owner identity";
  const identity: AdminIdentity = { center: opts.center, roomId, sessionID: context.sessionID, ownerID: ownerID ?? "" };
  const capability = await loadAdminCapability(identity);
  if (!capability) return "error: no admin binding for this session; ask the operator to enroll this agent";
  const root = `/admin/rooms/${safe(roomId)}`;
  const request = (route: string, method: string, body?: unknown) =>
    send(opts, `${root}${route}`, method, body, capability, context.sessionID, ownerID ?? "");
  try {
    let result: Record<string, unknown>;
    switch (args.action) {
      case "admin_overview": result = await request("/overview", "GET"); break;
      case "admin_history": {
        if (!args.targetRoomId) return "error: targetRoomId is required";
        const query = new URLSearchParams();
        query.set("targetRoomId", args.targetRoomId);
        query.set("limit", String(Math.min(50, Math.max(1, args.limit ?? 20))));
        result = await request(`/history?${query}`, "GET"); break;
      }
      default: return "error: unsupported admin action";
    }
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "admin request failed";
    return `error: ${capability ? message.replaceAll(capability, "[redacted]") : message}`;
  }
}
