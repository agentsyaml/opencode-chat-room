import { afterEach, expect, test } from "bun:test";
import { catchUp, centerAction, getMessage, type CenterOpts } from "../center/center-client.ts";

const opts: CenterOpts = { center: "https://center.example", token: "secret-token" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function stubFetch(reply: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return Response.json(body, { status });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  return calls;
}

const liveView = {
  id: "m1", roomId: "r 1", seq: 7, senderId: "alice", senderName: "Alice", text: "hello",
  createdAt: 1, isQuestion: false, parentMessageId: null, answeredByMessageId: null,
  recalled: false, resourceIDs: [],
};
const tombstone = {
  id: "m2", roomId: "r1", seq: 8, senderId: "bob", createdAt: 2, recalled: true,
  recalledAt: 3, recalledBy: "bob", text: null, unavailable: "recalled", resourceIDs: [],
};
const page = {
  messages: [tombstone], nextCursor: 8, hasMore: true,
  unreadMentions: [{ id: "m1", seq: 7 }], unreadMentionCount: 1,
  unansweredQuestions: [], unansweredQuestionCount: 0,
};

test("getMessage fetches one message with auth and keeps the server view", async () => {
  const calls = stubFetch(() => ({ body: liveView }));
  expect(await getMessage(opts, "r 1", "m/1", "s 1")).toEqual(liveView);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://center.example/rooms/r%201/messages/m%2F1?sessionID=s%201");
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.headers.Authorization).toBe("Bearer secret-token");
});

test("getMessage returns the recalled tombstone instead of dropping the message", async () => {
  stubFetch(() => ({ body: tombstone }));
  expect(await getMessage(opts, "r1", "m2", "s1")).toEqual(tombstone);
});

test("a cross-room or non-member 404 passes through unchanged", async () => {
  stubFetch(() => ({ status: 404, body: { error: "not found" } }));
  const error = await getMessage(opts, "other-room", "m1", "s1")
    .then(() => null, (reason) => reason as Error & { status?: number });
  expect(error?.status).toBe(404);
  expect(error?.message).toBe("not found");
});

test("catchUp forwards the cursor and limit as reads only", async () => {
  const calls = stubFetch(() => ({ body: page }));
  expect(await catchUp(opts, "r 1", { sessionID: "s 1", afterSeq: 5, limit: 10 })).toEqual(page);
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/rooms/r%201/catch-up");
  expect(url.searchParams.get("sessionID")).toBe("s 1");
  expect(url.searchParams.get("afterSeq")).toBe("5");
  expect(url.searchParams.get("limit")).toBe("10");
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(calls.some((call) => /\/read$/.test(call.url))).toBe(false);
});

test("catchUp omits absent paging fields and rejects out-of-range limits", async () => {
  const calls = stubFetch(() => ({ body: page }));
  await catchUp(opts, "r1", { sessionID: "s1" });
  const url = new URL(calls[0]!.url);
  expect(url.searchParams.has("afterSeq")).toBe(false);
  expect(url.searchParams.has("limit")).toBe(false);
  await expect(catchUp(opts, "r1", { sessionID: "s1", limit: 201 })).rejects.toThrow("limit");
  await expect(catchUp(opts, "r1", { sessionID: "s1", afterSeq: -1 })).rejects.toThrow("afterSeq");
  expect(calls).toHaveLength(1);
});

test("send forwards parentMessageId and clientMessageID to /messages", async () => {
  const room = {
    id: "r1", name: "dev", ownerId: "Alice", createdAt: 1, kind: "group",
    participants: [{ id: "Alice", name: "Alice" }],
    messages: [{ id: "m9", roomId: "r1", senderId: "Alice", senderSessionID: "s1", text: "answer", createdAt: 10 }],
  };
  const calls = stubFetch(() => ({ body: room }));
  const output = await centerAction(opts,
    { action: "send", roomId: "r1", text: " answer ", parentMessageId: "m1", clientMessageID: "c1" }, "s1");
  expect(output).toContain("message_id=m9 room_id=r1");
  expect(calls[0]!.url).toBe("https://center.example/rooms/r1/messages");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({
    sessionID: "s1", text: "answer", parentMessageId: "m1", clientMessageID: "c1",
  });

  await centerAction(opts, { action: "send", roomId: "r1", text: "old", replyToMessageID: "m1" }, "s1");
  expect(calls[1]!.body).toEqual({ sessionID: "s1", text: "old", replyToMessageID: "m1" });
});

test("centerAction exposes get_message and catch_up without extra calls", async () => {
  const calls = stubFetch((call) => ({ body: call.url.includes("/catch-up") ? page : tombstone }));
  expect(JSON.parse(await centerAction(opts, { action: "get_message", roomId: "r1", messageId: "m2" }, "s1")))
    .toEqual(tombstone);
  const result = JSON.parse(await centerAction(opts, { action: "catch_up", roomId: "r1", afterSeq: 4, limit: 2 }, "s1"));
  expect(result).toEqual(page);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(await centerAction(opts, { action: "get_message", roomId: "r1" }, "s1"))
    .toBe("error: messageId is required; use the full message ID returned by send, poll, or catch_up");
});

test("V1 and V2 schemas expose get_message, catch_up and the send parent", async () => {
  const { roomArgs } = await import("../../plugin.ts");
  const { roomSchema } = await import("../runtime/v2-plugin.ts");
  for (const schema of [roomArgs, roomSchema()]) {
    expect(schema.safeParse({ action: "get_message", roomId: "r1", messageId: "m1" }).success).toBe(true);
    expect(schema.safeParse({ action: "catch_up", roomId: "r1", afterSeq: 3, limit: 200 }).success).toBe(true);
    expect(schema.safeParse({ action: "catch_up", roomId: "r1", limit: 201 }).success).toBe(false);
    expect(schema.safeParse({ action: "send", roomId: "r1", text: "answer", parentMessageId: "m1" }).success).toBe(true);
  }
});