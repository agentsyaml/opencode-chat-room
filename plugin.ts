import { tool } from "@opencode-ai/plugin";
import type { ToolContext as V1ToolContext } from "@opencode-ai/plugin";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import RoomService, { RoomError, type Message } from "./src/room-service";
import {
  enqueue,
  formatRoom,
  identity,
  loadRegistry,
  loadRooms,
  NOTIFY_INSTRUCTION,
  saveRegistry,
  saveRooms,
  senderName,
  timeOf,
  type Registry,
  type RegistryEntry,
} from "./src/store";
import { centerAction } from "./src/center-client";
import { createQueueTransport, type QueueTransport } from "./src/queue-transport";
import { checkCenterInbox } from "./src/center-inbox";
import { wakeSessions } from "./src/center-wake";
import {
  clearPendingAdmission,
} from "./src/queue";
import { createNotifier } from "./src/plugin-notifications";
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
  fn: (svc: RoomService) => T,
  readOnly = false,
): Promise<T> {
  return enqueue(async () => {
    const svc = new RoomService();
    svc.hydrate(await loadRooms());
    try {
      const result = fn(svc);
      if (!readOnly) {
        await saveRooms(svc);
      }
      return result;
    } catch (err) {
      if (err instanceof RoomError) {
        return `error: ${err.message}` as unknown as T;
      }
      throw err;
    }
  });
}

async function registerSelf(
  roomId: string,
  sessionID: string,
  name = identity(),
): Promise<void> {
  const runtime = currentRuntime();
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      const latestMessageTs =
        (await loadRooms()).find((room) => room.id === roomId)?.messages.at(-1)
          ?.createdAt ?? 0;
      const regRoom = (reg[roomId] =
        reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
      regRoom[sessionID] = {
        serverUrl: runtime.selfServerUrl,
        apiPrefix: runtime.protocol === "v1" ? "" : "/api",
        protocol: runtime.protocol,
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
      await saveRegistry(reg);
    } catch {
      // ponytail: registry failure only disables push, never blocks room ops
    }
  });
}

async function refreshSelf(runtime: PluginRuntime, sessionID: string): Promise<void> {
  await enqueue(async () => {
    try {
      const registry = await loadRegistry();
      let changed = false;
      for (const members of Object.values(registry)) {
        const entry = members[sessionID];
        if (!entry) continue;
        entry.serverUrl = runtime.selfServerUrl;
        entry.apiPrefix = runtime.protocol === "v1" ? "" : "/api";
        entry.protocol = runtime.protocol;
        entry.directory = runtime.selfDirectory || undefined;
        changed = true;
      }
      if (changed) await saveRegistry(registry);
    } catch {
      // Existing watermarks and identities remain untouched if refresh fails.
    }
  });
}

async function unregisterSelf(
  roomId: string,
  sessionID: string,
): Promise<void> {
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      if (reg[roomId]) {
        delete reg[roomId][sessionID];
        if (Object.keys(reg[roomId]).length === 0) {
          delete reg[roomId];
        }
        await saveRegistry(reg);
      }
    } catch {
      // ponytail: registry failure only disables push, never blocks room ops
    }
  });
}

// ponytail: push is best-effort; poll remains the fallback; log every attempt for debugging
async function bumpLastRead(
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<boolean> {
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      const entry = reg[roomId]?.[sessionID];
      if (entry) {
        // never rewind: an older in-flight push must not lower the watermark
        entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
        await saveRegistry(reg);
        clearPendingAdmission(sessionID, roomId, ts);
        return true;
      }
      return false;
    } catch {
      // best-effort: an unpromoted read position only means poll repeats
      return false;
    }
  });
}

