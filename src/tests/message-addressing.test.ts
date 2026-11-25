import { mkdtempSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

// The server reads its bearer token and state directory at import time, so run
// the fixtures in a child process with an isolated center.
const childMode = process.env.CHAT_ROOM_ADDRESSING_CHILD === "1";
if (!childMode) {
  test("runs message addressing fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "message-addressing-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env,
        CHAT_ROOM_ADDRESSING_CHILD: "1",
        CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"),
        XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        CHAT_ROOM_SERVER_TOKEN: "addressing-test-token",
        CHAT_ROOM_SERVER_URL: "",
        CHAT_ROOM_WAKE_SERVE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${stdout}${stderr}`);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited.catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
} else {
  const token = "addressing-test-token";
  const { default: server } = await import("../../server/chat-server");
  const store = await import("../state/store.ts");

  type Sent = { id: string; seq: number; text: string; createdAt: number; senderId: string; answerToMessageID?: string; isQuestion?: boolean };
  type CatchUp = {
    messages: Array<Record<string, unknown> & { id: string; seq: number; text: string | null; recalled: boolean }>;
    nextCursor: number;
    hasMore: boolean;
    unreadMentions: Array<{ id: string; seq: number }>;
    unreadMentionCount: number;
    unansweredQuestions: Array<{ id: string; seq: number }>;
    unansweredQuestionCount: number;
  };

  function call(route: string, method = "GET", body?: unknown, auth = true) {
    return server.fetch(new Request(`http://local${route}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }

  async function createRoom(name: string, policy?: "open" | "approval"): Promise<string> {
    const response = await call("/rooms", "POST", { name, ownerId: "Alice", sessionID: "alice-session", ...(policy ? { joinPolicy: policy } : {}) });
    expect(response.status).toBe(201);
    return (await response.json() as { id: string }).id;
  }

  async function join(roomID: string, sessionID: string, name: string): Promise<Response> {
    return call(`/rooms/${roomID}/join`, "POST", { sessionID, participantId: name, participantName: name });
  }

  async function send(roomID: string, sessionID: string, text: string, extra: Record<string, unknown> = {}) {
    const response = await call(`/rooms/${roomID}/messages`, "POST", { sessionID, text, ...extra });
    const body = await response.json() as { messages?: Sent[]; error?: string };
    return { response, body, message: body.messages?.at(-1) };
  }

  async function seed(roomID: string, count: number): Promise<void> {
    await store.writeState((service) => {
      for (let index = 0; index < count; index++) service.sendMessage(roomID, "Alice", `seed-${index}`, "alice-session");
    });
  }

  const catchUp = async (roomID: string, sessionID: string, query = "") =>
    await call(`/rooms/${roomID}/catch-up?sessionID=${sessionID}${query ? `&${query}` : ""}`);

  // A real process restart reads the same SQLite file; a freshly spawned Bun
  // process proves the persisted seq cursor survives without in-memory state.
  async function catchUpAfterRestart(roomID: string, sessionID: string, cursor: number): Promise<CatchUp> {
    const scriptPath = path.join(process.env.CHAT_ROOM_STATE_DIR!, `resume-${randomUUID()}.ts`);
    const serverPath = path.resolve(import.meta.dir, "../../server/chat-server.ts");
    await Bun.write(scriptPath, `const { default: server } = await import(${JSON.stringify(serverPath)});
const response = await server.fetch(new Request(${JSON.stringify(`http://local/rooms/${roomID}/catch-up?sessionID=${sessionID}&afterSeq=${cursor}&limit=10`)}, { headers: { Authorization: "Bearer ${token}" } }));
console.log(JSON.stringify(await response.json()));
process.exit(0);`);
    const child = Bun.spawn([process.execPath, scriptPath], {
      env: { ...process.env, CHAT_ROOM_STATE_DIR: process.env.CHAT_ROOM_STATE_DIR!, CHAT_ROOM_SERVER_TOKEN: token, CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_WAKE_SERVE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${stdout}${stderr}`);
    const payload = stdout.trim().split("\n").reverse().find((line) => line.startsWith("{"));
    if (!payload) throw new Error(`restart produced no JSON: ${stdout}${stderr}`);
    const parsed = JSON.parse(payload) as CatchUp;
    if (!Array.isArray(parsed.messages)) throw new Error(`unexpected restart payload: ${payload}`);
    return parsed;
  }

  describe.serial("message addressing", () => {
    test("rejects a missing or wrong server token with 401", async () => {
      const roomID = await createRoom("auth");
      expect((await call(`/rooms/${roomID}/catch-up?sessionID=alice-session`, "GET", undefined, false)).status).toBe(401);
      expect((await call(`/rooms/${roomID}/catch-up?sessionID=alice-session`, "GET", undefined, false)).status).toBe(401);
      const wrong = await server.fetch(new Request(`http://local/rooms/${roomID}/catch-up?sessionID=alice-session`, { headers: { Authorization: "Bearer wrong" } }));
      expect(wrong.status).toBe(401);
      const missing = await server.fetch(new Request(`http://local/rooms/${roomID}/messages/missing?sessionID=alice-session`));
      expect(missing.status).toBe(401);
    });

    test("V01 returns the stable message fields", async () => {
      const roomID = await createRoom("v01");
      expect((await join(roomID, "bob-session", "Bob")).status).toBe(201);
      const resourceID = "123e4567-e89b-42d3-a456-426614174000";
      const sent = await send(roomID, "bob-session", `hello [[resource:${resourceID}]]`);
      expect(sent.response.status).toBe(201);
      const response = await call(`/rooms/${roomID}/messages/${sent.message!.id}?sessionID=alice-session`);
      expect(response.status).toBe(200);
      const view = await response.json();
      expect(view).toEqual({
        id: sent.message!.id,
        roomId: roomID,
        seq: sent.message!.seq,
        senderId: "Bob",
        senderName: "Bob",
        text: `hello [[resource:${resourceID}]]`,
        createdAt: sent.message!.createdAt,
        isQuestion: false,
        parentMessageId: null,
        answeredByMessageId: null,
        recalled: false,
        resourceIDs: [resourceID],
      });
      // Catch-up serves the identical view shape.
      const page = await (await catchUp(roomID, "alice-session")).json() as CatchUp;
      expect(page.messages.at(-1)).toEqual(view);
    });

    test("V02 recalled messages are tombstones without text or resources", async () => {
      const roomID = await createRoom("v02");
      expect((await join(roomID, "bob-session", "Bob")).status).toBe(201);
      const resourceID = "123e4567-e89b-42d3-a456-426614174001";
      const sent = await send(roomID, "bob-session", `secret [[resource:${resourceID}]]`);
      expect((await call(`/rooms/${roomID}/messages/${sent.message!.id}/recall`, "POST", { sessionID: "bob-session" })).status).toBe(200);
      const response = await call(`/rooms/${roomID}/messages/${sent.message!.id}?sessionID=alice-session`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        id: sent.message!.id, roomId: roomID, seq: sent.message!.seq, senderId: "Bob",
        recalled: true, recalledBy: "Bob", text: null, unavailable: "recalled", resourceIDs: [],
      });
      expect(typeof body.recalledAt).toBe("number");
      expect(JSON.stringify(body)).not.toContain("secret");
      expect(JSON.stringify(body)).not.toContain(resourceID);

      const page = await (await catchUp(roomID, "alice-session")).json() as CatchUp;
      expect(page.messages.find((message) => message.id === sent.message!.id)).toMatchObject({ text: null, recalled: true, resourceIDs: [] });
      // A tombstone never becomes an unread notification.
      const inbox = await store.readInboxMessages("alice-session", roomID, false, 20, 0);
      expect(inbox.items.some((item) => item.id === sent.message!.id)).toBe(false);
    });

    test("V03 and V04 hide wrong rooms and unknown messages behind one 404", async () => {
      const roomA = await createRoom("v03-a");
      const roomB = await createRoom("v03-b");
      expect((await join(roomA, "bob-session", "Bob")).status).toBe(201);
      expect((await join(roomB, "carol-session", "Carol")).status).toBe(201);
      const sent = await send(roomA, "bob-session", "only in A");
      const unknown = await call(`/rooms/${roomA}/messages/missing?sessionID=alice-session`);
      expect(await unknown.clone().json()).toEqual({ error: "not found" });
      expect(unknown.status).toBe(404);
      // A message read through the wrong room path.
      const wrongPath = await call(`/rooms/${roomB}/messages/${sent.message!.id}?sessionID=carol-session`);
      expect(wrongPath.status).toBe(404);
      expect(await wrongPath.json()).toEqual({ error: "not found" });
      // A member of another room cannot read room A.
      const wrongMember = await call(`/rooms/${roomA}/messages/${sent.message!.id}?sessionID=carol-session`);
      expect(wrongMember.status).toBe(404);
      expect(await wrongMember.json()).toEqual({ error: "not found" });
      // Catch-up never reveals another room.
      for (const route of [
        `/rooms/${roomA}/catch-up?sessionID=carol-session`,
        `/rooms/${randomUUID()}/catch-up?sessionID=alice-session`,
      ]) {
        const response = await call(route);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
      }
    });

    test("V05 non-member, pending, and kicked sessions see identical 404s on addressing paths", async () => {
      const roomID = await createRoom("v05");
      expect((await join(roomID, "bob-session", "Bob")).status).toBe(201);
      const target = await send(roomID, "alice-session", "target");
      const replyPath = `/rooms/${roomID}/messages`;
      const reply = (sessionID: string) => call(replyPath, "POST", { sessionID, text: "reply", parentMessageId: target.message!.id });
      const paths = (sessionID: string) => [
        call(`/rooms/${roomID}/messages/${target.message!.id}?sessionID=${sessionID}`),
        call(`/rooms/${roomID}/catch-up?sessionID=${sessionID}`),
        reply(sessionID),
      ];
      const assert404 = async (sessionID: string) => {
        for (const response of await Promise.all(paths(sessionID))) {
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "not found" });
        }
      };
      await assert404("outsider-session");

      const approvalRoom = await createRoom("v05-approval", "approval");
      expect((await join(approvalRoom, "pending-session", "Pending")).status).toBe(202);
      const approvalTarget = await send(approvalRoom, "alice-session", "approval target");
      for (const response of await Promise.all([
        call(`/rooms/${approvalRoom}/messages/${approvalTarget.message!.id}?sessionID=pending-session`),
        call(`/rooms/${approvalRoom}/catch-up?sessionID=pending-session`),
        call(`/rooms/${approvalRoom}/messages`, "POST", { sessionID: "pending-session", text: "reply", parentMessageId: approvalTarget.message!.id }),
      ])) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
      }

      expect((await call(`/rooms/${roomID}/kick`, "POST", { sessionID: "alice-session", targetSessionID: "bob-session" })).status).toBe(200);
      await assert404("bob-session");
    });

    test("V06 and V07 parent alias stores one immutable answer_to and rejects recalled parents", async () => {
      const roomID = await createRoom("v06");
      expect((await join(roomID, "bob-session", "Bob")).status).toBe(201);
      const original = await send(roomID, "bob-session", "parent");
      const reply = await send(roomID, "alice-session", "reply", { parentMessageId: original.message!.id });
      expect(reply.response.status).toBe(201);
      expect(reply.message).toMatchObject({ answerToMessageID: original.message!.id, text: "reply" });
      const replyToReply = await send(roomID, "bob-session", "nested", { parentMessageId: reply.message!.id });
      expect(replyToReply.response.status).toBe(201);
      expect(replyToReply.message).toMatchObject({ answerToMessageID: reply.message!.id });
      // A reply is itself a valid parent; the parent's answer link is immutable.
      expect((await store.readMessage(roomID, reply.message!.id))?.answerToMessageID).toBe(original.message!.id);

      const viewed = await (await call(`/rooms/${roomID}/messages/${reply.message!.id}?sessionID=bob-session`)).json() as Record<string, unknown>;
      expect(viewed).toMatchObject({ parentMessageId: original.message!.id, answeredByMessageId: null });
      // The web history shape still carries the same link.
      const history = await (await call(`/rooms/${roomID}/history?limit=20`)).json() as { messages: Sent[] };
      expect(history.messages.find((message) => message.id === reply.message!.id)).toMatchObject({ answerToMessageID: original.message!.id });

      expect((await call(`/rooms/${roomID}/messages/${original.message!.id}/recall`, "POST", { sessionID: "bob-session" })).status).toBe(200);
      const recalledReply = await send(roomID, "alice-session", "late", { parentMessageId: original.message!.id });
      expect(recalledReply.response.status).toBe(409);
      expect(recalledReply.body.error).toContain("recalled");
      expect((await send(roomID, "alice-session", "late", { replyToMessageID: original.message!.id })).response.status).toBe(409);
    });

    test("V08 paginates a 100+ backlog without duplicates or loss", async () => {
      const roomID = await createRoom("v08");
      await seed(roomID, 137);
      const expected = (await store.readHistory(roomID, undefined, 200)).messages;
      expect(expected).toHaveLength(137);
      const before = await store.readState((_svc, registry) => ({ ...registry[roomID]!["alice-session"] }));
      const collected: Array<{ id: string; seq: number }> = [];
      let cursor = 0;
      for (let page = 0; page < 20; page++) {
        const response = await catchUp(roomID, "alice-session", `afterSeq=${cursor}&limit=25`);
        expect(response.status).toBe(200);
        const body = await response.json() as CatchUp;
        expect(body.messages.length).toBeLessThanOrEqual(25);
        expect(body.nextCursor).toBe(body.messages.at(-1)?.seq ?? cursor);
        if (body.messages.length) expect(body.messages[0]!.seq).toBeGreaterThan(cursor);
        collected.push(...body.messages.map((message) => ({ id: message.id, seq: message.seq })));
        if (!body.hasMore) break;
        cursor = body.nextCursor;
      }
      expect(collected.map((message) => message.seq)).toEqual([...collected.map((message) => message.seq)].sort((left, right) => left - right));
      expect(new Set(collected.map((message) => message.id)).size).toBe(collected.length);
      expect(collected.map((message) => message.id)).toEqual(expected.map((message) => message.id));
      // Catch-up is read-only: paging never advances the read watermark.
      expect(await store.readState((_svc, registry) => ({ ...registry[roomID]!["alice-session"] }))).toEqual(before);
    });

    test("V09 resumes from the same seq cursor after a process restart", async () => {
      const roomID = await createRoom("v09");
      for (const text of ["one", "two", "three"]) expect((await send(roomID, "alice-session", text)).response.status).toBe(201);
      const first = await (await catchUp(roomID, "alice-session", "limit=1")).json() as CatchUp;
      expect(first.messages).toHaveLength(1);
      const restarted = await catchUpAfterRestart(roomID, "alice-session", first.nextCursor);
      expect(restarted.messages.map((message) => message.text)).toEqual(["two", "three"]);
      expect(restarted.nextCursor).toBe(restarted.messages.at(-1)!.seq);
      expect(restarted.hasMore).toBe(false);
    });

    test("V10 scopes mentions to the page and reports room-wide open questions", async () => {
      const roomID = await createRoom("v10");
      expect((await join(roomID, "bob-session", "Bob")).status).toBe(201);
      const mention1 = await send(roomID, "bob-session", "<at>@Alice</at> first");
      const ordinary = await send(roomID, "bob-session", "ordinary");
      const mention2 = await send(roomID, "bob-session", "@all second");
      const question = await send(roomID, "bob-session", "open question", { isQuestion: true });
      const recalledMention = await send(roomID, "bob-session", "<at>@Alice</at> recalled");
      const recalledQuestion = await send(roomID, "bob-session", "recalled question", { isQuestion: true });
      expect((await call(`/rooms/${roomID}/messages/${recalledMention.message!.id}/recall`, "POST", { sessionID: "bob-session" })).status).toBe(200);
      expect((await call(`/rooms/${roomID}/messages/${recalledQuestion.message!.id}/recall`, "POST", { sessionID: "bob-session" })).status).toBe(200);

      const all = await (await catchUp(roomID, "alice-session", "limit=200")).json() as CatchUp;
      expect(all.unreadMentions).toEqual([
        { id: mention1.message!.id, seq: mention1.message!.seq },
        { id: mention2.message!.id, seq: mention2.message!.seq },
      ]);
      expect(all.unreadMentionCount).toBe(2);
      expect(all.unansweredQuestions).toEqual([{ id: question.message!.id, seq: question.message!.seq }]);
      expect(all.unansweredQuestionCount).toBe(1);
      expect(all.unreadMentions.some((mention) => mention.id === recalledMention.message!.id)).toBe(false);
      expect(all.unansweredQuestions.some((item) => item.id === recalledQuestion.message!.id)).toBe(false);
      expect(all.messages.find((message) => message.id === ordinary.message!.id)?.recalled).toBe(false);

      const page = await (await catchUp(roomID, "alice-session", `afterSeq=${mention1.message!.seq}&limit=200`)).json() as CatchUp;
      expect(page.unreadMentions).toEqual([{ id: mention2.message!.id, seq: mention2.message!.seq }]);
      // Open questions are room-wide and survive a cursor that skipped them.
      expect(page.unansweredQuestions).toEqual([{ id: question.message!.id, seq: question.message!.seq }]);
    });

    test("V25 the same clientMessageID and parent retry creates one reply", async () => {
      const roomID = await createRoom("v25");
      const target = await send(roomID, "alice-session", "target");
      const first = await send(roomID, "alice-session", "retry me", { parentMessageId: target.message!.id, clientMessageID: "reply-retry-1" });
      const again = await send(roomID, "alice-session", "retry me", { parentMessageId: target.message!.id, clientMessageID: "reply-retry-1" });
      expect(first.response.status).toBe(201);
      expect(again.response.status).toBe(201);
      expect(again.message!.id).toBe(first.message!.id);
      const history = await (await call(`/rooms/${roomID}/history?limit=20`)).json() as { messages: Sent[] };
      expect(history.messages.filter((message) => message.id === first.message!.id)).toHaveLength(1);
      expect(history.messages.filter((message) => message.answerToMessageID === target.message!.id)).toHaveLength(1);
    });

    test("V26 a missing or cross-room parent is a 404", async () => {
      const roomID = await createRoom("v26");
      const otherRoom = await createRoom("v26-other");
      const foreign = await send(otherRoom, "alice-session", "foreign");
      for (const parentMessageId of ["missing", foreign.message!.id]) {
        const response = await call(`/rooms/${roomID}/messages`, "POST", { sessionID: "alice-session", text: "bad parent", parentMessageId });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "reply target not found in room" });
      }
      const plain = await send(roomID, "alice-session", "plain");
      expect(plain.response.status).toBe(201);
      expect(plain.message).not.toHaveProperty("answerToMessageID");
    });

    test("V27 rejects invalid catch-up values and bounds the page", async () => {
      const roomID = await createRoom("v27");
      await seed(roomID, 250);
      for (const value of ["-1", "1.5", "abc", "", "1e3", "9007199254740992"]) {
        expect((await catchUp(roomID, "alice-session", `afterSeq=${encodeURIComponent(value)}`)).status).toBe(400);
      }
      for (const value of ["0", "201", "abc", "1.5", ""]) {
        expect((await catchUp(roomID, "alice-session", `limit=${encodeURIComponent(value)}`)).status).toBe(400);
      }
      const bounded = await (await catchUp(roomID, "alice-session", "limit=200")).json() as CatchUp;
      expect(bounded.messages).toHaveLength(200);
      expect(bounded.hasMore).toBe(true);
      expect(bounded.nextCursor).toBe(bounded.messages.at(-1)!.seq);
      const defaulted = await (await catchUp(roomID, "alice-session")).json() as CatchUp;
      expect(defaulted.messages).toHaveLength(50);
      expect(defaulted.hasMore).toBe(true);
      // An empty page echoes the input cursor so a client keeps a stable position.
      const tail = (await store.readHistory(roomID, undefined, 1)).messages.at(-1)!.seq;
      const afterTail = await (await catchUp(roomID, "alice-session", `afterSeq=${tail}`)).json() as CatchUp;
      expect(afterTail.messages).toEqual([]);
      expect(afterTail.nextCursor).toBe(tail);
      expect(afterTail.hasMore).toBe(false);
    });

    test("V27 caps unanswered question refs while reporting the total", async () => {
      const roomID = await createRoom("v27-questions");
      const created = await store.writeState((service) => {
        const questions = Array.from({ length: 250 }, (_, index) =>
          service.sendMessage(roomID, "Alice", `open question ${index}?`, "alice-session", true));
        const answered = service.sendMessage(roomID, "Alice", "answered question?", "alice-session", true);
        const recalled = service.sendMessage(roomID, "Alice", "recalled question?", "alice-session", true);
        return { questions, answered, recalled };
      });
      expect(await store.countOpenQuestions(roomID)).toBe(252);
      expect((await store.answerQuestion(roomID, created.answered.id, "alice-session", "yes")).status).toBe("ok");
      expect((await store.recallMessage(roomID, created.recalled.id, "alice-session")).status).toBe("ok");
      // 250 open questions remain: one answered and one recalled are excluded.
      expect(await store.countOpenQuestions(roomID)).toBe(250);

      const response = await catchUp(roomID, "alice-session", "limit=50");
      expect(response.status).toBe(200);
      const text = await response.clone().text();
      expect(text.length).toBeLessThan(64 * 1024);
      const body = await response.json() as CatchUp;
      expect(body.messages).toHaveLength(50);
      expect(body.unansweredQuestions).toHaveLength(200);
      expect(body.unansweredQuestionCount).toBe(250);
      expect(body.unansweredQuestions.some((item) => item.id === created.answered.id)).toBe(false);
      expect(body.unansweredQuestions.some((item) => item.id === created.recalled.id)).toBe(false);
    });
  });
}