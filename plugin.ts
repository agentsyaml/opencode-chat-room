import { tool, type PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import RoomService, { RoomError, type Message } from "./src/room-service";
import {
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
import {
  centerAction,
  checkCenterInbox,
  createQueueTransport,
  sendQueue,
  wakeSessions,
  type QueueTransport,
} from "./src/center-client";
import {
  clearPendingAdmission,
  getOrCreatePendingAdmission,
  markPendingAdmissionAdmitted,
  rejectPendingAdmission,
} from "./src/queue";

// captured once at server start; registry push notifications route to it
let selfServerUrl = "";
let selfDirectory = "";
let queueTransport: QueueTransport = createQueueTransport();

// ponytail: central-mode in-process wake timer (see server() below)
let wakeTimer: ReturnType<typeof setInterval> | null = null;

// ponytail: CHAT_ROOM_SERVER_URL switches to central mode (all state on a
// central server); unset = standalone local-file mode
const centerUrl = process.env.CHAT_ROOM_SERVER_URL ?? "";
const centerToken = process.env.CHAT_ROOM_SERVER_TOKEN ?? "";
const centerOpts = { center: centerUrl, token: centerToken, directory: "" };
// ponytail: optional常驻 opencode serve 地址——配置了才能对已退出 session
// 做进程内唤起；未配置则不唤起（用户要求）
const serveWakeUrl = process.env.CHAT_ROOM_WAKE_SERVE_URL ?? "";

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
      const latestMessageTs =
        (await loadRooms()).find((room) => room.id === roomId)?.messages.at(-1)
          ?.createdAt ?? 0;
      const regRoom = (reg[roomId] =
        reg[roomId] ?? Object.create(null) as Record<string, RegistryEntry>);
      regRoom[sessionID] = {
        serverUrl: selfServerUrl,
        apiPrefix: "/api",
        name,
        directory: selfDirectory || undefined,
        // ponytail: re-join must not rewind the read watermark (unread
        // messages before the re-join would be silently dropped); a first
        // join starts reading at join time
        lastReadTs:
          regRoom[sessionID]?.lastReadTs ??
          Math.max(Date.now(), latestMessageTs),
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
    if (r.status === "rejected") {
      return `${head} FAIL ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
    }
    return r.value.status >= 200 && r.value.status < 300
      ? `${head} OK ${r.value.status} ${r.value.url}`
      : `${head} FAIL ${r.value.status} ${r.value.url}`;
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

// ponytail: one push carries EVERY unread message for the target (not just
// the latest), so advancing the watermark on success never skips a message
// whose earlier push failed. Event-only pushes (empty messages) don't bump.
type NotifyBatch = {
  roomId: string;
  roomName: string;
  messages: Message[];
};

type NotifyAttempt = { url: string; status: number };

type NotifyTargetQueue = {
  latest: NotifyBatch | undefined;
  latestTs: number;
  running: Promise<NotifyAttempt[]>;
};

const notifyQueues = new Map<string, NotifyTargetQueue>();

function notifyBatchMaxTs(batch: NotifyBatch): number {
  return batch.messages.reduce(
    (maxTs, message) => Math.max(maxTs, message.createdAt),
    0,
  );
}

async function notifyTarget(
  sessionID: string,
  batch: NotifyBatch,
): Promise<NotifyAttempt | undefined> {
  const reg = await loadRegistry();
  const entry = reg[batch.roomId]?.[sessionID];
  if (!entry?.serverUrl) {
    return undefined;
  }
  const unread = batch.messages.filter(
    (m) =>
      m.createdAt > (entry.lastReadTs ?? 0) &&
      (m.senderSessionID !== undefined
        ? m.senderSessionID !== sessionID
        : m.senderId !== entry.name),
  );
  const { lines, capped } = formatNotificationLines(unread);
  const prompt =
    unread.length > 0
      ? `<notification>\nNew messages in room ${batch.roomName}:\n${lines.join("\n")}\n${NOTIFY_INSTRUCTION}\n</notification>`
      : `<notification>\n${NOTIFY_INSTRUCTION}\n</notification>`;
  const maxTs = unread.reduce(
    (mx, message) => Math.max(mx, message.createdAt),
    0,
  );
  const admissionItems = unread.length > 0 ? unread : batch.messages.slice(-1);
  const admission = getOrCreatePendingAdmission(
    sessionID,
    batch.roomId,
    admissionItems,
    prompt,
    maxTs,
    capped,
  );
  const base = new URL(entry.serverUrl);
  const prefix = (entry.apiPrefix || "/api").replace(/^\/+|\/+$/g, "");
  const url = `${base.origin}/${prefix}/session/${sessionID}/prompt`;
  if (admission.state === "admitted") {
    if (admission.capped) {
      if (maxTs <= admission.maxTs) {
        return { url, status: 200 };
      }
    } else {
      if (admission.maxTs <= 0) {
        return { url, status: 200 };
      }
      await bumpLastRead(batch.roomId, sessionID, admission.maxTs);
      return { url, status: 200 };
    }
  }
  const result = await sendQueue(
    {
      ...queueTransport,
      serverUrl: entry.serverUrl,
      directory: entry.directory ?? queueTransport.directory,
    },
    sessionID,
    admission.prompt,
    admission.id,
  );
  if (result !== "delivered") {
    if (result === "rejected") {
      rejectPendingAdmission(sessionID, batch.roomId, admission.id);
    }
    return { url, status: result === "unreachable" ? 0 : 400 };
  }
  markPendingAdmissionAdmitted(sessionID, batch.roomId, admission.id);
  if (admission.maxTs > 0 && !admission.capped) {
    await bumpLastRead(batch.roomId, sessionID, admission.maxTs);
  }
  return { url, status: 200 };
}

function queueNotifyTarget(
  sessionID: string,
  batch: NotifyBatch,
): Promise<NotifyAttempt[]> {
  const key = JSON.stringify([batch.roomId, sessionID]);
  const existing = notifyQueues.get(key);
  if (existing) {
    const maxTs = notifyBatchMaxTs(batch);
    if (maxTs > existing.latestTs) {
      existing.latest = batch;
      existing.latestTs = maxTs;
    }
    return existing.running;
  }

  const state: NotifyTargetQueue = {
    latest: batch,
    latestTs: notifyBatchMaxTs(batch),
    running: Promise.resolve([] as NotifyAttempt[]),
  };
  const running = (async (): Promise<NotifyAttempt[]> => {
    const attempts: NotifyAttempt[] = [];
    let failed = false;
    let firstError: unknown;
    while (state.latest) {
      const current = state.latest;
      state.latest = undefined;
      try {
        const attempt = await notifyTarget(sessionID, current);
        if (attempt) {
          attempts.push(attempt);
        }
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    }
    if (failed) {
      throw firstError;
    }
    return attempts;
  })();
  state.running = running;
  notifyQueues.set(key, state);
  const cleanup = () => {
    if (notifyQueues.get(key) === state) {
      notifyQueues.delete(key);
    }
  };
  void running.then(cleanup, cleanup);
  return running;
}

async function notifyRoom(
  roomId: string,
  roomName: string,
  _body: string,
  selfSessionID: string,
  messages: Message[],
): Promise<void> {
  const reg = await loadRegistry();
  const targets = Object.entries(reg[roomId] ?? {}).filter(
    ([sessionID, entry]) => sessionID !== selfSessionID && entry.serverUrl,
  );
  const batch: NotifyBatch = { roomId, roomName, messages };
  const results = await Promise.allSettled(
    targets.map(([sessionID]) => queueNotifyTarget(sessionID, batch)),
  );
  const logResults: PromiseSettledResult<NotifyAttempt>[] = [];
  let failed = false;
  let firstError: unknown;
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const attempt of result.value) {
        logResults.push({ status: "fulfilled", value: attempt });
      }
    } else {
      logResults.push({ status: "rejected", reason: result.reason });
      if (!failed) {
        firstError = result.reason;
        failed = true;
      }
    }
  }
  await logNotify(roomId, logResults);
  if (failed) {
    throw firstError;
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
          void checkCenterInbox(centerOpts, context.sessionID, queueTransport);
        }
        return await centerAction(centerOpts, args, context.sessionID);
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
          // ora-2 M2: 其他 session 仍持有该名字时，离开只删条目不删参与者
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
            // 也不广播假的 "left" 事件（参与者仍在场）
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
  server: async (input: PluginInput) => {
    queueTransport = createQueueTransport(input);
    selfServerUrl = queueTransport.serverUrl ?? "";
    selfDirectory = input.directory;
    centerOpts.directory = selfDirectory;
    if (centerUrl) {
      // ponytail: in-process wake watcher — sweep the central server every
      // 10s and self-push queue notifications to any session (including
      // sleeping sub-agents in this process) that has unread messages; the
      // central server itself has no opencode knowledge. 10s balances
      // wake latency vs scan cost (wakeChecking prevents overlap)
      if (wakeTimer) {
        clearInterval(wakeTimer); // HMR/reload must not accumulate timers
      }
      void wakeSessions(centerOpts, queueTransport, serveWakeUrl);
      wakeTimer = setInterval(() => {
        void wakeSessions(centerOpts, queueTransport, serveWakeUrl);
      }, 10000);
    }
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
                queueTransport,
              );
            },
          }
        : {}),
    };
  },
};
