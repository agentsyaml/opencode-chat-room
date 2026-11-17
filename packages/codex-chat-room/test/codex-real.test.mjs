// Opt-in protocol test against the installed Codex app-server.
// Run with: CODEX_REAL_TEST=1 npm run test:real
// It installs this plugin into a throwaway CODEX_HOME, drives a real
// `codex app-server` with a local mock model, and asserts the MCP call carries
// Codex's thread id and that the tool result returns to the model.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startCenter } from "./helpers.mjs";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const enabled = process.env.CODEX_REAL_TEST === "1";
const skip = !enabled
  ? "set CODEX_REAL_TEST=1 to run against the installed Codex"
  : typeof WebSocket !== "function"
    ? "Node 22+ is required for the global WebSocket client"
    : false;

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function completed(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMockModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    requests.push(raw ? JSON.parse(raw) : {});
    const input = JSON.stringify(requests.at(-1).input ?? []);
    if (!input.includes("function_call_output")) {
      sse(res, [
        { type: "response.created", response: { id: "r1" } },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call-1", namespace: "mcp__chat_room", name: "room", arguments: "{\"action\":\"list\"}" },
        },
        completed("r1"),
      ]);
      return;
    }
    sse(res, [
      { type: "response.created", response: { id: "r2" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "msg-1", content: [{ type: "output_text", text: "done" }] } },
      completed("r2"),
    ]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("real Codex sends _meta.threadId, runs the plugin, and accepts a queued message", { skip, timeout: 90000 }, async () => {
  const codex = process.env.CODEX_BIN || "codex";
  await run(codex, ["--version"]);
  const base = await mkdtemp(path.join(os.tmpdir(), "codex-chat-room-real-"));
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, CODEX_HOME: home };
  const central = await startCenter(({ method, path: route }) => {
    if (method === "GET" && route === "/rooms") return [200, []];
    return undefined;
  });
  const model = await startMockModel();
  const port = await freePort();
  let app;
  let stderr = "";
  try {
    const added = await run(codex, ["plugin", "marketplace", "add", packageRoot], { env });
    assert.match(added.stdout, /Added marketplace/);
    const installed = await run(codex, ["plugin", "add", "chat-room@codex-chat-room"], { env });
    assert.match(installed.stdout, /Added plugin/);
    assert.match(installed.stdout, new RegExp(`Installed plugin root: ${await realpath(home)}`));
    const cacheRoot = path.join(home, "plugins/cache/codex-chat-room/chat-room");
    const [version] = await readdir(cacheRoot);
    const cacheMcp = JSON.parse(await readFile(path.join(cacheRoot, version, ".mcp.json"), "utf8"));
    assert.equal(cacheMcp.mcpServers.chat_room.cwd, ".");
    await stat(path.join(cacheRoot, version, "mcp-server.mjs"));

    const config = await readFile(path.join(home, "config.toml"), "utf8");
    await writeFile(path.join(home, "config.toml"), `model = "mock-model"
model_provider = "mock"
approval_policy = "on-request"

[model_providers.mock]
name = "mock"
base_url = "${model.url}"
env_key = "MOCK_API_KEY"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0

${config}`);

    const wsUrl = `ws://127.0.0.1:${port}`;
    app = spawn(codex, ["app-server", "--listen", wsUrl], {
      cwd: base,
      env: { ...env, MOCK_API_KEY: "dummy", CHAT_ROOM_SERVER_URL: central.url, CHAT_ROOM_DELIVERY: "0", RUST_LOG: process.env.REAL_TEST_LOG || "error" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    app.stderr.on("data", (chunk) => { stderr += String(chunk); });

    let ws;
    for (let i = 0; i < 100 && !ws; i++) {
      try {
        ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      } catch {
        ws = undefined;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(ws, `app-server did not listen: ${stderr.slice(-3000)}`);

    const pending = new Map();
    const notifications = [];
    let nextId = 0;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && message.method) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: {}, meta: null } }));
      } else if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        notifications.push(message);
      }
    };
    const rpc = (method, params) => new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

    await rpc("initialize", { clientInfo: { name: "codex-chat-room-test", title: "codex-chat-room-test", version: "0.0.0" } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: null }));
    const started = await rpc("thread/start", { cwd: base, approvalPolicy: "on-request" });
    const threadId = started.result?.thread?.id;
    assert.ok(threadId, `thread/start failed: ${JSON.stringify(started)}`);
    await rpc("turn/start", { threadId, input: [{ type: "text", text: "List rooms." }] });

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !notifications.some((n) => n.method === "turn/completed")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const listing = central.requests.find((request) => request.path === "/rooms");
    assert.ok(listing, `the plugin MCP server never called the fake central server: ${stderr.slice(-3000)}`);
    assert.equal(listing.query.sessionID, `codex:${threadId}`);

    const tool = notifications
      .map((n) => n.params?.item)
      .find((item) => item?.type === "mcpToolCall" && item.status === "completed");
    assert.ok(tool, `MCP tool call did not complete: ${JSON.stringify(notifications).slice(-2000)}`);
    assert.equal(tool.result.content[0].text, "no rooms yet");

    assert.equal(model.requests.length, 2, "expected one follow-up model request with the tool output");
    const followUp = JSON.stringify(model.requests[1].input);
    assert.match(followUp, /function_call_output/);
    assert.match(followUp, /no rooms yet/);

    const queued = await run(
      codex,
      ["queue", "--thread", threadId, "--message", "queued-from-real-test", "--resume", "--remote", wsUrl],
      { env, timeout: 30000 },
    );
    assert.match(queued.stdout, /Queued message/);
    const queueDeadline = Date.now() + 30000;
    while (Date.now() < queueDeadline && !model.requests.some((request) => JSON.stringify(request.input).includes("queued-from-real-test"))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(
      model.requests.some((request) => JSON.stringify(request.input).includes("queued-from-real-test")),
      "the queued message never started a turn in the app-server",
    );
  } finally {
    app?.kill("SIGKILL");
    if (app && app.exitCode === null) await new Promise((resolve) => app.once("exit", resolve));
    await central.close();
    await model.close();
    await rm(base, { recursive: true, force: true });
  }
});