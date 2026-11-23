import assert from "node:assert/strict";
import { test } from "node:test";
import { centerAction, request } from "../plugin/lib/center.mjs";
import { roomPayload, startCenter } from "./helpers.mjs";

test("list, create, join and send map to central routes", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/rooms") {
      return [200, [roomPayload()]];
    }
    if (method === "POST" && path.endsWith("/recall")) {
      return [200, { ok: true, messageID: "m-sent", recalledAt: 2000, recalledBy: "alex@host" }];
    }
    if (method === "POST" && path.endsWith("/messages")) {
      return [200, roomPayload({ messages: [{ id: "m-sent", senderId: "alex@host", text: "hello", createdAt: 1000 }] })];
    }
    if (method === "POST" && (path === "/rooms" || path.endsWith("/join"))) {
      return [201, roomPayload()];
    }
    return undefined;
  });
  try {
    const cfg = { url: center.url, token: "secret" };

    assert.equal(await centerAction(cfg, { action: "list" }, "codex:t1"), "r1 (dev): 1 members");

    const created = await centerAction(cfg, { action: "create", name: "dev" }, "codex:t1");
    assert.match(created, /Room r1 \(dev\)/);
    const create = center.requests.find((r) => r.method === "POST" && r.path === "/rooms");
    assert.equal(create.body.sessionID, "codex:t1");
    assert.equal(create.body.name, "dev");
    assert.ok(create.body.host);

    await centerAction(cfg, { action: "join", roomId: "r1", name: "alice" }, "codex:t1");
    const join = center.requests.find((r) => r.path === "/rooms/r1/join");
    assert.equal(join.body.sessionID, "codex:t1");
    assert.equal(join.body.participantId, "alice");
    assert.equal(join.body.participantName, "alice");

    const sent = await centerAction(cfg, { action: "send", roomId: "r1", text: " hello " }, "codex:t1");
    assert.match(sent, /^sent: hello\nmessage id: m-sent\nRoom r1 \(dev\)/);
    const message = center.requests.find((r) => r.path === "/rooms/r1/messages");
    assert.deepEqual(message.body, { sessionID: "codex:t1", text: "hello" });

    assert.equal(await centerAction(cfg, { action: "recall", roomId: "r1", messageId: "m-sent" }, "codex:t1"), "recalled message m-sent");
    const recall = center.requests.find((r) => r.path === "/rooms/r1/messages/m-sent/recall");
    assert.equal(recall.method, "POST");
    assert.deepEqual(recall.body, { sessionID: "codex:t1" });
  } finally {
    await center.close();
  }
});

test("poll excludes self, acknowledges the newest foreign message and reports errors", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/inbox") {
      return [200, {
        member: true,
        hasMore: false,
        queuedTs: { r1: 0 },
        items: [
          { id: "m1", roomId: "r1", senderId: "alice", senderSessionID: "codex:t2", text: "hi", createdAt: 1000 },
          { id: "m2", roomId: "r1", senderId: "me", senderSessionID: "codex:t1", text: "own", createdAt: 2000 },
        ],
      }];
    }
    if (method === "POST" && path === "/read") return [200, { ok: true }];
    if (path === "/rooms/nope") return [404, { error: "room not found" }];
    return undefined;
  });
  try {
    const cfg = { url: center.url, token: "" };
    const polled = await centerAction(cfg, { action: "poll", roomId: "r1" }, "codex:t1");
    assert.match(polled, /alice: hi \(id: m1\)/);
    assert.doesNotMatch(polled, /own/);
    const inbox = center.requests.find((r) => r.path === "/inbox");
    assert.equal(inbox.query.excludeSelf, "1");
    assert.equal(inbox.query.sessionID, "codex:t1");
    const read = center.requests.find((r) => r.method === "POST" && r.path === "/read");
    assert.deepEqual(read.body, { roomId: "r1", sessionID: "codex:t1", ts: 1000 });

    await assert.rejects(request(cfg, "/rooms/nope", "GET"), /404.*room not found/);
  } finally {
    await center.close();
  }
});

