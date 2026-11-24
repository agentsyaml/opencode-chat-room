import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const root = mkdtempSync(path.join(tmpdir(), "chat-room-idempotency-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(root, { recursive: true, force: true });
});

const store = await import("../state/store.ts");

async function makeRoom() {
  const directory = path.join(root, "state");
  mkdirSync(directory, { recursive: true });
  process.env.CHAT_ROOM_STATE_DIR = directory;
  return store.writeState((service, registry) => {
    const room = service.createRoom("Idempotency", "Alice");
    service.joinRoom(room.id, { id: "Bob", name: "Bob" });
    registry[room.id] = {
      alice: { serverUrl: "", apiPrefix: "/api", name: "Alice", membershipID: "membership-alice" },
      bob: { serverUrl: "", apiPrefix: "/api", name: "Bob", membershipID: "membership-bob" },
    };
    return room.id;
  });
}

const texts = async (roomID: string): Promise<string[]> =>
  (await store.readState((service: { getRoom: (id: string) => { messages: Array<{ text: string }> } }) => service.getRoom(roomID)))
    .messages.map((message: { text: string }) => message.text);

test("a repeated client message id returns the first message instead of a twin", async () => {
  const roomID = await makeRoom();
  const first = await store.appendRoomMessage(roomID, "alice", "hello", false, "retry-1");
  const again = await store.appendRoomMessage(roomID, "alice", "hello", false, "retry-1");
  if (first.status !== "ok" || again.status !== "ok") throw new Error("send failed");
  expect(again.message.id).toBe(first.message.id);
  expect(again.duplicate).toBe(true);
  expect(await texts(roomID)).toEqual(["hello"]);

  const other = await store.appendRoomMessage(roomID, "alice", "hello", false, "retry-2");
  const plain = await store.appendRoomMessage(roomID, "alice", "hello", false);
  if (other.status !== "ok" || plain.status !== "ok") throw new Error("send failed");
  expect(other.message.id).not.toBe(first.message.id);
  expect(plain.message.id).not.toBe(first.message.id);
  expect(await texts(roomID)).toEqual(["hello", "hello", "hello"]);

  // Another session reusing the same id must not receive someone else's message.
  const otherSender = await store.appendRoomMessage(roomID, "bob", "hello", false, "retry-1");
  if (otherSender.status !== "ok") throw new Error("send failed");
  expect(otherSender.message.id).not.toBe(first.message.id);
  expect(otherSender.message.senderId).toBe("Bob");
  expect(await texts(roomID)).toEqual(["hello", "hello", "hello", "hello"]);
});

test("a repeated client message id on a reply returns the first reply", async () => {
  const roomID = await makeRoom();
  const target = await store.appendRoomMessage(roomID, "alice", "question?", false);
  if (target.status !== "ok") throw new Error("send failed");
  const first = await store.sendReply(roomID, target.message.id, "bob", "answer", "reply-1");
  const again = await store.sendReply(roomID, target.message.id, "bob", "answer", "reply-1");
  if (first.status !== "ok" || again.status !== "ok") throw new Error("reply failed");
  expect(again.message.id).toBe(first.message.id);
  expect(again.duplicate).toBe(true);
  expect(await texts(roomID)).toEqual(["question?", "answer"]);
});