async function bumpLastQueued(
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<boolean> {
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      const entry = reg[roomId]?.[sessionID];
      if (entry) {
        entry.lastQueuedTs = Math.max(entry.lastQueuedTs ?? 0, ts);
        await saveRegistry(reg);
        clearPendingAdmission(sessionID, roomId, ts);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

const notifier = createNotifier({
  transport: () => currentRuntime().transport,
  bumpQueued: (roomId, sessionID, ts) => bumpLastQueued(roomId, sessionID, ts),
});
const { notifyRoom, notifyTarget } = notifier;

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
    for (const room of rooms) {
      if (!registry[room.id]?.[sessionID]) continue;
      await notifyTarget(sessionID, {
        roomId: room.id,
        roomName: room.name,
        messages: room.messages,
      }, transport);
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
      if (runtime.center.center) {
        // ponytail: central mode — self-pull inbox first, then act via HTTP
        // (skipped for poll: poll itself pulls the inbox, so racing the
        // fire-and-forget check would read the position it just advanced)
        if (args.action !== "poll") {
          void checkCenterInbox(runtime.center, context.sessionID, runtime.transport);
        }
        return await centerAction(runtime.center, args, context.sessionID);
      }
      // ponytail: act as the identity this session registered with on join
      let selfName = identity();
      let joinPrevName: string | undefined;
      let joinPrevShared = false;
      let leaveNameShared = false;
      let pollLastRead = 0;
      let pollEntry = false;
      if (args.roomId) {
        const reg = await loadRegistry().catch(() => ({} as Registry));
        if (args.action === "send" || args.action === "leave") {
          selfName = reg[args.roomId]?.[context.sessionID]?.name ?? selfName;
        }
        if (args.action === "leave") {
          // Keep the participant while another session still uses this name.
          leaveNameShared = Object.entries(reg[args.roomId] ?? {}).some(
            ([sid, e]) => sid !== context.sessionID && e.name === selfName,
          );
        }
        if (args.action === "join") {
          joinPrevName = reg[args.roomId]?.[context.sessionID]?.name;
          // ponytail: don't retire the old participant if another session
          // still uses it (default same-host identity is shared)
          joinPrevShared =
            joinPrevName !== undefined &&
            Object.entries(reg[args.roomId] ?? {}).some(
              ([sid, e]) => sid !== context.sessionID && e.name === joinPrevName,
            );
        }
        if (args.action === "poll") {
          pollEntry = reg[args.roomId]?.[context.sessionID] !== undefined;
          selfName = reg[args.roomId]?.[context.sessionID]?.name ?? selfName;
          pollLastRead = reg[args.roomId]?.[context.sessionID]?.lastReadTs ?? 0;
        }
      }
      let actedRoomId: string | undefined;
      let newMemberName: string | undefined;
      let leftRoomId: string | undefined;
      let pollMaxTs: number | undefined;
      const result = await withRooms<string>(
        (svc) => {
        switch (args.action) {
          case "create": {
            if (!args.name?.trim()) {
              return "error: name is required";
            }
            const created = svc.createRoom(args.name.trim(), identity());
            actedRoomId = created.id;
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
            actedRoomId = args.roomId;
            newMemberName = me;
            if (!already) {
              // ponytail: membership events live in the message stream, so
              // the join notification rides the normal unread push
              svc.addEvent(args.roomId, `${me} joined the room`);
              void notifyRoom(
                args.roomId,
                room.name,
                NOTIFY_INSTRUCTION,
                context.sessionID,
                room.messages,
              ).catch(() => {});
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
              void notifyRoom(
                args.roomId,
                room.name,
                NOTIFY_INSTRUCTION,
                context.sessionID,
                room.messages,
              ).catch(() => {});
            }
            leftRoomId = args.roomId;
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
            void notifyRoom(
              args.roomId,
              room.name,
              NOTIFY_INSTRUCTION,
              context.sessionID,
              room.messages,
            ).catch(() => {});
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
            const messages = svc
              .getMessages(args.roomId)
              .filter((m) => m.createdAt > pollLastRead);
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
              .join("\n");
          }
        }
      },
      READ_ONLY_ACTIONS.has(args.action));
      const joinedRoom = actedRoomId;
      if (joinedRoom !== undefined) {
        await registerSelf(joinedRoom, context.sessionID, newMemberName);
      }
      if (leftRoomId !== undefined) {
        await unregisterSelf(leftRoomId, context.sessionID);
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
  wake: (center, transport, sessions) => wakeSessions(center, transport, serveWakeUrl, sessions),
  central: Boolean(centerUrl),
});

export const id = "chat-room";
export default { id, server, setup };
