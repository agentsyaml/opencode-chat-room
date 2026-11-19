import { loadAdminCapability, saveAdminCapability, type AdminIdentity } from "./admin-credentials.ts";
import type { CenterOpts } from "../center/center-client.ts";
import { decideJoinRequest, listJoinRequests } from "../center/center-client.ts";
import type { QueueTransport } from "../center/queue-transport.ts";
import { z } from "zod";

export type AdminContext = { sessionID: string };
export type AdminArgs = {
  action: "admin_claim" | "admin_overview" | "admin_history" | "admin_remove_member"
    | "admin_join_requests" | "admin_approve_join" | "admin_deny_join";
  roomId?: string; enrollmentKey?: string; targetRoomId?: string; targetSessionID?: string;
  limit?: number;
};
const ADMIN_ACTIONS = ["admin_claim", "admin_overview", "admin_history", "admin_remove_member",
  "admin_join_requests", "admin_approve_join", "admin_deny_join"] as const;
export const adminToolSchema = z.object({
  action: z.enum(ADMIN_ACTIONS),
  roomId: z.string().optional(), enrollmentKey: z.string().optional(), targetRoomId: z.string().optional(),
  targetSessionID: z.string().optional().describe("Member session to remove for admin_remove_member; requester session ID for admin_approve_join and admin_deny_join."),
  limit: z.number().int().min(1).max(50).optional(),
});
export const adminToolDescription = "Administer an operator-designated room: overview, history, member removal and join-approval review of that room only. Join approval lists only requests visible to this designated management agent; only a human administrator can approve human requests. This tool never joins a room.";
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
  if (!roomId) return "error: roomId is required; use a room UUID from the room list, not the room name";
  const ownerID = transport.receiverOwnerID;
  if (args.action === "admin_claim") {
    if (!args.enrollmentKey?.trim()) return "error: enrollmentKey is required; use the one-time key from the room owner";
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
  // Designation is immediate; a claimed capability is only sent when one exists.
  const capability = (await loadAdminCapability(identity)) ?? "";
  const root = `/admin/rooms/${safe(roomId)}`;
  const agentHeaders = {
    ...(capability ? { "X-Chat-Admin-Capability": capability } : {}),
    "X-Chat-Agent-Session": context.sessionID,
    "X-Chat-Agent-Owner": ownerID ?? "",
  };
  const request = (route: string, method: string, body?: unknown) =>
    send(opts, `${root}${route}`, method, body, capability, context.sessionID, ownerID ?? "");
  try {
    let result: Record<string, unknown>;
    switch (args.action) {
      case "admin_overview": result = await request("/overview", "GET"); break;
      case "admin_history": {
        const query = new URLSearchParams();
        query.set("targetRoomId", args.targetRoomId?.trim() || roomId);
        query.set("limit", String(Math.min(50, Math.max(1, args.limit ?? 20))));
        result = await request(`/history?${query}`, "GET"); break;
      }
      case "admin_remove_member": {
        const targetSessionID = args.targetSessionID?.trim();
        if (!targetSessionID) return "error: targetSessionID is required; use a session ID from the member list";
        result = await send(opts, `/rooms/${safe(roomId)}/kick`, "POST", { sessionID: context.sessionID, targetSessionID }, capability, context.sessionID, ownerID ?? "");
        break;
      }
      case "admin_join_requests": {
        const pending = await listJoinRequests(opts, roomId, context.sessionID, agentHeaders);
        if (!pending.length) return "no pending join requests";
        return pending
          .map((entry) => `${entry.sessionID} (${entry.name}, ${entry.isAgent ? "agent" : "human"}): requested ${new Date(entry.createdAt).toISOString()}`)
          .join("\n");
      }
      case "admin_approve_join":
      case "admin_deny_join": {
        const requestSessionID = args.targetSessionID?.trim();
        if (!requestSessionID) return "error: targetSessionID is required; run admin_join_requests and use its session ID";
        const approve = args.action === "admin_approve_join";
        await decideJoinRequest(opts, roomId, requestSessionID, approve, context.sessionID, agentHeaders);
        return `${approve ? "approved" : "denied"} join request ${requestSessionID}`;
      }
      default: return "error: unsupported admin action";
    }
    return JSON.stringify(result);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const base = error instanceof Error ? error.message : "admin request failed";
    const message = status === 401
      ? "admin capability is missing or expired; run admin_claim with a current enrollmentKey, or ask the room owner to designate this agent again"
      : status === 403
        ? `${base}; this agent is not the designated management agent for this room, or the action exceeds its scope`
        : status === 404
          ? `${base}; verify roomId and targetSessionID, then run admin_join_requests or admin_overview first`
          : base;
    return `error: ${capability ? message.replaceAll(capability, "[redacted]") : message}`;
  }
}
