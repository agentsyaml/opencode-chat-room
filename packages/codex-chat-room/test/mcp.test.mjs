import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import readline from "node:readline";
import { roomPayload, startCenter } from "./helpers.mjs";
import { ROOM_TOOL } from "../plugin/lib/server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Keep spawned servers away from a developer's real chatroom config.
const testEnv = { HOME: path.join(root, "test", ".no-home"), XDG_CONFIG_HOME: path.join(root, "test", ".no-config") };

test("room tool accepts message text up to 5000 characters", () => {
  assert.equal(ROOM_TOOL.inputSchema.properties.text.maxLength, 5000);
  assert.ok(ROOM_TOOL.inputSchema.properties.action.enum.includes("task_update"));
  assert.deepEqual(ROOM_TOOL.inputSchema.properties.status.enum, ["todo", "doing", "done"]);
  assert.equal(ROOM_TOOL.inputSchema.properties.dueDate.type, "string");
  assert.equal(ROOM_TOOL.inputSchema.properties.participants.maxItems, 50);
  assert.equal(ROOM_TOOL.inputSchema.properties.conclusion.maxLength, 5000);
  assert.equal(ROOM_TOOL.inputSchema.properties.steps.maxItems, 30);
  assert.equal(ROOM_TOOL.inputSchema.properties.steps.items.anyOf.length, 2);
  assert.ok(ROOM_TOOL.inputSchema.properties.action.enum.includes("get_message"));
  assert.ok(ROOM_TOOL.inputSchema.properties.action.enum.includes("catch_up"));
  assert.equal(ROOM_TOOL.inputSchema.properties.parentMessageId.type, "string");
  assert.equal(ROOM_TOOL.inputSchema.properties.afterSeq.minimum, 0);
  assert.equal(ROOM_TOOL.inputSchema.properties.limit.maximum, 200);
});

function startMcp(env) {
  const child = spawn(process.execPath, ["plugin/mcp-server.mjs"], {
    cwd: root,
    env: { ...process.env, ...testEnv, CHAT_ROOM_DELIVERY: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const lines = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const message = JSON.parse(line);
    responses.set(message.id, message);
  });
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
      const check = setInterval(() => {
        if (!responses.has(id)) return;
        clearInterval(check);
        clearTimeout(timer);
        resolve(responses.get(id));
      }, 5);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { child, lines, request };
}

test("MCP handshake exposes the room tool and forwards Codex thread metadata", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/rooms") return [200, [roomPayload()]];
    if (method === "POST" && path === "/rooms/r1/join") return [201, roomPayload()];
    if (method === "POST" && path === "/rooms/r1/messages") return [200, roomPayload()];
    return undefined;
  });
  const mcp = startMcp({ CHAT_ROOM_SERVER_URL: center.url });
  try {
    const init = await mcp.request(1, "initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "chat_room");
    assert.match(init.result.instructions, /room tool/);

    const tools = await mcp.request(2, "tools/list", {});
    assert.equal(tools.result.tools[0].name, "room");
    assert.ok(tools.result.tools[0].inputSchema.properties.action.enum.includes("poll"));

    const list = await mcp.request(3, "tools/call", {
      name: "room",
      arguments: { action: "list" },
      _meta: { threadId: "thread-1" },
    });
    assert.equal(list.result.content[0].text, "r1 (dev): 1 members");
    assert.equal(list.result.isError, false);
    const listing = center.requests.find((r) => r.path === "/rooms");
    assert.equal(listing.query.sessionID, "codex:thread-1");

    const join = await mcp.request(4, "tools/call", {
      name: "room",
      arguments: { action: "join", roomId: "r1", name: "alice" },
      _meta: { threadId: "thread-1" },
    });
    assert.match(join.result.content[0].text, /Room r1 \(dev\)/);
    const joined = center.requests.find((r) => r.path === "/rooms/r1/join");
    assert.equal(joined.body.sessionID, "codex:thread-1");
    assert.equal(joined.body.participantName, "alice");

    for (const line of mcp.lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    mcp.child.kill();
    await center.close();
  }
});

test("addressing actions reach the central routes without automatic writes", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/rooms/r1/messages/m1") {
      return [200, { id: "m1", roomId: "r1", seq: 1, senderId: "bob", createdAt: 1, recalled: true, recalledAt: 2, recalledBy: "bob", text: null, unavailable: "recalled", resourceIDs: [] }];
    }
    if (method === "GET" && path === "/rooms/r1/catch-up") {
      return [200, { messages: [], nextCursor: 6, hasMore: false, unreadMentions: [], unreadMentionCount: 0, unansweredQuestions: [], unansweredQuestionCount: 0 }];
    }
    if (method === "POST" && path === "/rooms/r1/messages") {
      return [200, roomPayload({ messages: [
        { id: "m2", roomId: "r1", senderId: "alex@host", senderSessionID: "codex:thread-1", text: "answer", createdAt: 3 },
      ] })];
    }
    return undefined;
  });
  const mcp = startMcp({ CHAT_ROOM_SERVER_URL: center.url });
  try {
    const message = await mcp.request(1, "tools/call", {
      name: "room",
      arguments: { action: "get_message", roomId: "r1", messageId: "m1" },
      _meta: { threadId: "thread-1" },
    });
    assert.equal(JSON.parse(message.result.content[0].text).unavailable, "recalled");
    assert.equal(center.requests.at(-1).query.sessionID, "codex:thread-1");

    const page = await mcp.request(2, "tools/call", {
      name: "room",
      arguments: { action: "catch_up", roomId: "r1", afterSeq: 2, limit: 3 },
      _meta: { threadId: "thread-1" },
    });
    assert.equal(JSON.parse(page.result.content[0].text).nextCursor, 6);
    const catchUp = center.requests.find((request) => request.path === "/rooms/r1/catch-up");
    assert.equal(catchUp.query.afterSeq, "2");
    assert.equal(catchUp.query.limit, "3");
    assert.equal(catchUp.query.sessionID, "codex:thread-1");
    assert.equal(center.requests.every((request) => request.method === "GET"), true);

    const sent = await mcp.request(3, "tools/call", {
      name: "room",
      arguments: { action: "send", roomId: "r1", text: "answer", parentMessageId: "m1" },
      _meta: { threadId: "thread-1" },
    });
    assert.equal(sent.result.isError, false);
    const post = center.requests.find((request) => request.method === "POST" && request.path === "/rooms/r1/messages");
    assert.deepEqual(post.body, { sessionID: "codex:thread-1", text: "answer", parentMessageId: "m1" });
    assert.equal(center.requests.some((request) => request.path === "/read"), false);
  } finally {
    mcp.child.kill();
    await center.close();
  }
});

test("a tool call without Codex thread metadata is rejected instead of reusing a process identity", async () => {
  const center = await startCenter(() => undefined);
  const mcp = startMcp({ CHAT_ROOM_SERVER_URL: center.url });
  try {
    const call = await mcp.request(1, "tools/call", {
      name: "room",
      arguments: { action: "list" },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /_meta\.threadId/);
    assert.equal(center.requests.length, 0);
  } finally {
    mcp.child.kill();
    await center.close();
  }
});