import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { deliverOnce } from "../plugin/lib/deliver.mjs";
import { startCenter } from "./helpers.mjs";

function fakeSpawn(result = {}) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
  return { calls, spawnFn };
}

function inbox() {
  return {
    member: true,
    hasMore: false,
    queuedTs: { r1: 100 },
    items: [
      { id: "old", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "alice", text: "old", createdAt: 50 },
      { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "alice", text: "first", createdAt: 200 },
      { id: "recalled", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "withdrawn", createdAt: 250, recalledAt: 260 },
      { id: "m2", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "second", createdAt: 300 },
      { id: "m3", roomId: "r2", roomName: "dm", roomKind: "direct", senderId: "carol", text: "direct", createdAt: 400 },
    ],
  };
}

test("delivery queues one prompt per room and advances the watermark", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/inbox") return [200, inbox()];
    if (method === "POST" && path === "/queued") return [200, { ok: true }];
    return undefined;
  });
  const fake = fakeSpawn();
  try {
    const result = await deliverOnce({ url: center.url, token: "" }, "thread-1", { spawnFn: fake.spawnFn });
    assert.deepEqual(result, { delivered: 2, failed: 0 });
    assert.equal(fake.calls.length, 2);
    for (const call of fake.calls) {
      assert.deepEqual(call.args.slice(0, 4), ["queue", "--thread", "thread-1", "--message"]);
      assert.equal(call.args.at(-1), "--resume");
      assert.match(call.args[4], /^<notification>\n/);
      assert.match(call.args[4], /- \[.*\] (alice|carol): /);
    }
    assert.doesNotMatch(fake.calls[0].args[4], /old/);
    assert.doesNotMatch(fake.calls[0].args[4], /withdrawn/);
    assert.match(fake.calls[0].args[4], /\(id: m1\) first/);

    const marks = center.requests.filter((r) => r.path === "/queued").map((r) => r.body);
    assert.deepEqual(marks, [
      { roomId: "r1", sessionID: "codex:thread-1", ts: 300 },
      { roomId: "r2", sessionID: "codex:thread-1", ts: 400 },
    ]);
    const poll = center.requests.find((r) => r.path === "/inbox");
    assert.equal(poll.query.excludeSelf, "1");
    assert.equal(poll.query.sessionID, "codex:thread-1");
  } finally {
    await center.close();
  }
});

test("a failed queue command leaves the watermark alone so the next poll retries", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/inbox") return [200, inbox()];
    if (method === "POST" && path === "/queued") return [200, { ok: true }];
    return undefined;
  });
  const failing = fakeSpawn({ code: 1, stderr: "no such thread" });
  const logs = [];
  try {
    const cfg = { url: center.url, token: "" };
    const result = await deliverOnce(cfg, "thread-1", { spawnFn: failing.spawnFn, log: (line) => logs.push(line) });
    assert.deepEqual(result, { delivered: 0, failed: 2 });
    assert.equal(center.requests.filter((r) => r.path === "/queued").length, 0);
    assert.ok(logs.some((line) => line.includes("no such thread")));

    const retry = await deliverOnce(cfg, "thread-1", { spawnFn: fakeSpawn().spawnFn });
    assert.deepEqual(retry, { delivered: 2, failed: 0 });
    assert.equal(center.requests.filter((r) => r.path === "/queued").length, 2);
  } finally {
    await center.close();
  }
});