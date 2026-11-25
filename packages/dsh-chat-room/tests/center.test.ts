import { afterEach, describe, expect, test } from "bun:test";
import { CenterError, ROOM_ACTIONS, parseRoomArgs, roomAction } from "../src/center.ts";
import { resolveConfig } from "../src/config.ts";
import { startFakeCenter } from "./fake-center.ts";

const running: Array<{ stop(): void }> = [];
function center(handler: Parameters<typeof startFakeCenter>[0]) {
  const fake = startFakeCenter(handler);
  running.push(fake);
  return fake;
}
afterEach(() => {
  for (const fake of running.splice(0)) fake.stop();
});

const cfg = (url: string) => resolveConfig({ url, token: "secret" });

describe("central actions", () => {
  test("list, create, join, send and members map to central routes", async () => {
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/rooms") return [200, [{ id: "r1", name: "dev", participants: [{}, {}] }]];
      if (method === "POST" && path === "/rooms") return [201, { id: "r1", name: "dev" }];
      if (method === "POST" && path === "/rooms/r1/join") return [201, { id: "r1", name: "dev" }];
      if (method === "POST" && path === "/rooms/r1/messages") return [200, { messages: [{ id: "m-sent" }] }];
      if (method === "POST" && path === "/rooms/r1/messages/m-sent/recall") return [200, { ok: true, messageID: "m-sent", recalledAt: 2, recalledBy: "alice" }];
      if (method === "GET" && path === "/rooms/r1") return [200, { participants: [{ name: "alice" }, { name: "bob" }] }];
      return undefined;
    });
    const config = cfg(fake.url);
    expect(await roomAction(config, parseRoomArgs({ action: "list" }), "dsh:s1")).toBe("r1 (dev): 2 members");
    expect(await roomAction(config, parseRoomArgs({ action: "create", name: "dev" }), "dsh:s1")).toContain("r1");
    expect(await roomAction(config, parseRoomArgs({ action: "join", roomId: "r1", name: "alice" }), "dsh:s1")).toContain("r1");
    expect(await roomAction(config, parseRoomArgs({ action: "send", roomId: "r1", text: "hi", isQuestion: true }), "dsh:s1"))
      .toBe("sent to room r1 (id: m-sent)");
    expect(await roomAction(config, parseRoomArgs({ action: "recall", roomId: "r1", messageId: "m-sent" }), "dsh:s1"))
      .toBe("recalled message m-sent");
    expect(fake.requests.find((request) => request.path === "/rooms/r1/messages/m-sent/recall")?.body)
      .toEqual({ sessionID: "dsh:s1" });
    expect(await roomAction(config, parseRoomArgs({ action: "members", roomId: "r1" }), "dsh:s1")).toBe("alice\nbob");
    expect(fake.requests.every((request) => request.authorization === "Bearer secret")).toBe(true);
    expect(fake.requests.find((request) => request.path === "/rooms/r1/messages")?.body).toEqual({ sessionID: "dsh:s1", text: "hi", isQuestion: true });
    expect(fake.requests.find((request) => request.method === "POST" && request.path === "/rooms")?.body).toMatchObject({ sessionID: "dsh:s1", name: "dev" });
  });

  test("get_message, catch_up and parent replies use the addressing routes", async () => {
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/rooms/r1/messages/m1") {
        return [200, { id: "m1", roomId: "r1", seq: 2, senderId: "bob", createdAt: 5, recalled: true, recalledAt: 6, recalledBy: "bob", text: null, unavailable: "recalled", resourceIDs: [] }];
      }
      if (method === "GET" && path === "/rooms/r1/catch-up") {
        return [200, { messages: [], nextCursor: 9, hasMore: true, unreadMentions: [], unreadMentionCount: 0, unansweredQuestions: [], unansweredQuestionCount: 0 }];
      }
      if (method === "POST" && path === "/rooms/r1/messages") return [200, { messages: [{ id: "m-reply" }] }];
      return undefined;
    });
    const config = cfg(fake.url);
    expect(ROOM_ACTIONS).toContain("get_message");
    expect(ROOM_ACTIONS).toContain("catch_up");
    const tombstone = JSON.parse(await roomAction(config,
      parseRoomArgs({ action: "get_message", roomId: "r1", messageId: "m1" }), "dsh:s1"));
    expect(tombstone).toMatchObject({ recalled: true, text: null, unavailable: "recalled" });
    const page = JSON.parse(await roomAction(config,
      parseRoomArgs({ action: "catch_up", roomId: "r1", afterSeq: 4, limit: 2 }), "dsh:s1"));
    expect(page.nextCursor).toBe(9);
    const catchUpRequest = fake.requests.find((request) => request.path === "/rooms/r1/catch-up")!;
    expect(catchUpRequest.query.get("afterSeq")).toBe("4");
    expect(catchUpRequest.query.get("limit")).toBe("2");
    expect(catchUpRequest.query.get("sessionID")).toBe("dsh:s1");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);

    expect(await roomAction(config,
      parseRoomArgs({ action: "send", roomId: "r1", text: "answer", parentMessageId: "m1" }), "dsh:s1"))
      .toBe("sent to room r1 (id: m-reply)");
    expect(fake.requests.find((request) => request.method === "POST")?.body)
      .toEqual({ sessionID: "dsh:s1", text: "answer", parentMessageId: "m1" });
    expect(() => parseRoomArgs({ action: "catch_up", roomId: "r1", limit: 201 })).toThrow(/limit/);
    expect(() => parseRoomArgs({ action: "catch_up", roomId: "r1", afterSeq: -1 })).toThrow(/afterSeq/);
  });

  test("poll reads unread messages and advances the read watermark", async () => {
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/inbox") {
        return [200, { member: true, hasMore: false, queuedTs: {}, items: [
          { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "hello", createdAt: 100 },
          { id: "m2", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "again", createdAt: 200 },
        ] }];
      }
      if (method === "POST" && path === "/read") return [200, { ok: true }];
      return undefined;
    });
    const result = await roomAction(cfg(fake.url), parseRoomArgs({ action: "poll", roomId: "r1" }), "dsh:s1");
    expect(result).toBe("[bob] hello (id: m1)\n[bob] again (id: m2)");
    const inbox = fake.requests.find((request) => request.path === "/inbox")!;
    expect(inbox.query.get("excludeSelf")).toBe("1");
    expect(inbox.query.get("roomId")).toBe("r1");
    expect(fake.requests.find((request) => request.path === "/read")?.body).toEqual({ roomId: "r1", sessionID: "dsh:s1", ts: 200 });
  });

  test("message text accepts 5000 characters and rejects 5001", () => {
    const longest = "x".repeat(5000);
    expect(parseRoomArgs({ action: "send", roomId: "r1", text: longest }).text).toBe(longest);
    expect(() => parseRoomArgs({ action: "send", roomId: "r1", text: `${longest}x` })).toThrow(TypeError);
  });

  test("task actions map to central routes and validate arguments", async () => {
    const task = { id: "t1", roomId: "r1", title: "Fix", description: "details", assignee: "alice", status: "todo", creatorName: "agent",
      dueDate: "2026-12-31", participants: ["alice", "bob"], conclusion: "shipped", steps: [{ text: "plan", done: false }, { text: "code", done: true }] };
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/rooms/r1/tasks") return [200, { tasks: [task] }];
      if (method === "POST" && path === "/rooms/r1/tasks") return [201, { task }];
      if (method === "PATCH" && path === "/rooms/r1/tasks/t1") return [200, { task: { ...task, status: "doing" } }];
      if (method === "DELETE" && path === "/rooms/r1/tasks/t1") return [200, { ok: true }];
      return undefined;
    });
    const config = cfg(fake.url);
    const listed = await roomAction(config, parseRoomArgs({ action: "task_list", roomId: "r1" }), "dsh:s1");
    expect(listed).toContain("t1 [todo] Fix");
    expect(listed).toContain("assignee: alice");
    expect(listed).toContain("(creator: agent) (due: 2026-12-31) (participants: alice, bob)");
    expect(listed).toContain("steps: 1/2\n  - [ ] plan\n  - [x] code");
    expect(listed).toContain("conclusion: shipped");
    expect(fake.requests[0]?.query.get("sessionID")).toBe("dsh:s1");
    expect(await roomAction(config, parseRoomArgs({ action: "task_create", roomId: "r1", title: "Fix", assignee: "", dueDate: "2026-12-31", participants: ["alice"], conclusion: "c", steps: ["plan", { text: "code" }, { text: "review", done: false }] }), "dsh:s1"))
      .toBe("task created: Fix (id: t1, status: todo)");
    expect(await roomAction(config, parseRoomArgs({ action: "task_update", roomId: "r1", taskId: "t1", status: "doing", assignee: "", dueDate: "", participants: [], conclusion: "", steps: [] }), "dsh:s1"))
      .toBe("task updated: Fix (id: t1, status: doing)");
    expect(await roomAction(config, parseRoomArgs({ action: "task_delete", roomId: "r1", taskId: "t1" }), "dsh:s1"))
      .toBe("task deleted: t1");
    expect(fake.requests.find((request) => request.method === "POST")?.body).toEqual({ sessionID: "dsh:s1", title: "Fix", assignee: "", dueDate: "2026-12-31", participants: ["alice"], conclusion: "c", steps: ["plan", { text: "code", done: false }, { text: "review", done: false }] });
    expect(fake.requests.find((request) => request.method === "PATCH")?.body).toEqual({ sessionID: "dsh:s1", status: "doing", assignee: "", dueDate: "", participants: [], conclusion: "", steps: [] });
    expect(fake.requests.find((request) => request.method === "DELETE")?.body).toEqual({ sessionID: "dsh:s1" });
    expect(parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", assignee: "" }).assignee).toBe("");
    expect(parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", dueDate: " 2026-12-31 ", steps: [{ text: " code " }, { text: " verify ", done: false }] }).steps)
      .toEqual([{ text: "code", done: false }, { text: "verify", done: false }]);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", assignee: "x".repeat(65) })).toThrow(TypeError);
    expect(() => parseRoomArgs({ action: "task_update", roomId: "r1", taskId: "t1", status: "later" })).toThrow(TypeError);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", dueDate: "2026-02-30" })).toThrow(/dueDate/);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", participants: [""] })).toThrow(/participants/);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", conclusion: "x".repeat(5001) })).toThrow(/conclusion/);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", steps: Array.from({ length: 31 }, (_, index) => `step ${index}`) })).toThrow(/steps/);
    expect(() => parseRoomArgs({ action: "task_create", roomId: "r1", title: "x", steps: [{ text: "ok", done: "yes" }] })).toThrow(/done/);
    await expect(roomAction(config, parseRoomArgs({ action: "task_create", roomId: "r1" }), "dsh:s1")).rejects.toThrow(/title/);
    await expect(roomAction(config, parseRoomArgs({ action: "task_update", roomId: "r1", taskId: "t1" }), "dsh:s1"))
      .rejects.toThrow(/title, description/);
  });

  test("server failures keep their status and message", async () => {
    const fake = center(() => [403, { error: "not a member" }]);
    await expect(roomAction(cfg(fake.url), parseRoomArgs({ action: "members", roomId: "r1" }), "dsh:s1"))
      .rejects.toThrow(/403.*not a member/);
    await expect(roomAction(cfg(fake.url), parseRoomArgs({ action: "members" }), "dsh:s1")).rejects.toThrow(TypeError);
    expect(() => parseRoomArgs({ action: "explode" })).toThrow(TypeError);
    expect(() => resolveConfig({ url: "ftp://nope" })).toThrow(TypeError);
    expect(() => resolveConfig({ url: "http://127.0.0.1", deliveryIntervalMs: 10 })).toThrow(TypeError);
    expect(CenterError).toBeDefined();
  });
});