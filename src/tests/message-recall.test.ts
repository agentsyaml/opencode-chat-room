import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

const root = mkdtempSync(path.join(tmpdir(), "chat-room-recall-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "initial");
const store = await import("../state/store.ts");
const { openStateDatabase } = await import("../state/sqlite-state.ts");
const { messageRecallRoutes } = await import("../../server/message-recall-routes");

afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(root, { recursive: true, force: true });
});

function useState(label: string): string {
  const directory = path.join(root, label);
  mkdirSync(directory, { recursive: true });
  process.env.CHAT_ROOM_STATE_DIR = directory;
  return directory;
}

async function makeRoom(label: string): Promise<string> {
  useState(label);
  return store.writeState((service, registry) => {
    const room = service.createRoom("Recall room", "Alice");
    for (const name of ["Alice", "Bob", "Carol"]) service.joinRoom(room.id, { id: name, name });
    registry[room.id] = {
      "session-alice": { serverUrl: "", apiPrefix: "/api", name: "Alice", membershipID: "membership-alice" },
      "session-bob": { serverUrl: "", apiPrefix: "/api", name: "Bob", membershipID: "membership-bob", host: "agent-host", protocol: "v1" },
      "session-carol": { serverUrl: "", apiPrefix: "/api", name: "Carol", membershipID: "membership-carol" },
    };
    return room.id;
  });
}

async function send(roomID: string, sessionID: string, text: string, isQuestion = false) {
  const result = await store.appendRoomMessage(roomID, sessionID, text, isQuestion);
  if (result.status !== "ok") throw new Error(`send failed: ${result.status}`);
  return result.message;
}

function ok<T extends { status: string }>(result: T): Extract<T, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<T, { status: "ok" }>;
}

