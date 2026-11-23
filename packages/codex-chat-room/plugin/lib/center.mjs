// Central chat-room HTTP client and the room action used by the Codex MCP tool.
// This mirrors the subset of the OpenCode plugin's central mode that the
// central server can serve without a host session transport.
import os from "node:os";
import { resolveCodexConfig } from "./config.mjs";

export function centerConfig(env = process.env) {
  const { url, token } = resolveCodexConfig(env);
  return { url: url.replace(/\/+$/, ""), token };
}

export function sessionIDFor(threadID) {
  return `codex:${threadID}`;
}

export function identity(name) {
  return (name || `${os.userInfo().username}@${os.hostname()}`).slice(0, 64);
}

export function timeOf(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export async function request(cfg, path, method, body, timeout = 15000) {
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${data.error ?? "unknown"}`);
  }
  return data;
}

function senderName(room, message) {
  const participant = (room.participants || []).find((p) => p.id === message.senderId);
  return participant?.name ?? message.senderId;
}

export function formatRoom(room) {
  const members = (room.participants || []).map((p) => p.name).join(", ");
  const lines = [`Room ${room.id} (${room.name}) \u2014 members: ${members}`];
  for (const message of (room.messages || []).slice(-5)) {
    lines.push(`[${timeOf(message.createdAt)}] ${senderName(room, message)}: ${message.text}`);
  }
  return lines.join("\n");
}

function formatTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return "no tasks";
  return tasks.map((task) => {
    const steps = Array.isArray(task.steps) ? task.steps.flatMap((step) => {
      if (typeof step === "string") return step ? [{ text: step, done: false }] : [];
      return step && typeof step.text === "string" && step.text ? [{ text: step.text, done: step.done === true }] : [];
    }) : [];
    const done = steps.filter((step) => step.done).length;
    return `${task.id} [${task.status}] ${task.title}` +
      `${task.assignee ? ` (assignee: ${task.assignee})` : ""}` +
      `${task.creatorName ? ` (creator: ${task.creatorName})` : ""}` +
      `${task.dueDate ? ` (due: ${task.dueDate})` : ""}` +
      `${Array.isArray(task.participants) && task.participants.length ? ` (participants: ${task.participants.join(", ")})` : ""}` +
      `${task.description ? `\n  ${task.description}` : ""}` +
      `${steps.length ? `\n  steps: ${done}/${steps.length}${steps.map((step) => `\n  - [${step.done ? "x" : " "}] ${step.text}`).join("")}` : ""}` +
      `${task.conclusion ? `\n  conclusion: ${task.conclusion}` : ""}`;
  }).join("\n");
}

function taskSteps(steps) {
  return steps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    return { text: step.text, done: step.done === true };
  });
}

function taskFields(args) {
  return {
    ...(args.title !== undefined ? { title: args.title.trim() } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.assignee !== undefined ? { assignee: args.assignee.trim() } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.dueDate !== undefined ? { dueDate: String(args.dueDate).trim() } : {}),
    ...(Array.isArray(args.participants) ? { participants: args.participants.map((name) => String(name).trim()) } : {}),
    ...(args.conclusion !== undefined ? { conclusion: args.conclusion } : {}),
    ...(Array.isArray(args.steps) ? { steps: taskSteps(args.steps) } : {}),
  };
}

export async function centerAction(cfg, args, sessionID) {
  switch (args.action) {
    case "list": {
      const rooms = await request(cfg, `/rooms?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      if (!Array.isArray(rooms) || rooms.length === 0) return "no rooms yet";
      return rooms.map((r) => `${r.id} (${r.name}): ${(r.participants || []).length} members`).join("\n");
    }
    case "create": {
      if (!args.name?.trim()) return "error: name is required";
      const room = await request(cfg, "/rooms", "POST", {
        name: args.name.trim(),
        ownerId: identity(),
        sessionID,
        host: os.hostname(),
        ...(args.joinPolicy ? { joinPolicy: args.joinPolicy } : {}),
      });
      return formatRoom(room);
    }
    case "join": {
      if (!args.name?.trim()) return "error: name is required to join a room";
      if (!args.roomId) return "error: roomId is required";
      const me = identity(args.name.trim());
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/join`, "POST", {
        sessionID,
        participantId: me,
        participantName: me,
        host: os.hostname(),
      });
      if (room.status === "pending") {
        return `pending: join request sent to room ${args.roomId}; a human administrator must approve it. You are NOT a member yet: do not claim you joined, and do not send or poll until join_status reports joined.`;
      }
      return formatRoom(room);
    }
    case "join_status": {
      if (!args.roomId) return "error: roomId is required";
      const result = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/join-requests/status?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      if (result.status === "joined") return `joined room ${args.roomId}`;
      if (result.status === "pending") return `pending: join request for room ${args.roomId} is waiting for a human administrator; you are NOT a member yet`;
      return `none: no join request for room ${args.roomId}; run join with your name to request access`;
    }
    case "leave": {
      if (!args.roomId) return "error: roomId is required";
      await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/leave`, "POST", { sessionID });
      return `left room ${args.roomId}`;
    }
    case "members": {
      if (!args.roomId) return "error: roomId is required";
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}`, "GET");
      const names = (room.participants || []).map((p) => p.name);
      return names.length ? names.join("\n") : "no members";
    }
    case "send": {
      if (!args.roomId) return "error: roomId is required";
      if (!args.text?.trim()) return "error: text is required";
      const text = args.text.trim();
      const room = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/messages`, "POST", {
        sessionID,
        text,
        ...(args.isQuestion ? { isQuestion: true } : {}),
      });
      const messages = room.messages || [];
      const sentID = [...messages].reverse().find((message) => message.senderSessionID === sessionID && message.text === text)?.id
        ?? messages.at(-1)?.id;
      return `sent: ${text}\n${sentID ? `message id: ${sentID}\n` : ""}${formatRoom(room)}`;
    }
    case "recall": {
      if (!args.roomId) return "error: roomId is required";
      if (!args.messageId) return "error: messageId is required";
      await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/messages/${encodeURIComponent(args.messageId)}/recall`, "POST", { sessionID });
      return `recalled message ${args.messageId}`;
    }
    case "poll": {
      if (!args.roomId) return "error: roomId is required";
      const result = await request(
        cfg,
        `/inbox?sessionID=${encodeURIComponent(sessionID)}&roomId=${encodeURIComponent(args.roomId)}&excludeSelf=1`,
        "GET",
      );
      if (!result.member) return "error: not joined";
      const items = (result.items || []).filter((item) => item.senderSessionID !== sessionID && !item.recalledAt);
      if (items.length === 0) return "no new messages";
      const lines = items.map((item) => `[${timeOf(item.createdAt)}] ${item.senderId}: ${item.text} (id: ${item.id})`);
      const maxTs = items.reduce((max, item) => Math.max(max, item.createdAt), 0);
      await request(cfg, "/read", "POST", { roomId: args.roomId, sessionID, ts: maxTs }).catch(() => {});
      return lines.join("\n") + (result.hasMore ? "\nMore unread messages remain; poll again." : "");
    }
    case "announcement_list":
    case "announcement_read":
    case "announcement_write":
    case "announcement_delete": {
      if (!args.roomId) return "error: roomId is required";
      if (args.action !== "announcement_list" && !args.announcementName) {
        return "error: announcementName is required";
      }
      const root = `/rooms/${encodeURIComponent(args.roomId)}/announcements`;
      if (args.action === "announcement_list") {
        const result = await request(cfg, root, "GET");
        return (result.announcements || []).map((item) => `${item.name}: ${item.content}`).join("\n") || "no announcements";
      }
      const path = `${root}/${encodeURIComponent(args.announcementName)}`;
      if (args.action === "announcement_read") {
        const result = await request(cfg, path, "GET");
        return `${result.announcement.name}:\n${result.announcement.content}`;
      }
      if (args.action === "announcement_write") {
        if (typeof args.content !== "string") return "error: content is required";
        const result = await request(cfg, path, "PUT", { sessionID, content: args.content });
        return `announcement saved: ${result.announcement.name}`;
      }
      await request(cfg, path, "DELETE", { sessionID });
      return `announcement deleted: ${args.announcementName}`;
    }
    case "task_list": {
      if (!args.roomId) return "error: roomId is required";
      const result = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/tasks?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      return formatTasks(result.tasks);
    }
    case "task_create": {
      if (!args.roomId) return "error: roomId is required";
      if (typeof args.title !== "string" || !args.title.trim()) return "error: title is required to create a task";
      const task = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/tasks`, "POST", {
        sessionID,
        ...taskFields(args),
      });
      return `task created: ${task.task.title} (id: ${task.task.id}, status: ${task.task.status})`;
    }
    case "task_update": {
      if (!args.roomId) return "error: roomId is required";
      if (!args.taskId) return "error: taskId is required";
      const fields = taskFields(args);
      if (!Object.keys(fields).length) return "error: at least one of title, description, assignee, status, dueDate, participants, conclusion, or steps is required to update a task";
      if (fields.status !== undefined && !["todo", "doing", "done"].includes(fields.status)) return "error: status must be todo, doing, or done";
      if (fields.title !== undefined && !fields.title) return "error: title must contain 1 to 200 characters";
      const result = await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/tasks/${encodeURIComponent(args.taskId)}`, "PATCH", { sessionID, ...fields });
      return `task updated: ${result.task.title} (id: ${result.task.id}, status: ${result.task.status})`;
    }
    case "task_delete": {
      if (!args.roomId) return "error: roomId is required";
      if (!args.taskId) return "error: taskId is required";
      await request(cfg, `/rooms/${encodeURIComponent(args.roomId)}/tasks/${encodeURIComponent(args.taskId)}`, "DELETE", { sessionID });
      return `task deleted: ${args.taskId}`;
    }
    default:
      return "error: unknown action";
  }
}