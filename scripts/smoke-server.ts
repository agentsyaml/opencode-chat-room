// Focused real-server smoke: ephemeral loopback listener, isolated state dir,
// token auth, then a clean close. Run with Bun, Node or Deno.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/platform/http-server.ts";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "chat-room-smoke-"));
process.env.CHAT_ROOM_STATE_DIR = sandbox;
process.env.CHAT_ROOM_SERVER_TOKEN = "smoke-token";
process.env.CHAT_ROOM_SERVER_HOST = "127.0.0.1";
process.env.CHAT_ROOM_SERVER_PORT = "4399";
process.env.CHAT_ROOM_WAKE_SERVE_URL = "";

const { default: config } = await import("../server/chat-server.ts");
const server = await startServer({ ...config, hostname: "127.0.0.1", port: 0, idleTimeout: 5, maxRequestBodySize: 1024 });
const origin = `http://127.0.0.1:${server.port}`;
const auth = { Authorization: "Bearer smoke-token" };
try {
  const chat = await fetch(`${origin}/chat`);
  assert.equal(chat.status, 200);
  assert.match(chat.headers.get("content-type") ?? "", /^text\/html/);
  assert.ok((await chat.text()).includes("<title"));

  assert.equal((await fetch(`${origin}/rooms`)).status, 401);

  const rooms = await fetch(`${origin}/rooms`, { headers: auth });
  assert.equal(rooms.status, 200);
  assert.ok(Array.isArray(await rooms.json()));

  const created = await fetch(`${origin}/rooms`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "smoke", ownerId: "smoke", sessionID: "smoke" }),
  });
  assert.equal(created.status, 201);
  const room = await created.json() as { id: string };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const uploaded = await fetch(`${origin}/rooms/${room.id}/resources`, {
    method: "POST",
    headers: { ...auth, "X-Session-ID": "smoke", "X-File-Name": "smoke.bin", "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  assert.equal(uploaded.status, 201);
  const resource = (await uploaded.json() as { resource: { id: string } }).resource;
  const contentURL = `${origin}/rooms/${room.id}/resources/${resource.id}/content`;
  const content = await fetch(contentURL, { headers: auth });
  assert.equal(content.status, 200);
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
  const ranged = await fetch(contentURL, { headers: { ...auth, Range: "bytes=1-2" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), bytes.subarray(1, 3));
  assert.equal(ranged.headers.get("content-range"), "bytes 1-2/5");

  const oversized = await fetch(`${origin}/rooms`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(2048) }),
  });
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /too large/);

  // The 30s long-poll path must survive the adapter's idle timer.
  const polled = await fetch(`${origin}/inbox?sessionID=smoke&timeout=100`, { headers: auth });
  assert.equal(polled.status, 200);
  assert.ok(Array.isArray((await polled.json() as { items: unknown[] }).items));
} finally {
  await server.close();
  await server.close();
  rmSync(sandbox, { recursive: true, force: true });
}
await assert.rejects(fetch(`${origin}/rooms`, { signal: AbortSignal.timeout(1000) }));
console.log(`smoke: ok (runtime ${typeof Bun === "undefined" ? "node/deno" : "bun"})`);
process.exit(0);