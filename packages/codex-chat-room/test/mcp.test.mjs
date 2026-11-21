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