test("migrates an existing messages table with recall columns", async () => {
  const directory = useState("migration");
  const file = path.join(directory, "chat-room.sqlite");
  const raw = new Database(file);
  raw.exec("CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL,sender_id TEXT NOT NULL,sender_session_id TEXT,text TEXT NOT NULL,created_at INTEGER NOT NULL,is_question INTEGER NOT NULL DEFAULT 0,answer_to TEXT,answered_by TEXT)");
  raw.close();
  const db = await openStateDatabase(file);
  const columns = (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((column) => column.name);
  expect(columns).toContain("recalled_at");
  expect(columns).toContain("recalled_by");
  expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_recall_versions'").get()).toBeTruthy();
});

test("author and human admin recall, tombstones, reveal, inbox exclusion", async () => {
  const roomID = await makeRoom("core");
  const secret = await send(roomID, "session-bob", "route secret");
  expect(await store.recallMessage(roomID, secret.id, "session-carol")).toEqual({ status: "forbidden" });
  expect(await store.recallMessage(roomID, secret.id, "session-stranger")).toEqual({ status: "member" });
  expect(await store.recallMessage(roomID, "missing-message", "session-alice")).toEqual({ status: "missing" });
  expect(await store.recallMessage("missing-room", secret.id, "session-alice")).toEqual({ status: "missing" });
  expect(await store.revealMessageContent(roomID, secret.id, "session-carol")).toEqual({ status: "hidden" });
  const recalled = ok(await store.recallMessage(roomID, secret.id, "session-alice"));
  expect(recalled).toMatchObject({ messageID: secret.id, recalledBy: "Alice", alreadyRecalled: false });
  expect(recalled.recalledAt).toBeGreaterThan(0);
  const page = await store.readHistory(roomID);
  expect(page.messages.find((message) => message.id === secret.id)).toMatchObject({ text: "", recalledAt: recalled.recalledAt, recalledBy: "Alice" });
  expect(page.recallVersion).toBe(1);
  const revealed = ok(await store.revealMessageContent(roomID, secret.id, "session-carol"));
  expect(revealed).toMatchObject({ text: "route secret", senderId: "Bob", recalledAt: recalled.recalledAt });
  expect(await store.revealMessageContent(roomID, secret.id, "session-stranger")).toEqual({ status: "member" });
  const inbox = await store.readInboxMessages("session-carol", roomID, false, 20, 0);
  expect(inbox.items.some((item) => item.id === secret.id)).toBe(false);
  expect(inbox.recallVersion).toBe(1);
  const unread = await store.readUnreadMessages(roomID, 0, 100, "session-carol", "Carol");
  expect(unread.items.some((item) => item.id === secret.id)).toBe(false);
  const again = ok(await store.recallMessage(roomID, secret.id, "session-alice"));
  expect(again).toMatchObject({ alreadyRecalled: true, recalledAt: recalled.recalledAt });
  expect((await store.readHistory(roomID)).recallVersion).toBe(1);
  await store.writeState((service) => service.getRoom(roomID));
  expect((await store.readHistory(roomID)).messages.find((message) => message.id === secret.id)?.text).toBe("");
  expect(ok(await store.revealMessageContent(roomID, secret.id, "session-bob")).text).toBe("route secret");
});

test("senders recall their own messages; an agent cannot recall another sender", async () => {
  const roomID = await makeRoom("authors");
  const aliceMessage = await send(roomID, "session-alice", "alice text");
  expect(await store.recallMessage(roomID, aliceMessage.id, "session-bob")).toEqual({ status: "forbidden" });
  const bobMessage = await send(roomID, "session-bob", "bob text");
  expect(ok(await store.recallMessage(roomID, bobMessage.id, "session-bob")).recalledBy).toBe("Bob");
  expect(ok(await store.revealMessageContent(roomID, bobMessage.id, "session-alice")).text).toBe("bob text");
});

test("recalled questions leave the open-question surface and reject answers", async () => {
  const roomID = await makeRoom("questions");
  const question = await send(roomID, "session-bob", "Is this recalled?", true);
  expect((await store.readQuestions(roomID)).map((item) => item.id)).toContain(question.id);
  ok(await store.recallMessage(roomID, question.id, "session-bob"));
  expect(await store.readQuestions(roomID)).toEqual([]);
  expect(await store.countOpenQuestions(roomID)).toBe(0);
  expect(await store.answerQuestion(roomID, question.id, "session-carol", "no")).toEqual({ status: "question" });
  expect(await store.readQuestionExcerpt(roomID, question.id)).toBeUndefined();
  const inbox = await store.readInboxMessages("session-carol", roomID, false, 20, 0);
  expect(inbox.items.some((item) => item.id === question.id)).toBe(false);
  const next = await send(roomID, "session-alice", "Still open?", true);
  expect((await store.readQuestions(roomID)).map((item) => item.id)).toEqual([next.id]);
  expect(ok(await store.answerQuestion(roomID, next.id, "session-carol", "yes")).answer.text).toBe("yes");
});

test("system messages cannot be recalled even by a human admin", async () => {
  const roomID = await makeRoom("system");
  const event = await store.writeState((service) => service.addEvent(roomID, "Alice joined the room"));
  expect(await store.recallMessage(roomID, event.id, "session-carol")).toEqual({ status: "forbidden" });
  expect(await store.recallMessage(roomID, event.id, "session-alice")).toEqual({ status: "forbidden" });
  const history = await store.readHistory(roomID);
  expect(history.messages.find((message) => message.id === event.id)).toMatchObject({ senderId: "system", text: "Alice joined the room" });
});

test("recall routes expose the HTTP contract", async () => {
  const roomID = await makeRoom("routes");
  const target = await send(roomID, "session-bob", "route content");
  const call = (method: string, path: string, body?: unknown) => messageRecallRoutes(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://localhost${path}`),
  );
  const recallPath = `/rooms/${roomID}/messages/${target.id}/recall`;
  expect((await call("POST", recallPath, { sessionID: "session-carol" }))?.status).toBe(403);
  expect((await call("POST", recallPath, {}))?.status).toBe(400);
  expect((await call("POST", `/rooms/${roomID}/messages/missing/recall`, { sessionID: "session-bob" }))?.status).toBe(404);
  const recalled = await call("POST", recallPath, { sessionID: "session-bob" });
  expect(recalled?.status).toBe(200);
  const payload = await recalled!.json() as { ok: boolean; messageID: string; recalledAt: number; recalledBy: string };
  expect(payload).toMatchObject({ ok: true, messageID: target.id, recalledBy: "Bob" });
  expect(typeof payload.recalledAt).toBe("number");
  const contentPath = `/rooms/${roomID}/messages/${target.id}/content`;
  expect((await call("GET", contentPath))?.status).toBe(400);
  const content = await call("GET", `${contentPath}?sessionID=session-carol`);
  expect(content?.status).toBe(200);
  expect(await content!.json()).toMatchObject({ messageID: target.id, text: "route content", senderId: "Bob", recalledAt: payload.recalledAt });
  expect((await call("GET", `${contentPath}?sessionID=session-stranger`))?.status).toBe(409);
  const other = await send(roomID, "session-alice", "still visible");
  const hidden = await call("GET", `/rooms/${roomID}/messages/${other.id}/content?sessionID=session-bob`);
  expect(hidden?.status).toBe(409);
  expect(await hidden!.json()).toMatchObject({ error: "message is not recalled" });
});