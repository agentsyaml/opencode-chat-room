// The HTTP surface of image messages: a member may upload, only bytes that
// look like the declared type are stored, and a message may reference them.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The server module reads its state directory at import time, so this file has
// to run in a process of its own: sharing the module graph with another test
// that points the same singleton at a different directory makes both fail.
if (process.env.CHAT_ROOM_IMAGE_TEST_CHILD !== "1") {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-room-image-http-"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    env: { ...process.env, CHAT_ROOM_IMAGE_TEST_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_TOKEN: "image-test-token",
      CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_WAKE_SERVE_URL: "" }, stdout: "pipe", stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`);
  test("image attachment routes pass in an isolated process", () => { expect(code).toBe(0); });
} else {

const stateDir = mkdtempSync(path.join(tmpdir(), "chat-room-image-http-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
process.env.XDG_CONFIG_HOME = path.join(stateDir, "config");
process.env.CHAT_ROOM_SERVER_TOKEN = "image-test-token";

const { default: server } = await import("../server/chat-server");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

afterAll(() => {
  delete process.env.CHAT_ROOM_STATE_DIR;
  delete process.env.CHAT_ROOM_SERVER_TOKEN;
});

function call(pathname: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return server.fetch(new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      Authorization: "Bearer image-test-token",
      ...(body instanceof Uint8Array ? {} : body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body),
  }));
}

async function room(name: string, sessionID = "member-1") {
  const created = await call("/rooms", "POST", { name, ownerId: "alice", sessionID });
  expect(created.status).toBe(201);
  return (await created.json() as { id: string }).id;
}

describe("attachment routes", () => {
  test("a member uploads, and the bytes read back with their type", async () => {
    const roomID = await room("pictures");
    const uploaded = await call(`/attachments/${roomID}?sessionID=member-1`, "POST", PNG,
      { "Content-Type": "image/png" });
    expect(uploaded.status).toBe(201);
    const ref = await uploaded.json() as { id: string; mime: string; bytes: number };
    expect(ref).toMatchObject({ mime: "image/png", bytes: PNG.byteLength });
    const read = await call(`/attachments/${roomID}/${ref.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);
  });

  test("a non-member cannot upload, and a token-less request is refused", async () => {
    const roomID = await room("private");
    const outsider = await call(`/attachments/${roomID}?sessionID=someone-else`, "POST", PNG,
      { "Content-Type": "image/png" });
    expect(outsider.status).toBe(403);
    const anonymous = await server.fetch(new Request(`http://localhost/attachments/${roomID}?sessionID=member-1`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: PNG,
    }));
    expect(anonymous.status).toBe(401);
  });

  test("a body that is not the declared image is refused", async () => {
    const roomID = await room("fake");
    const uploaded = await call(`/attachments/${roomID}?sessionID=member-1`, "POST",
      new TextEncoder().encode("not an image"), { "Content-Type": "image/png" });
    expect(uploaded.status).toBe(400);
    const wrongType = await call(`/attachments/${roomID}?sessionID=member-1`, "POST", PNG,
      { "Content-Type": "image/gif" });
    expect(wrongType.status).toBe(400);
  });

  test("a message carries the ids and comes back with them", async () => {
    const roomID = await room("send");
    const ref = await (await call(`/attachments/${roomID}?sessionID=member-1`, "POST", PNG,
      { "Content-Type": "image/png" })).json() as { id: string };
    const sent = await call(`/rooms/${roomID}/messages`, "POST",
      { sessionID: "member-1", text: "", attachments: [ref.id] });
    expect(sent.status).toBe(201);
    const body = await sent.json() as { messages: Array<{ text: string; attachments?: Array<{ id: string }> }> };
    expect(body.messages.at(-1)?.attachments?.[0]?.id).toBe(ref.id);
  });

  test("an unknown image id, or more than two, is refused", async () => {
    const roomID = await room("limits");
    const missing = await call(`/rooms/${roomID}/messages`, "POST",
      { sessionID: "member-1", text: "x", attachments: ["00000000-0000-4000-8000-000000000000"] });
    expect(missing.status).toBe(400);
    const tooMany = await call(`/rooms/${roomID}/messages`, "POST",
      { sessionID: "member-1", text: "x", attachments: ["a", "b", "c"] });
    expect(tooMany.status).toBe(400);
  });

  test("deleting the room removes its image files", async () => {
    const roomID = await room("cleanup");
    const ref = await (await call(`/attachments/${roomID}?sessionID=member-1`, "POST", PNG,
      { "Content-Type": "image/png" })).json() as { id: string };
    const removed = await call(`/rooms/${roomID}`, "DELETE", { sessionID: "member-1" });
    expect(removed.status).toBe(200);
    expect((await call(`/attachments/${roomID}/${ref.id}`)).status).toBe(404);
  });
});
}
