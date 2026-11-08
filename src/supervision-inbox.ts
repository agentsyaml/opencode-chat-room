import { request, type CenterOpts } from "./center-client";
import { sendAsyncNotification, sendQueue, type QueueTransport } from "./queue-transport";
import { loadAdminCapability, saveTaskToken } from "./admin-credentials";
import { protectedAdminRequest } from "./admin-client";

type Delivery = { id: string; admissionID?: string; adminRoomId?: string; kind: "task" | "supervision"; text: string; taskId?: string; taskToken?: string; targetRoomId?: string };
type Inbox = { deliveries?: Delivery[]; supervisionRoomIds?: string[] };

function promptText(item: Delivery, taskToken?: string): string {
  const text = taskToken ? item.text.replaceAll(taskToken, "[redacted]") : item.text;
  if (item.kind === "task") {
    const source = item.targetRoomId ? ` Target room: ${item.targetRoomId}.` : "";
    return `<supervision>Task from admin room ${item.adminRoomId}.${source} Task ID: ${item.taskId}. Report progress using admin(action="task_progress", taskId="${item.taskId}", status="working", progress="...").\nTask: ${text}</supervision>`;
  }
  return `<supervision>Reminder from admin room ${item.adminRoomId}. Use admin(action="admin_overview", roomId="${item.adminRoomId}") to review it.\n${text}</supervision>`;
}

async function push(opts: CenterOpts, sessionID: string, ownerID: string, transport: QueueTransport,
  item: Delivery, capability?: string): Promise<void> {
  const text = promptText(item, capability ?? item.taskToken);
  const admissionID = item.admissionID ?? item.id;
  const result = transport.protocol === "v1" ? await sendAsyncNotification(transport, sessionID, text)
    : await sendQueue(transport, sessionID, text, admissionID, "steer");
  if (result !== "delivered") return;
  const body = { id: item.id, sessionID, receiverOwnerID: ownerID };
  if (capability) await protectedAdminRequest(opts, "/supervision/ack", "POST", capability, sessionID, ownerID, body);
  else await request(opts, "/supervision/ack", "POST", body);
}

export async function checkSupervisionInbox(opts: CenterOpts, sessionID: string, transport: QueueTransport): Promise<void> {
  if (!opts.center || (transport.protocol === "v2" && !transport.receiverOwnerID)) return;
  const ownerID = transport.receiverOwnerID ?? "";
  let inbox: Inbox;
  try {
    const query = new URLSearchParams({ sessionID, receiverOwnerID: ownerID });
    inbox = await request(opts, `/supervision/inbox?${query}`, "GET") as Inbox;
  } catch { return; }
  if (!inbox || typeof inbox !== "object") return;

  for (const item of (Array.isArray(inbox.deliveries) ? inbox.deliveries : []).slice(0, 50)) {
    if (item?.kind !== "task" || !item.id || !item.taskId || !item.taskToken || typeof item.text !== "string") continue;
    try { await saveTaskToken({ center: opts.center, taskId: item.taskId, sessionID, ownerID }, item.taskToken); }
    catch { continue; }
    try { await push(opts, sessionID, ownerID, transport, item); } catch { /* Retry the durable item next sweep. */ }
  }

  const hintedRooms = Array.isArray(inbox.supervisionRoomIds)
    ? [...new Set(inbox.supervisionRoomIds.filter((room): room is string => typeof room === "string" && !!room))].slice(0, 50)
    : [];
  for (const roomId of hintedRooms) {
    const capability = await loadAdminCapability({ center: opts.center, roomId, sessionID, ownerID });
    if (!capability) continue;
    try {
      const query = new URLSearchParams({ sessionID, receiverOwnerID: ownerID, adminRoomId: roomId });
      const result = await protectedAdminRequest(opts, `/supervision/inbox?${query}`, "GET", capability, sessionID, ownerID) as Inbox;
      for (const item of (Array.isArray(result.deliveries) ? result.deliveries : []).slice(0, 50)) {
        if (item?.kind !== "supervision" || item.adminRoomId !== roomId || !item.id || typeof item.text !== "string") continue;
        try { await push(opts, sessionID, ownerID, transport, item, capability); } catch { /* Retry with the same server-issued ID next sweep. */ }
      }
    } catch { /* A room's protected feed does not block other admin rooms or task delivery. */ }
  }
}
