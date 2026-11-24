import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.mjs";

const rooms = [
  { id: "r1", name: "general", participants: [{ id: "alex", name: "alex" }, { id: "bob", name: "bob" }], joined: true },
  { id: "r2", name: "design", participants: [{ id: "alex", name: "alex" }], joined: false },
];

const message = (id, text, createdAt, extra = {}) => ({ id, senderId: "bob", text, createdAt, ...extra });

function roomPayload(id) {
  const summary = rooms.find((room) => room.id === id);
  return {
    id,
    name: summary?.name ?? id,
    participants: summary?.participants ?? [],
    messages: [message("m1", "hello", 1000)],
  };
}

function fakeApi() {
  const api = {
    calls: [],
    async listRooms(sessionID) {
      api.calls.push(["listRooms", sessionID]);
      return rooms.map((room) => ({ ...room }));
    },
    async getRoom(id) {
      api.calls.push(["getRoom", id]);
      return roomPayload(id);
    },
    async join(id, sessionID, name) {
      api.calls.push(["join", id, sessionID, name]);
      return { pending: false, room: roomPayload(id) };
    },
    async joinStatus(id, sessionID) {
      api.calls.push(["joinStatus", id, sessionID]);
      return "joined";
    },
    async send(id, sessionID, text) {
      api.calls.push(["send", id, sessionID, text]);
      return message("m9", text, 4000, { senderId: "alex" });
    },
    async poll(id, sessionID, lastTs) {
      api.calls.push(["poll", id, sessionID, lastTs]);
      return { member: true, items: [], hasMore: false, recallVersion: 1 };
    },
    async markRead(id, sessionID, ts) {
      api.calls.push(["markRead", id, sessionID, ts]);
    },
  };
  return api;
}

function makeApp(api) {
  const scheduled = [];
  const app = createApp({
    api,
    sessionID: "s1",
    participant: "alex",
    autoPoll: false,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return undefined;
    },
  });
  return { app, scheduled };
}

const called = (api, name) => api.calls.filter((call) => call[0] === name);

test("open a joined room loads messages and marks the newest read", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  assert.equal(app.state.current.id, "r1");
  assert.equal(app.state.joined, true);
  assert.deepEqual(app.state.messages.map((item) => item.id), ["m1"]);
  assert.deepEqual(called(api, "markRead").at(-1), ["markRead", "r1", "s1", 1000]);
});

test("pending join shows the server message and waits for approval", async () => {
  const api = fakeApi();
  api.join = async (id, sessionID, name) => {
    api.calls.push(["join", id, sessionID, name]);
    return { pending: true, message: "waiting for an administrator" };
  };
  let status = "pending";
  api.joinStatus = async (id, sessionID) => {
    api.calls.push(["joinStatus", id, sessionID]);
    return status;
  };
  const { app, scheduled } = makeApp(api);
  await app.init();
  await app.openRoom(1);

  assert.equal(app.state.joined, false);
  assert.equal(app.state.pending.roomId, "r2");
  assert.equal(app.state.pending.message, "waiting for an administrator");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 1500);

  await scheduled.shift().fn();
  assert.equal(app.state.pending.roomId, "r2");
  assert.equal(scheduled.length, 1);

  status = "joined";
  await scheduled.shift().fn();
  assert.equal(app.state.joined, true);
  assert.equal(app.state.pending, null);
  assert.equal(app.state.current.id, "r2");
  assert.deepEqual(app.state.messages.map((item) => item.id), ["m1"]);
});

test("composer draft sends and merges the response", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.toggleFocus();
  app.setDraft("hi 世界\nsecond line");
  assert.equal(app.state.draft, "hi 世界\nsecond line");

  await app.send();
  assert.deepEqual(called(api, "send").at(-1), ["send", "r1", "s1", "hi 世界\nsecond line"]);
  assert.equal(app.state.draft, "");
  assert.deepEqual(app.state.messages.map((item) => item.id), ["m1", "m9"]);
});

