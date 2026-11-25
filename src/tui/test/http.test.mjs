import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { ApiError, createApi } from "../http.mjs";

async function fake(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const call = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: raw && String(req.headers["content-type"] ?? "").includes("application/json") ? JSON.parse(raw) : raw || undefined,
    };
    calls.push(call);
    await handler(call, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

function reply(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("listRooms, getRoom and joinStatus encode ids and send auth", async () => {
  const server = await fake((call, res) => {
    if (call.url.startsWith("/rooms?")) return reply(res, 200, [{ id: "r1" }]);
    if (call.url.includes("/join-requests/status")) return reply(res, 200, { status: "pending" });
    return reply(res, 200, { id: "r/1", name: "room" });
  });
  try {
    const api = createApi({ url: `${server.url}/`, token: "secret" });
    assert.deepEqual(await api.listRooms("s 1&x"), [{ id: "r1" }]);
    assert.equal(server.calls[0].url, "/rooms?sessionID=s%201%26x");
    assert.equal(server.calls[0].headers.authorization, "Bearer secret");

    assert.deepEqual(await api.getRoom("r/1"), { id: "r/1", name: "room" });
    assert.equal(server.calls[1].url, "/rooms/r%2F1");

    assert.equal(await api.joinStatus("r1", "s 1&x"), "pending");
    assert.equal(server.calls[2].url, "/rooms/r1/join-requests/status?sessionID=s%201%26x");
  } finally {
    await server.close();
  }
});

test("join sends the human body and distinguishes 202 from a joined room", async () => {
  let pending = true;
  const server = await fake((call, res) => {
    if (pending) return reply(res, 202, { status: "pending", message: "wait for approval" });
    return reply(res, 201, { id: "r1", name: "room" });
  });
  try {
    const api = createApi({ url: server.url, token: "" });
    assert.deepEqual(await api.join("r1", "s1", "Alex"), { pending: true, message: "wait for approval" });
    assert.deepEqual(server.calls[0].body, {
      sessionID: "s1",
      participantId: "Alex",
      participantName: "Alex",
    });
    assert.equal(server.calls[0].headers["content-type"], "application/json");
    assert.equal(server.calls[0].headers.authorization, undefined);

    pending = false;
    assert.deepEqual(await api.join("r1", "s1", "Alex"), {
      pending: false,
      room: { id: "r1", name: "room" },
    });
  } finally {
    await server.close();
  }
});

test("createRoom sends joinPolicy and never a host field", async () => {
  const server = await fake((call, res) => reply(res, 201, { id: "new" }));
  try {
    const api = createApi({ url: server.url, token: "t" });
    assert.deepEqual(await api.createRoom("Room", "s1", "owner", "approval"), { id: "new" });
    assert.equal(server.calls[0].method, "POST");
    assert.equal(server.calls[0].url, "/rooms");
    assert.deepEqual(server.calls[0].body, {
      name: "Room",
      sessionID: "s1",
      ownerId: "owner",
      joinPolicy: "approval",
    });
    assert.equal("host" in server.calls[0].body, false);
  } finally {
    await server.close();
  }
});

test("updateRoom patches name, description and policy with the session", async () => {
  const server = await fake((call, res) => reply(res, 200, { id: "r1", name: "Renamed" }));
  try {
    const api = createApi({ url: server.url, token: "t" });
    assert.deepEqual(await api.updateRoom("r/1", "s1", { name: "Renamed", joinPolicy: "approval" }), { id: "r1", name: "Renamed" });
    assert.equal(server.calls[0].method, "PATCH");
    assert.equal(server.calls[0].url, "/rooms/r%2F1");
    assert.deepEqual(server.calls[0].body, { sessionID: "s1", name: "Renamed", joinPolicy: "approval" });
  } finally {
    await server.close();
  }
});

test("deleteRoom sends the session and path", async () => {
  const server = await fake((call, res) => reply(res, 200, { ok: true }));
  try {
    const api = createApi({ url: server.url, token: "t" });
    assert.deepEqual(await api.deleteRoom("r/1", "s1"), { ok: true });
    assert.equal(server.calls[0].method, "DELETE");
    assert.equal(server.calls[0].url, "/rooms/r%2F1");
    assert.deepEqual(server.calls[0].body, { sessionID: "s1" });
  } finally {
    await server.close();
  }
});

test("leave, send and markRead use the documented paths and bodies", async () => {
  const server = await fake((call, res) => {
    if (call.url === "/rooms/r1/messages") return reply(res, 201, { id: "r1", messages: [] });
    return reply(res, 200, { ok: true });
  });
  try {
    const api = createApi({ url: server.url, token: "t" });
    await api.leave("r1", "s1");
    assert.deepEqual(server.calls[0], {
      method: "POST",
      url: "/rooms/r1/leave",
      headers: server.calls[0].headers,
      body: { sessionID: "s1" },
    });

    assert.deepEqual(await api.send("r1", "s1", "hello"), { id: "r1", messages: [] });
    assert.equal(server.calls[1].url, "/rooms/r1/messages");
    assert.deepEqual(server.calls[1].body, { sessionID: "s1", text: "hello" });

    await api.markRead("r1", "s1", 123);
    assert.equal(server.calls[2].url, "/read");
    assert.deepEqual(server.calls[2].body, { roomId: "r1", sessionID: "s1", ts: 123 });
  } finally {
    await server.close();
  }
});

test("getMessage, catchUp and parent replies use the addressing routes", async () => {
  const server = await fake((call, res) => {
    if (call.method === "GET" && call.url.includes("/catch-up?")) {
      return reply(res, 200, { messages: [], nextCursor: 4, hasMore: false, unreadMentions: [], unreadMentionCount: 0, unansweredQuestions: [], unansweredQuestionCount: 0 });
    }
    if (call.method === "GET" && call.url.includes("/messages/m")) {
      return reply(res, 200, { id: "m1", recalled: true, recalledAt: 2, recalledBy: "bob", text: null, unavailable: "recalled", resourceIDs: [] });
    }
    return reply(res, 200, { id: "r1", messages: [] });
  });
  try {
    const api = createApi({ url: server.url, token: "t" });
    const recalled = await api.getMessage("r 1", "m/1", "s 1");
    assert.equal(recalled.unavailable, "recalled");
    assert.equal(recalled.text, null);
    assert.equal(server.calls[0].url, "/rooms/r%201/messages/m%2F1?sessionID=s%201");
    assert.equal(server.calls[0].headers.authorization, "Bearer t");

    const page = await api.catchUp("r1", "s1", { afterSeq: 3, limit: 500 });
    assert.equal(page.nextCursor, 4);
    assert.equal(server.calls[1].url, "/rooms/r1/catch-up?sessionID=s1&afterSeq=3&limit=200");

    await api.send("r1", "s1", "reply", { parentMessageId: "m1", clientMessageID: "c1" });
    assert.equal(server.calls[2].url, "/rooms/r1/messages");
    assert.deepEqual(server.calls[2].body, { sessionID: "s1", text: "reply", parentMessageId: "m1", clientMessageID: "c1" });
  } finally {
    await server.close();
  }
});

test("getMessage surfaces the uniform 404 as an ApiError", async () => {
  const server = await fake((call, res) => reply(res, 404, { error: "not found" }));
  try {
    const api = createApi({ url: server.url, token: "t" });
    const error = await api.getMessage("other-room", "m1", "s1").then(() => null, (reason) => reason);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.match(error.message, /not found/);
  } finally {
    await server.close();
  }
});

test("poll forwards a finite afterTs and long-poll timeout", async () => {
  const server = await fake((call, res) =>
    reply(res, 200, { member: true, items: [], hasMore: false, recallVersion: 4 }));
  try {
    const api = createApi({ url: server.url, token: "" });
    const result = await api.poll("r1", "s1", 99, { timeoutMs: 500 });
    assert.deepEqual(result, { member: true, items: [], hasMore: false, recallVersion: 4 });
    assert.equal(
      server.calls[0].url,
      "/inbox?sessionID=s1&roomId=r1&excludeSelf=0&timeout=500&afterTs=99",
    );

    await api.poll("r1", "s1", Number.NaN, { timeoutMs: 0 });
    assert.equal(server.calls[1].url, "/inbox?sessionID=s1&roomId=r1&excludeSelf=0&timeout=0");
  } finally {
    await server.close();
  }
});

test("a long poll outlives the normal request timeout", async () => {
  const server = await fake(async (call, res) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    reply(res, 200, { member: true, items: [], hasMore: false, recallVersion: 1 });
  });
  try {
    const api = createApi({ url: server.url, token: "", requestTimeoutMs: 40 });
    const result = await api.poll("r1", "s1", undefined, { timeoutMs: 10 });
    assert.equal(result.member, true);
  } finally {
    await server.close();
  }
});

test("HTTP errors become actionable ApiError messages", async () => {
  const cases = [
    { id: "401", status: 401, error: "unauthorized", pattern: /token/i },
    { id: "403", status: 403, error: "denied", pattern: /member|permission/i },
    { id: "404", status: 404, error: "gone", pattern: /room|resource/i },
    { id: "409", status: 409, error: "taken", pattern: /not a room member|name/i },
    { id: "500", status: 500, error: "database exploded", pattern: /database exploded/ },
  ];
  const server = await fake((call, res) => {
    const entry = cases.find((item) => call.url === `/rooms/${item.id}`);
    reply(res, entry.status, { error: entry.error });
  });
  try {
    const api = createApi({ url: server.url, token: "super-secret-token" });
    for (const entry of cases) {
      const error = await api.getRoom(entry.id).then(() => null, (reason) => reason);
      assert.ok(error instanceof ApiError, `status ${entry.status} should throw ApiError`);
      assert.equal(error.status, entry.status);
      assert.match(error.message, entry.pattern);
      assert.doesNotMatch(error.message, /super-secret-token/);
    }
  } finally {
    await server.close();
  }
});

test("history pages include the membership check and cursor", async () => {
  const server = await fake((call, res) =>
    reply(res, 200, { messages: [], hasMore: false, nextBeforeSeq: null, recallVersion: 1 }));
  try {
    const api = createApi({ url: server.url, token: "" });
    const page = await api.history("r 1", "s 1&x", 42, 500);
    assert.deepEqual(page, { messages: [], hasMore: false, nextBeforeSeq: null, recallVersion: 1 });
    assert.equal(
      server.calls[0].url,
      "/rooms/r%201/history?limit=200&excludeSessionID=s%201%26x&beforeSeq=42",
    );
  } finally {
    await server.close();
  }
});

test("members, announcements, questions, reminders and recall use documented routes", async () => {
  const server = await fake((call, res) => {
    if (call.url === "/rooms/r1/members") return reply(res, 200, { members: [{ name: "Alex" }] });
    if (call.method === "GET" && call.url === "/rooms/r1/announcements") return reply(res, 200, { announcements: [{ name: "Rules" }] });
    if (call.method === "PUT") return reply(res, 200, { announcement: { name: "Rules", content: "hi" } });
    if (call.method === "DELETE" && call.url.includes("/announcements/")) return reply(res, 200, { ok: true });
    if (call.method === "GET" && call.url === "/rooms/r1/questions") return reply(res, 200, { questions: [{ id: "q1" }] });
    if (call.url.endsWith("/answers")) return reply(res, 201, { questionID: "q1", answer: { text: "yes" } });
    if (call.method === "GET" && call.url.startsWith("/rooms/r1/reminders?")) return reply(res, 200, { reminders: [{ id: "rem1" }] });
    if (call.method === "POST" && call.url === "/rooms/r1/reminders") return reply(res, 201, { reminder: { id: "rem1" } });
    if (call.method === "PATCH") return reply(res, 200, { reminder: { id: "rem1", paused: true } });
    if (call.method === "DELETE" && call.url.includes("/reminders/")) return reply(res, 200, { ok: true });
    if (call.url.endsWith("/recall")) return reply(res, 200, { ok: true, messageID: "m1" });
    if (call.url.includes("/content?")) return reply(res, 200, { text: "original" });
    return reply(res, 200, { ok: true });
  });
  try {
    const api = createApi({ url: server.url, token: "t" });
    assert.deepEqual(await api.members("r1"), [{ name: "Alex" }]);
    assert.deepEqual(await api.announcements("r1"), [{ name: "Rules" }]);
    assert.deepEqual(await api.saveAnnouncement("r1", "Rules", "hi", "s1"), { name: "Rules", content: "hi" });
    await api.deleteAnnouncement("r1", "Rules", "s1");
    assert.deepEqual(await api.questions("r1"), [{ id: "q1" }]);
    assert.deepEqual(await api.answerQuestion("r1", "q1", "s1", "yes"), { questionID: "q1", answer: { text: "yes" } });
    assert.deepEqual(await api.reminders("r1", "s1"), [{ id: "rem1" }]);
    assert.deepEqual(await api.createReminder("r1", "s1", "ping", { type: "once", at: "2030-01-01T00:00:00Z" }), { id: "rem1" });
    assert.deepEqual(await api.updateReminder("r1", "rem1", "s1", { paused: true }), { id: "rem1", paused: true });
    await api.deleteReminder("r1", "rem1", "s1");
    assert.deepEqual(await api.recall("r1", "m1", "s1"), { ok: true, messageID: "m1" });
    assert.deepEqual(await api.reveal("r1", "m1", "s1"), { text: "original" });
    assert.ok(server.calls.some((entry) => entry.url === "/rooms/r1/announcements/Rules"));
    assert.equal(server.calls.find((entry) => entry.url === "/rooms/r1/reminders?sessionID=s1").method, "GET");
  } finally {
    await server.close();
  }
});

test("resources use the member header, download bytes and upload raw content", async () => {
  const server = await fake((call, res) => {
    if (call.method === "GET" && call.url.startsWith("/rooms/r1/resources?")) {
      if (call.headers["x-session-id"] !== "s1") return reply(res, 403, { error: "forbidden" });
      return reply(res, 200, { resources: [{ id: "f1" }], total: 1 });
    }
    if (call.method === "POST" && call.url === "/rooms/r1/resources") {
      return reply(res, 201, { resource: { id: "f1", name: "a.txt" } });
    }
    if (call.url.endsWith("/content")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello");
      return;
    }
    return reply(res, 404, { error: "no" });
  });
  try {
    const api = createApi({ url: server.url, token: "t" });
    assert.deepEqual(await api.resources("r1", "s1", 10, 0), { resources: [{ id: "f1" }], total: 1 });
    assert.equal(server.calls[0].headers["x-session-id"], "s1");
    const file = await api.resourceContent("r1", "f1");
    assert.equal(new TextDecoder().decode(file.bytes), "hello");
    assert.match(file.contentType, /text\/plain/);
    assert.deepEqual(await api.uploadResource("r1", "s1", "a b.txt", new Uint8Array([1, 2, 3])), { id: "f1", name: "a.txt" });
    const upload = server.calls.find((entry) => entry.method === "POST");
    assert.equal(upload.headers["x-file-name"], "a%20b.txt");
    assert.equal(upload.headers["x-session-id"], "s1");
  } finally {
    await server.close();
  }
});

test("resource delete and join-request decisions use member sessions", async () => {
  const server = await fake((call, res) => {
    if (call.method === "GET" && call.url.startsWith("/rooms/r1/join-requests?")) {
      return reply(res, 200, [{ sessionID: "s2", name: "Bob", isAgent: true, participantId: "Bob", createdAt: 1 }]);
    }
    if (call.method === "POST" && call.url.includes("/join-requests/s2/approve")) return reply(res, 200, { ok: true });
    if (call.method === "POST" && call.url.includes("/join-requests/s2/deny")) return reply(res, 200, { ok: true });
    if (call.method === "DELETE" && call.url === "/rooms/r1/resources/f1") return reply(res, 200, { ok: true });
    return reply(res, 404, { error: "no" });
  });
  try {
    const api = createApi({ url: server.url, token: "t" });
    const requests = await api.joinRequests("r1", "s1");
    assert.equal(requests.status, 200);
    assert.deepEqual(requests.requests, [{ sessionID: "s2", name: "Bob", isAgent: true, participantId: "Bob", createdAt: 1 }]);
    assert.equal(server.calls[0].url, "/rooms/r1/join-requests?sessionID=s1");
    assert.deepEqual(await api.decideJoin("r1", "s2", "s1", "approve"), { ok: true });
    assert.deepEqual(await api.decideJoin("r1", "s2", "s1", "deny"), { ok: true });
    assert.deepEqual(await api.deleteResource("r1", "f1", "s1"), { ok: true });
    assert.deepEqual(server.calls[3].body, {});
    assert.equal(server.calls[3].headers["x-session-id"], "s1");
  } finally {
    await server.close();
  }
});

test("poll stops when the caller aborts", async () => {
  const server = await fake(() => {});
  try {
    const api = createApi({ url: server.url, token: "", requestTimeoutMs: 5000 });
    const controller = new AbortController();
    const pending = api.poll("r1", "s1", 1, { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally {
    await server.close();
  }
});