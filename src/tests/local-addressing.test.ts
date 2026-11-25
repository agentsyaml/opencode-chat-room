import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "chat-room-local-addressing-"));
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
const originalCenterUrl = process.env.CHAT_ROOM_SERVER_URL;
const originalCenterToken = process.env.CHAT_ROOM_SERVER_TOKEN;
const originalWakeUrl = process.env.CHAT_ROOM_WAKE_SERVE_URL;
process.env.CHAT_ROOM_STATE_DIR = temp;
delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_SERVER_TOKEN;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
const { server } = await import("../../plugin.ts");
const { readHistory } = await import("../state/store.ts");

afterAll(async () => {
  if (originalStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = originalStateDir;
  if (originalCenterUrl === undefined) delete process.env.CHAT_ROOM_SERVER_URL;
  else process.env.CHAT_ROOM_SERVER_URL = originalCenterUrl;
  if (originalCenterToken === undefined) delete process.env.CHAT_ROOM_SERVER_TOKEN;
  else process.env.CHAT_ROOM_SERVER_TOKEN = originalCenterToken;
  if (originalWakeUrl === undefined) delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
  else process.env.CHAT_ROOM_WAKE_SERVE_URL = originalWakeUrl;
  await rm(temp, { recursive: true, force: true });
});

test("local mode rejects replies, dedupe ids and addressing reads", async () => {
  const hooks = await server({ serverUrl: new URL("http://v1.example"), directory: temp } as any);
  try {
    const room = hooks.tool?.room;
    if (!room) throw new Error("room tool missing");
    const context = { sessionID: "local-session" } as any;
    const created = String(await room.execute({ action: "create", name: "local" }, context));
    const roomId = /^Room (\S+) \(/.exec(created)?.[1];
    expect(roomId).toBeDefined();

    const plain = String(await room.execute({ action: "send", roomId, text: "hello" }, context));
    expect(plain).toContain("sent: hello");
    const before = await readHistory(roomId!);
    expect(before.messages.map((message) => message.text)).toEqual(["hello"]);
    expect(before.messages[0]!.answerToMessageID).toBeUndefined();

    const parent = String(await room.execute({ action: "send", roomId, text: "reply", parentMessageId: "m1" }, context));
    expect(parent).toBe("error: replies require central server mode (CHAT_ROOM_SERVER_URL)");
    const legacyReply = String(await room.execute({ action: "send", roomId, text: "reply", replyToMessageID: "m1" }, context));
    expect(legacyReply).toBe("error: replies require central server mode (CHAT_ROOM_SERVER_URL)");
    const dedupe = String(await room.execute({ action: "send", roomId, text: "retry", clientMessageID: "c1" }, context));
    expect(dedupe).toBe("error: clientMessageID requires central server mode (CHAT_ROOM_SERVER_URL)");

    const after = await readHistory(roomId!);
    expect(after.messages).toHaveLength(1);

    expect(String(await room.execute({ action: "get_message", roomId, messageId: "m1" }, context)))
      .toBe("error: get_message requires central server mode (CHAT_ROOM_SERVER_URL)");
    expect(String(await room.execute({ action: "catch_up", roomId }, context)))
      .toBe("error: catch_up requires central server mode (CHAT_ROOM_SERVER_URL)");
  } finally {
    await hooks.dispose?.();
  }
});