test("a failed send keeps text typed while the request was in flight", async () => {
  const api = fakeApi();
  let fail;
  api.send = (id, sessionID, text) => {
    api.calls.push(["send", id, sessionID, text]);
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.setDraft("hello");
  const sending = app.send();
  assert.equal(app.state.draft, "");
  app.setDraft("x");
  fail(new Error("offline"));
  await sending;
  assert.equal(app.state.draft, "hello\nx");
});

test("a retried send reuses the first attempt's client message id", async () => {
  const api = fakeApi();
  const attempts = [];
  api.send = (id, sessionID, text, options) => {
    attempts.push({ text, clientMessageID: options?.clientMessageID });
    if (attempts.length === 1) return Promise.reject(new Error("offline"));
    return Promise.resolve(message("m9", text, 4000, { senderId: "alex" }));
  };
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.setDraft("hello");
  await app.send();
  assert.equal(app.state.draft, "hello");
  await app.send();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].clientMessageID);
  assert.equal(attempts[1].clientMessageID, attempts[0].clientMessageID);
  assert.equal(app.state.draft, "");
});

test("room selection, help and escape behave like the key bindings", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  app.moveSelection(1);
  assert.equal(app.state.selected, 1);
  app.moveSelection(1);
  assert.equal(app.state.selected, 1);
  app.toggleHelp();
  assert.equal(app.state.help, true);
  app.toggleFocus();
  assert.equal(app.state.focus, "composer");
  assert.equal(app.state.help, false);
  app.setDraft("draft");
  app.clearOrBlur();
  assert.equal(app.state.draft, "");
  assert.equal(app.state.focus, "rooms");
});

test("poll merges new messages once and marks the newest read", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  api.poll = async (id, sessionID, lastTs) => {
    api.calls.push(["poll", id, sessionID, lastTs]);
    return {
      member: true,
      items: [message("m1", "hello", 1000), message("m2", "newer", 2000)],
      hasMore: false,
      recallVersion: 1,
    };
  };

  assert.equal(await app.pollOnce(), true);
  assert.deepEqual(app.state.messages.map((item) => item.id), ["m1", "m2"]);
  assert.ok(called(api, "markRead").some((call) => call[3] === 2000));
  assert.equal(app.state.connection, "online");
});

test("palette search fetches an older history page without blocking", async () => {
  const api = fakeApi();
  api.history = async (id, sessionID, beforeSeq) => {
    api.calls.push(["history", id, sessionID, beforeSeq]);
    return {
      messages: [{ ...message("h1", "ancient topic", 500), seq: 3 }],
      hasMore: false,
      nextBeforeSeq: 3,
      recallVersion: 1,
    };
  };
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.openPalette();
  app.setPaletteQuery("ancient");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(called(api, "history").length, 1);
  assert.deepEqual(app.state.palette.results.map((result) => result.message.id), ["h1"]);
  assert.equal(app.state.palette.searching, false);
  assert.ok(app.state.messages.some((item) => item.id === "h1"));
});

test("palette opens from the composer, closes and restores focus", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.toggleFocus();
  assert.equal(app.state.focus, "composer");

  app.openPalette();
  assert.equal(app.state.palette.mode, "search");
  app.openPalette({ slash: true });
  assert.equal(app.state.palette.mode, "commands");
  app.closePalette();
  assert.equal(app.state.palette, null);
  assert.equal(app.state.focus, "composer");
});

test("palette search activates the result and highlights the message", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.openPalette();
  app.setPaletteQuery("hello");

  assert.equal(app.state.palette.mode, "search");
  assert.equal(app.state.palette.results.length, 1);
  assert.equal(app.state.palette.results[0].message.id, "m1");

  await app.runPaletteSelection();
  assert.equal(app.state.palette, null);
  assert.equal(app.state.highlight, "m1");
  assert.equal(app.state.focus, "composer");
});

test("palette scope toggle switches between room and all rooms", async () => {
  const api = fakeApi();
  const { app } = makeApp(api);
  await app.init();
  await app.openRoom(0);
  app.openPalette();
  app.setPaletteQuery("hello");
  assert.equal(app.state.palette.scope, "room");
  app.togglePaletteScope();
  assert.equal(app.state.palette.scope, "all");
  app.togglePaletteScope();
  assert.equal(app.state.palette.scope, "room");
});