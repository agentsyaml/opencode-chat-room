import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import RoomService, { RoomError, type Message } from "./src/room-service";
import {
  authHeader,
  enqueue,
  formatNotificationLines,
  formatRoom,
  identity,
  loadRegistry,
  loadRooms,
  NOTIFY_INSTRUCTION,
  saveRegistry,
  saveRooms,
  senderName,
  statePath,
  timeOf,
  type Registry,
  type RegistryEntry,
} from "./src/store";
import { centerAction, checkCenterInbox } from "./src/center-client";

// captured once at server start; registry push notifications route to it
let selfServerUrl = "";

// ponytail: CHAT_ROOM_SERVER_URL switches to central mode (all state on a
// central server); unset = standalone local-file mode
const centerUrl = process.env.CHAT_ROOM_SERVER_URL ?? "";
const centerToken = process.env.CHAT_ROOM_SERVER_TOKEN ?? "";
const centerOpts = { center: centerUrl, token: centerToken };

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
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      const regRoom = (reg[roomId] =
        reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
      regRoom[sessionID] = {
        serverUrl: selfServerUrl,
        apiPrefix: "/api",
        name,
        // ponytail: re-join must not rewind the read watermark (unread
        // messages before the re-join would be silently dropped); a first
        // join starts reading at join time
        lastReadTs: regRoom[sessionID]?.lastReadTs ?? Date.now(),
      };
      await saveRegistry(reg);
    } catch {
      // ponytail: registry failure only disables push, never blocks room ops
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

function notifyPath(): string {
  return path.join(path.dirname(statePath()), "notify.log");
}

async function logNotify(
  roomId: string,
  results: ReadonlyArray<PromiseSettledResult<{ url: string; status: number }>>,
): Promise<void> {
  const lines = results.map((r) => {
    const head = `[${timeOf(Date.now())}] room=${roomId}`;
    return r.status === "fulfilled"
      ? `${head} OK ${r.value.status} ${r.value.url}`
      : `${head} FAIL ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
  });
  await fs
    .appendFile(notifyPath(), lines.join("\n") + "\n", "utf8")
    .catch(() => {});
}

// ponytail: push is best-effort; poll remains the fallback; log every attempt for debugging
async function bumpLastRead(
  roomId: string,
  sessionID: string,
  ts: number,
): Promise<void> {
  return enqueue(async () => {
    try {
      const reg = await loadRegistry();
      const entry = reg[roomId]?.[sessionID];
      if (entry) {
        // never rewind: an older in-flight push must not lower the watermark
        entry.lastReadTs = Math.max(entry.lastReadTs ?? 0, ts);
        await saveRegistry(reg);
      }
    } catch {
      // best-effort: an unpromoted read position only means poll repeats
    }
  });
}

// ponytail: one push carries EVERY unread message for the target (not just
// the latest), so advancing the watermark on success never skips a message
// whose earlier push failed. Event-only pushes (empty messages) don't bump.
// ponytail: push is best-effort; poll remains the fallback; log every attempt for debugging
async function notifyRoom(
  roomId: string,
  roomName: string,
  body: string,
  selfSessionID: string,
  messages: Message[],
): Promise<void> {
  try {
    const reg = await loadRegistry();
    const targets = Object.entries(reg[roomId] ?? {}).filter(
      ([sessionID, entry]) => sessionID !== selfSessionID && entry.serverUrl,
    );
    const auth = authHeader();
    const results = await Promise.allSettled(
      targets.map(async ([sessionID, entry]) => {
        const unread = messages.filter(
          (m) => m.createdAt > (entry.lastReadTs ?? 0) && m.senderId !== entry.name,
        );
        const { lines, capped } = formatNotificationLines(unread);
        const prompt =
          unread.length > 0
            ? `<notification>\nNew messages in room ${roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`
            : `<notification>\n${NOTIFY_INSTRUCTION}\n</notification>`;
        const base = new URL(entry.serverUrl);
        const prefix = (entry.apiPrefix || "/api").replace(/^\/+|\/+$/g, "");
        const url = `${base.origin}/${prefix}/session/${sessionID}/prompt`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: auth } : {}),
          },
          body: JSON.stringify({ prompt, delivery: "queue" }),
        });
        return {
          url,
          status: res.status,
          sessionID,
          // ponytail: a capped push must not advance the watermark — the
          // folded-out messages would become permanently unreadable
          maxTs:
            unread.length > 0 && !capped
              ? Math.max(...unread.map((m) => m.createdAt))
              : undefined,
        };
      }),
    );
    // mark pushed messages as read only on 2xx; a failed push stays unread
    // so the receiver's next poll picks it up
    for (const r of results) {
      if (
        r.status === "fulfilled" &&
        r.value.status >= 200 &&
        r.value.status < 300 &&
        r.value.maxTs !== undefined
      ) {
        void bumpLastRead(roomId, r.value.sessionID, r.value.maxTs);
      }
    }
    await logNotify(roomId, results);
  } catch {
    // registry/io failure: nothing to log, fall back to poll
  }
}

const READ_ONLY_ACTIONS = new Set(["list", "members", "poll"]);

const room = tool({
  description:
    "Chat room operations: create, join, leave and list rooms; send and poll messages; list members",
  args: {
    action: z.enum(["create", "join", "leave", "list", "send", "poll", "members"]),
    name: z.string().max(64).optional(),
    roomId: z.string().optional(),
    text: z.string().max(2000).optional(),
  },
  execute: async (args, context) => {
    try {
      if (centerUrl) {
        // ponytail: central mode — self-pull inbox first, then act via HTTP
        // (skipped for poll: poll itself pulls the inbox, so racing the
        // fire-and-forget check would read the position it just advanced)
        if (args.action !== "poll") {
          void checkCenterInbox(centerOpts, context.sessionID, selfServerUrl);
        }
        return await centerAction(centerOpts, args, context.sessionID);
      }
      // ponytail: act as the identity this session registered with on join
      let selfName = identity();
      let joinPrevName: string | undefined;
      let joinPrevShared = false;
      let pollLastRead = 0;
      let pollEntry = false;
      if (args.roomId) {
        const reg = await loadRegistry().catch(() => ({} as Registry));
        if (args.action === "send" || args.action === "leave") {
          selfName = reg[args.roomId]?.[context.sessionID]?.name ?? selfName;
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
              );
            }
            return formatRoom(svc, room);
          }
          case "leave": {
            if (!args.roomId) {
              return "error: roomId is required";
            }
            svc.leaveRoom(args.roomId, selfName);
            const room = svc.getRoom(args.roomId);
            svc.addEvent(args.roomId, `${selfName} left the room`);
            void notifyRoom(
              args.roomId,
              room.name,
              NOTIFY_INSTRUCTION,
              context.sessionID,
              room.messages,
            );
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
            const msg = svc.sendMessage(args.roomId, selfName, args.text);
            const room = svc.getRoom(args.roomId);
            void notifyRoom(
              args.roomId,
              room.name,
              NOTIFY_INSTRUCTION,
              context.sessionID,
              room.messages,
            );
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
  },
});

// ponytail: mutation of the passed config is enough for the SDK to pick up the command
async function config(cfg: any) {
  cfg.command = cfg.command ?? {};
  cfg.command["room"] = {
    description: "Chat room: create/join/leave/list rooms, send and poll messages",
    template:
      "Use the room tool to handle the chat room command. Arguments: $ARGUMENTS",
  };
}

export default {
  id: "chat-room",
  server: async (input: { serverUrl: URL | string }) => {
    selfServerUrl = String(input.serverUrl);
    return {
      tool: { room },
      config,
      // ponytail: central mode has no cross-host push, so each session pulls
      // its inbox on chat messages and self-pushes queue notifications
      // (SDK signature: (input, output) — sessionID is on the first arg)
      ...(centerUrl
        ? {
            "chat.message": async (
              input: { sessionID: string },
              _output: unknown,
            ) => {
              void checkCenterInbox(
                centerOpts,
                input.sessionID,
                selfServerUrl,
              );
            },
          }
        : {}),
    };
  },
};