test("task actions use the central task routes", async () => {
  const task = { id: "t1", roomId: "r1", title: "Fix", description: "details", assignee: "alice", status: "todo", creatorName: "alex@host", creatorSessionID: "codex:t1", createdAt: 1, updatedAt: 1,
    dueDate: "2026-12-31", participants: ["alice", "bob"], conclusion: "shipped", steps: [{ text: "plan", done: false }, { text: "code", done: true }] };
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/rooms/r1/tasks") return [200, { tasks: [task] }];
    if (method === "POST" && path === "/rooms/r1/tasks") return [201, { task }];
    if (method === "PATCH" && path === "/rooms/r1/tasks/t1") return [200, { task: { ...task, status: "doing" } }];
    if (method === "DELETE" && path === "/rooms/r1/tasks/t1") return [200, { ok: true }];
    return undefined;
  });
  try {
    const cfg = { url: center.url, token: "" };
    const listed = await centerAction(cfg, { action: "task_list", roomId: "r1" }, "codex:t1");
    assert.match(listed, /t1 \[todo\] Fix/);
    assert.match(listed, /assignee: alice/);
    assert.match(listed, /\(creator: alex@host\) \(due: 2026-12-31\) \(participants: alice, bob\)/);
    assert.match(listed, /steps: 1\/2\n  - \[ \] plan\n  - \[x\] code/);
    assert.match(listed, /conclusion: shipped/);
    assert.equal(center.requests[0].query.sessionID, "codex:t1");
    assert.equal(await centerAction(cfg, { action: "task_create", roomId: "r1", title: "Fix", assignee: "", dueDate: "2026-12-31", participants: ["alice"], conclusion: "c", steps: ["plan", { text: "code" }, { text: "review", done: false }] }, "codex:t1"), "task created: Fix (id: t1, status: todo)");
    assert.deepEqual(center.requests.find((r) => r.method === "POST").body, { sessionID: "codex:t1", title: "Fix", assignee: "", dueDate: "2026-12-31", participants: ["alice"], conclusion: "c", steps: ["plan", { text: "code", done: false }, { text: "review", done: false }] });
    assert.equal(await centerAction(cfg, { action: "task_update", roomId: "r1", taskId: "t1", status: "doing", dueDate: "", participants: [], conclusion: "", steps: [] }, "codex:t1"), "task updated: Fix (id: t1, status: doing)");
    assert.deepEqual(center.requests.find((r) => r.method === "PATCH").body, { sessionID: "codex:t1", status: "doing", dueDate: "", participants: [], conclusion: "", steps: [] });
    assert.equal(await centerAction(cfg, { action: "task_delete", roomId: "r1", taskId: "t1" }, "codex:t1"), "task deleted: t1");
    assert.deepEqual(center.requests.find((r) => r.method === "DELETE").body, { sessionID: "codex:t1" });
    assert.equal(await centerAction(cfg, { action: "task_create", roomId: "r1" }, "codex:t1"), "error: title is required to create a task");
    assert.equal(await centerAction(cfg, { action: "task_update", roomId: "r1", taskId: "t1" }, "codex:t1"), "error: at least one of title, description, assignee, status, dueDate, participants, conclusion, or steps is required to update a task");
    assert.equal(await centerAction(cfg, { action: "task_delete", roomId: "r1" }, "codex:t1"), "error: taskId is required");
  } finally {
    await center.close();
  }
});

test("members, leave and announcements use the central routes", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "GET" && path === "/rooms/r1") return [200, roomPayload({ participants: [{ id: "alice", name: "alice" }] })];
    if (method === "POST" && path === "/rooms/r1/leave") return [200, { ok: true }];
    if (method === "GET" && path === "/rooms/r1/announcements") return [200, { announcements: [{ name: "status", content: "green" }] }];
    if (method === "GET" && path === "/rooms/r1/announcements/status") return [200, { announcement: { name: "status", content: "green" } }];
    if (method === "PUT" && path === "/rooms/r1/announcements/status") return [200, { announcement: { name: "status", content: "blue" } }];
    if (method === "DELETE" && path === "/rooms/r1/announcements/status") return [200, { ok: true }];
    return undefined;
  });
  try {
    const cfg = { url: center.url, token: "" };
    assert.equal(await centerAction(cfg, { action: "members", roomId: "r1" }, "codex:t1"), "alice");
    assert.equal(await centerAction(cfg, { action: "leave", roomId: "r1" }, "codex:t1"), "left room r1");
    assert.equal(await centerAction(cfg, { action: "announcement_list", roomId: "r1" }, "codex:t1"), "status: green");
    assert.equal(await centerAction(cfg, { action: "announcement_read", roomId: "r1", announcementName: "status" }, "codex:t1"), "status:\ngreen");
    assert.equal(await centerAction(cfg, { action: "announcement_write", roomId: "r1", announcementName: "status", content: "blue" }, "codex:t1"), "announcement saved: status");
    assert.equal(await centerAction(cfg, { action: "announcement_delete", roomId: "r1", announcementName: "status" }, "codex:t1"), "announcement deleted: status");
    assert.deepEqual(center.requests.filter((r) => r.method === "PUT")[0].body, { sessionID: "codex:t1", content: "blue" });
  } finally {
    await center.close();
  }
});

test("pending join reports that the session is not a member yet", async () => {
  const center = await startCenter(({ method, path }) => {
    if (method === "POST" && path === "/rooms/r1/join") return [202, { status: "pending", message: "Join request submitted." }];
    if (method === "GET" && path === "/rooms/r1/join-requests/status") return [200, { status: "pending" }];
    return undefined;
  });
  try {
    const cfg = { url: center.url, token: "" };
    const joined = await centerAction(cfg, { action: "join", roomId: "r1", name: "alice" }, "codex:t1");
    assert.match(joined, /^pending:/);
    assert.match(joined, /NOT a member yet/);
    assert.doesNotMatch(joined, /Room r1/);
    const status = await centerAction(cfg, { action: "join_status", roomId: "r1" }, "codex:t1");
    assert.match(status, /^pending:/);
    assert.match(status, /NOT a member yet/);
  } finally {
    await center.close();
  }
});
