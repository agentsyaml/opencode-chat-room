import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import readline from "node:readline";
import { roomPayload, startCenter } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a joined session receives a queued Codex message and advances the watermark", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-chat-room-"));
  const argvFile = path.join(dir, "argv.txt");
  const bin = path.join(dir, "fake-codex.sh");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\nexit 0\n`, { mode: 0o755 });

  let marked = 0;
  const center = await startCenter(({ method, path: route, body }) => {
    if (method === "POST" && route === "/rooms/r1/join") return [201, roomPayload()];
    if (method === "POST" && route === "/queued") { marked = body.ts; return [200, { ok: true }]; }
    if (method === "GET" && route === "/inbox") {
      const items = marked > 0 ? [] : [
        { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "alice", text: "please review", createdAt: 500 },
      ];
      return [200, { member: true, items, queuedTs: { r1: marked }, hasMore: false }];
    }
    return undefined;
  });

  const child = spawn(process.execPath, ["plugin/mcp-server.mjs"], {
    cwd: root,
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, CHAT_ROOM_SERVER_URL: center.url, CHAT_ROOM_CODEX_BIN: bin },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    responses.set(message.id, message);
  });
  const call = (id, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`);

  try {
    call(1, { name: "room", arguments: { action: "join", roomId: "r1", name: "alice" }, _meta: { threadId: "thread-9" } });
    let argv = "";
    for (let i = 0; i < 100 && !argv; i++) {
      await sleep(50);
      argv = await readFile(argvFile, "utf8").catch(() => "");
    }
    assert.ok(argv, "fake codex queue was not invoked");
    const args = argv.split("\0").slice(0, -1);
    assert.deepEqual(args.slice(0, 4), ["queue", "--thread", "thread-9", "--message"]);
    assert.match(args[4], /please review/);
    assert.equal(args.at(-1), "--resume");
    for (let i = 0; i < 100 && marked !== 500; i++) await sleep(50);
    assert.equal(marked, 500);
    assert.equal(center.requests.find((r) => r.path === "/queued").body.sessionID, "codex:thread-9");
    assert.ok(responses.has(1));
  } finally {
    child.kill();
    await center.close();
  }
});

test("an approved pending join reaches its Codex thread without join_status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-chat-room-"));
  const argvFile = path.join(dir, "argv.txt");
  const bin = path.join(dir, "fake-codex.sh");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\nexit 0\n`, { mode: 0o755 });
  let approved = false;
  const center = await startCenter(({ method, path: route }) => {
    if (method === "POST" && route === "/rooms/r1/join") return [202, { status: "pending" }];
    if (method === "GET" && route === "/inbox") {
      // The first poll runs while the request is pending; the next one sees the
      // approval event that the server now leaves unread for this session.
      if (!approved) { approved = true; return [200, { member: false, hasMore: false, queuedTs: {}, items: [] }]; }
      return [200, { member: true, hasMore: false, queuedTs: {}, items: [
        { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "system", text: "alice joined the room", createdAt: 600 },
      ] }];
    }
    if (method === "POST" && route === "/queued") return [200, { ok: true }];
    return undefined;
  });
  const child = spawn(process.execPath, ["plugin/mcp-server.mjs"], {
    cwd: root,
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, CHAT_ROOM_SERVER_URL: center.url, CHAT_ROOM_CODEX_BIN: bin },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const call = (id, arguments_) => child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "room", arguments: arguments_, _meta: { threadId: "thread-pending" } },
  })}\n`);
  try {
    call(1, { action: "join", roomId: "r1", name: "alice" });
    let argv = "";
    for (let i = 0; i < 100 && !argv; i++) {
      await sleep(50);
      argv = await readFile(argvFile, "utf8").catch(() => "");
    }
    assert.match(argv, /alice joined the room/);
  } finally {
    child.kill();
    await center.close();
  }
});
