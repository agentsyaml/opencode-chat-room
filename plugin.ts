import { tool } from "@opencode-ai/plugin";
import type { ToolContext as V1ToolContext } from "@opencode-ai/plugin";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import RoomService, { RoomError, type Message } from "./src/room-service";
import {
  formatRoom,
  identity,
  loadRegistry,
  loadRooms,
  NOTIFY_INSTRUCTION,
  writeState,
  readState,
  readUnreadMessages,
  senderName,
  timeOf,
  type Registry,
  type RegistryEntry,
} from "./src/store";
import { centerAction } from "./src/center-client";
import { createQueueTransport, type QueueTransport } from "./src/queue-transport";
import { checkCenterInbox } from "./src/center-inbox";
import { assertDeliveryLease } from "./src/session-delivery";
import { wakeSessions } from "./src/center-wake";
import {
  clearPendingAdmission,
} from "./src/queue";
import { createNotifier } from "./src/plugin-notifications";
import { explicitlyMentions } from "./src/mentions";
import { createV2Setup, type V2Runtime } from "./src/v2-plugin";
import { createV1Server } from "./src/v1-plugin";

// ponytail: CHAT_ROOM_SERVER_URL switches to central mode (all state on a
// central server); unset = standalone local-file mode
const centerUrl = process.env.CHAT_ROOM_SERVER_URL ?? "";
const centerToken = process.env.CHAT_ROOM_SERVER_TOKEN ?? "";
// A configured OpenCode serve URL is required to wake exited sessions.
const serveWakeUrl = process.env.CHAT_ROOM_WAKE_SERVE_URL ?? "";
type PluginRuntime = V2Runtime;

const runtimeContext = new AsyncLocalStorage<PluginRuntime>();
const defaultRuntime: PluginRuntime = {
  selfServerUrl: "",
  selfDirectory: "",
  protocol: "v1",
  transport: createQueueTransport(),
  center: { center: centerUrl, token: centerToken, directory: "" },
};
const currentRuntime = (): PluginRuntime => runtimeContext.getStore() ?? defaultRuntime;

async function withRooms<T>(
  fn: (svc: RoomService, registry: Registry) => T,
  readOnly = false,
): Promise<T> {
  const run = (svc: RoomService, registry: Registry): T => {
    try {
      return fn(svc, registry);
    } catch (err) {
      if (err instanceof RoomError) {
        return `error: ${err.message}` as unknown as T;
      }
      throw err;
    }
  };
  return readOnly ? readState(run) : writeState(run);
}

