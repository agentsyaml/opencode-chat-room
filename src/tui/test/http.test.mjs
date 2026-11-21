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
      body: raw ? JSON.parse(raw) : undefined,
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