function registerSelfInState(
  service: RoomService,
  reg: Registry,
  runtime: PluginRuntime,
  roomId: string,
  sessionID: string,
  name = identity(),
  receiverOwnerID?: string,
): void {
      const latestMessageTs = service.listRooms().find((room) => room.id === roomId)?.messages.at(-1)?.createdAt ?? 0;
      const regRoom = (reg[roomId] =
        reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
      regRoom[sessionID] = {
        serverUrl: runtime.selfServerUrl,
        apiPrefix: runtime.protocol === "v1" ? "" : "/api",
        protocol: runtime.protocol,
        ...(receiverOwnerID ? { receiverOwnerID } : regRoom[sessionID]?.receiverOwnerID ? { receiverOwnerID: regRoom[sessionID]!.receiverOwnerID } : {}),
        name,
        directory: runtime.selfDirectory || undefined,
        // ponytail: re-join must not rewind the read watermark (unread
        // messages before the re-join would be silently dropped); a first
        // join starts reading at join time
        lastReadTs:
          regRoom[sessionID]?.lastReadTs ??
          Math.max(Date.now(), latestMessageTs),
        lastQueuedTs: regRoom[sessionID]?.lastQueuedTs,
      };
}

function unregisterSelfInState(reg: Registry, roomId: string, sessionID: string): void {
  if (!reg[roomId]) return;
  delete reg[roomId][sessionID];
  if (!Object.keys(reg[roomId]).length) delete reg[roomId];
}

async function refreshSelf(runtime: PluginRuntime, sessionID: string): Promise<void> {
  await writeState((_svc, registry) => {
    try {
      for (const members of Object.values(registry)) {
        const entry = members[sessionID];
        if (!entry) continue;
        if (runtime.protocol === "v2" && (entry.directory !== runtime.selfDirectory ||
          entry.receiverOwnerID && entry.receiverOwnerID !== runtime.transport.receiverOwnerID)) continue;
        entry.serverUrl = runtime.selfServerUrl;
        entry.apiPrefix = runtime.protocol === "v1" ? "" : "/api";
        entry.protocol = runtime.protocol;
        if (runtime.protocol !== "v2") entry.directory = runtime.selfDirectory || undefined;
      }
    } catch {
      // Existing watermarks and identities remain untouched if refresh fails.
    }
  });
}

// ponytail: push is best-effort; poll remains the fallback; log every attempt for debugging
async function bumpLastRead(
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<boolean> {
  assertDeliveryLease();
  const updated = await writeState((_svc, reg) => {
    try {
      const entry = reg[roomId]?.[sessionID];
      if (entry) {
        // never rewind: an older in-flight push must not lower the watermark
        entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
        return true;
      }
      return false;
    } catch {
      // best-effort: an unpromoted read position only means poll repeats
      return false;
    }
  });
  if (updated) clearPendingAdmission(sessionID, roomId, ts);
  return updated;
}

async function bumpLastQueued(
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<boolean> {
  assertDeliveryLease();
  const updated = await writeState((_svc, reg) => {
    try {
      const entry = reg[roomId]?.[sessionID];
      if (entry) {
        entry.lastQueuedTs = Math.max(entry.lastQueuedTs ?? 0, ts);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });
  if (updated) clearPendingAdmission(sessionID, roomId, ts);
  return updated;
}

const notifier = createNotifier({
  transport: () => currentRuntime().transport,
  bumpQueued: (roomId, sessionID, ts) => bumpLastQueued(roomId, sessionID, ts),
});
const { notifyRoom, notifyTarget } = notifier;
const restoreScans = new Map<string, { afterTs: number; untilTs?: number }>();
const restoreKey = (sid: string, roomID: string, ownerID = "") => JSON.stringify([ownerID, sid, roomID]);

export async function pollKnownSessions(
  sessions: ReadonlySet<string>,
  transport: QueueTransport,
  opts: PluginRuntime["center"],
): Promise<void> {
  if (opts.center) {
    await Promise.all([...sessions].map((sessionID) =>
      checkCenterInbox(opts, sessionID, transport),
    ));
    return;
  }
  const [rooms, registry] = await Promise.all([loadRooms(), loadRegistry()]);
  for (const sessionID of sessions) {
    const mentionOnly = transport.mentionOnlySessions?.has(sessionID) ?? false;
    for (const room of rooms) {
      const entry = registry[room.id]?.[sessionID];
      if (!entry) continue;
      if (transport.protocol === "v2" && entry.receiverOwnerID &&
        (entry.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) continue;
      if (mentionOnly && (entry.protocol !== "v2" || entry.receiverOwnerID !== transport.receiverOwnerID)) continue;
      const cursor = Math.max(entry.lastReadTs ?? 0, entry.lastQueuedTs ?? 0);
      const key = restoreKey(sessionID, room.id, transport.receiverOwnerID);
      let scan = restoreScans.get(key) ?? { afterTs: cursor };
      if (scan.afterTs < cursor) scan = { ...scan, afterTs: cursor };
      if (mentionOnly && (scan.untilTs === undefined || scan.untilTs <= cursor)) {
        scan.untilTs = undefined;
        const tail = await readUnreadMessages(room.id, cursor, 20, sessionID, entry.name, true);
        if (tail.items.some((message) => explicitlyMentions(message, entry.name, sessionID))) {
          scan.untilTs = tail.items.at(-1)!.createdAt;
          scan.afterTs = Math.max(scan.afterTs, scan.untilTs);
        } else {
          const candidates = await readUnreadMessages(room.id, scan.afterTs, 20, sessionID, entry.name);
          if (!candidates.items.length) { restoreScans.set(key, scan); continue; }
          scan.afterTs = candidates.items.at(-1)!.createdAt;
          if (candidates.items.some((message) => explicitlyMentions(message, entry.name, sessionID))) scan.untilTs = scan.afterTs;
          restoreScans.set(key, scan);
          if (scan.untilTs === undefined) continue;
        }
      }
      if (mentionOnly) restoreScans.set(key, scan);
      const page = await readUnreadMessages(room.id, cursor, 20, sessionID, entry.name);
      if (!page.items.length) continue;
      const target = mentionOnly ? { ...transport, mentionOnlySessions: new Set([...transport.mentionOnlySessions!].filter((id) => id !== sessionID)) } : transport;
      await notifyTarget(sessionID, {
        roomId: room.id,
        roomName: room.name,
        messages: page.items,
      }, target);
      if (mentionOnly && scan.untilTs !== undefined) {
        const queued = (await loadRegistry())[room.id]?.[sessionID]?.lastQueuedTs ?? cursor;
        if (queued >= scan.untilTs) restoreScans.delete(key);
      }
    }
  }
}

const READ_ONLY_ACTIONS = new Set(["list", "members", "poll"]);

const roomArgs = z.object({
  action: z.enum(["create", "join", "leave", "list", "send", "poll", "members"]),
  name: z.string().max(64).optional(),
  roomId: z.string().optional(),
  text: z.string().max(2000).optional(),
});
type RoomArguments = z.infer<typeof roomArgs>;

const roomExecute = async (
  args: RoomArguments,
  context: Pick<V1ToolContext, "sessionID">,
) => {
    try {
      const runtime = currentRuntime();
      const explicitV2Join = runtime.protocol === "v2" && (args.action === "create" || args.action === "join");
      const receiverOwnerID = explicitV2Join && runtime.transport.verifySession
        ? await runtime.transport.verifySession(context.sessionID) : undefined;
      if (runtime.center.center) {
        // ponytail: central mode — self-pull inbox first, then act via HTTP
        // (skipped for poll: poll itself pulls the inbox, so racing the
        // fire-and-forget check would read the position it just advanced)
        if (args.action !== "poll") {
          void checkCenterInbox(runtime.center, context.sessionID, runtime.transport);
        }
        return await centerAction(runtime.center, {
          ...args,
          ...(runtime.protocol === "v2" ? { protocol: "v2" as const, receiverOwnerID } : {}),
        }, context.sessionID);
      }
      // ponytail: act as the identity this session registered with on join
      let selfName = identity();
      let joinPrevName: string | undefined;
      let joinPrevShared = false;
      let leaveNameShared = false;
      let pollLastRead = 0;
      let pollEntry = false;
      let pollPage: Awaited<ReturnType<typeof readUnreadMessages>> | undefined;
      let pollMaxTs: number | undefined;
      const notifications: Array<{ roomId: string; roomName: string; messages: Message[] }> = [];
      if (args.action === "poll" && args.roomId) {
        const entry = (await loadRegistry())[args.roomId]?.[context.sessionID];
        pollEntry = entry !== undefined;
        selfName = entry?.name ?? selfName;
        pollLastRead = entry?.lastReadTs ?? 0;
        if (entry) pollPage = await readUnreadMessages(args.roomId, pollLastRead, 100);
      }
      const result = await withRooms<string>(
        (svc, registry) => {
        notifications.length = 0;
        if (args.roomId) {
          const members = registry[args.roomId] ?? {};
          if (args.action === "send" || args.action === "leave" || args.action === "poll") selfName = members[context.sessionID]?.name ?? selfName;
          if (args.action === "join") joinPrevName = members[context.sessionID]?.name;
          if (args.action === "join" && joinPrevName) joinPrevShared = Object.entries(members).some(([sid, entry]) => sid !== context.sessionID && entry.name === joinPrevName);
          if (args.action === "leave") leaveNameShared = Object.entries(members).some(([sid, entry]) => sid !== context.sessionID && entry.name === selfName);
          if (args.action === "poll") pollEntry = members[context.sessionID] !== undefined;
        }
        switch (args.action) {
          case "create": {
            if (!args.name?.trim()) {
              return "error: name is required";
            }
            const created = svc.createRoom(args.name.trim(), identity());
            registerSelfInState(svc, registry, runtime, created.id, context.sessionID, undefined, receiverOwnerID);
            return formatRoom(svc, created);
          }
          case "join": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            const me = identity(args.name?.trim());
            // ponytail: F5 — re-join under a new name retires the old
            // participant, otherwise every rename leaks a ghost member;
            // skipped when another session still holds the old name
            if (
              joinPrevName !== undefined &&
              joinPrevName !== me &&
              !joinPrevShared &&
              svc.containsParticipant(args.roomId, joinPrevName)
            ) {
              svc.leaveRoom(args.roomId, joinPrevName);
            }
            const already = svc.containsParticipant(args.roomId, me);
            svc.joinRoom(args.roomId, { id: me, name: me });
            const room = svc.getRoom(args.roomId);
            registerSelfInState(svc, registry, runtime, args.roomId, context.sessionID, me, receiverOwnerID);
            if (!already) {
              // ponytail: membership events live in the message stream, so
              // the join notification rides the normal unread push
              svc.addEvent(args.roomId, `${me} joined the room`);
              notifications.push({ roomId: args.roomId, roomName: room.name, messages: [...room.messages] });
            }
            return formatRoom(svc, room);
          }
          case "leave": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            // ponytail: ora-2 M2 — mirror the join guard: if another session
            // still holds this name, remove only the registry entry, not the
            // participant (or the sibling window breaks with NOT_JOINED);
            // Do not emit a false leave event while the participant remains.
            if (!leaveNameShared) {
              svc.leaveRoom(args.roomId, selfName);
              const room = svc.getRoom(args.roomId);
              svc.addEvent(args.roomId, `${selfName} left the room`);
              notifications.push({ roomId: args.roomId, roomName: room.name, messages: [...room.messages] });
            }
            unregisterSelfInState(registry, args.roomId, context.sessionID);
            return `left room ${args.roomId}`;
          }
          case "list": {
            const rooms = svc.listRooms();
            if (rooms.length === 0) {
              return "no rooms yet";
            }
            return rooms
              .map(
                (r) =>
                  `${r.id} (${r.name}): ${svc.getParticipants(r.id).length} members`,
              )
              .join("\n");
          }
          case "members": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            const members = svc.getParticipants(args.roomId);
            return members.length > 0
              ? members.map((m) => m.name).join("\n")
              : "no members";
          }
          case "send": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            if (!args.text?.trim()) {
              return "error: text is required";
            }
            const msg = svc.sendMessage(
              args.roomId,
              selfName,
              args.text,
              context.sessionID,
            );
            const room = svc.getRoom(args.roomId);
            notifications.push({ roomId: args.roomId, roomName: room.name, messages: [...room.messages] });
            return `sent: ${args.text}\n${formatRoom(svc, room)}`;
          }
          case "poll": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            // ponytail: gate on registry entry (session granularity) — a
            // participant-id check would pass for any session sharing the
            // same host identity
            if (!pollEntry) {
              return "error: not joined";
            }
            if (!svc.containsParticipant(args.roomId, selfName)) {
              return "error: not joined";
            }
            // ponytail: only messages newer than this session's last read (or
            // last successful push) — queue-notified messages don't repeat
            const messages = pollPage?.items ?? [];
            if (messages.length === 0) {
              return "no new messages";
            }
            pollMaxTs = messages.reduce(
              (mx, m) => Math.max(mx, m.createdAt),
              0,
            );
            return messages
              .map(
                (m) =>
                  `[${timeOf(m.createdAt)}] ${senderName(svc, m)}: ${m.text}`,
              )
              .join("\n") + (pollPage?.hasMore ? "\nMore unread messages remain; poll again." : "");
          }
        }
      }, READ_ONLY_ACTIONS.has(args.action));
      for (const notification of notifications) {
        void notifyRoom(notification.roomId, notification.roomName, NOTIFY_INSTRUCTION,
          context.sessionID, notification.messages).catch(() => {});
      }
      if (args.action === "poll" && pollMaxTs !== undefined && pollMaxTs > 0) {
        await bumpLastRead(args.roomId!, context.sessionID, pollMaxTs);
      }
      return result;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
};

const room = tool({
  description: "Chat room operations: create, join, leave and list rooms; send and poll messages; list members",
  args: roomArgs.shape,
  execute: roomExecute,
});

export const server = createV1Server({
  runtime: (input, transport) => ({
    protocol: "v1",
    selfServerUrl: transport.serverUrl ?? "",
    selfDirectory: input.directory,
    transport,
    center: { center: centerUrl, token: centerToken, directory: input.directory },
  }),
  run: (runtime, callback) => runtimeContext.run(runtime, callback),
  room,
  observe: refreshSelf,
  checkInbox: (runtime, sessionID) => checkCenterInbox(runtime.center, sessionID, runtime.transport),
  wake: (runtime, sessions) => wakeSessions(runtime.center, runtime.transport, serveWakeUrl, sessions),
  central: Boolean(centerUrl),
});

export const setup = createV2Setup({
  runtime: (directory, transport) => ({
    protocol: "v2",
    selfServerUrl: "",
    selfDirectory: directory,
    transport,
    center: { center: centerUrl, token: centerToken, directory },
  }),
  run: (runtime, callback) => runtimeContext.run(runtime, callback),
  execute: (args, sessionID) => roomExecute(args, { sessionID }),
  observe: refreshSelf,
  poll: pollKnownSessions,
});

export const id = "chat-room";
export default { id, server, setup };
