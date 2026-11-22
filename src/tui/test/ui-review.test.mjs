import test from "node:test";
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";

const participants = [{ id: "alex", name: "alex" }, { id: "bob", name: "bob" }];

function makeApi({ requests = [], files = [] } = {}) {
  const state = {
    requests: [...requests],
    files: [...files],
    messages: [],
    calls: [],
    failList: false,
    failDecision: false,
    failDelete: false,
  };
  const api = {
    state,
    calls: state.calls,
    async listRooms() {
      return [{ id: "r1", name: "general", participants, joined: true }];
    },
    async getRoom() {
      return { id: "r1", name: "general", participants, ownerId: "alex", messages: state.messages };
    },
    async join() {
      return { pending: false };
    },
    async poll() {
      return { member: true, items: [] };
    },
    async markRead() {},
    async send(id, sessionID, text, options) {
      state.calls.push(["send", id, sessionID, text, ...(options === undefined ? [] : [options])]);
      const sent = { id: "sent", senderId: "alex", text, createdAt: 5000, ...(options?.isQuestion ? { isQuestion: true } : {}) };
      state.messages.push(sent);
      return sent;
    },
    async joinRequests() {
      if (state.failList) throw Object.assign(new Error("forbidden: not a reviewer"), { status: 403 });
      return { status: 200, requests: state.requests.map((item) => ({ ...item })) };
    },
    async decideJoin(roomID, requestSessionID, sessionID, decision) {
      state.calls.push(["decideJoin", roomID, requestSessionID, sessionID, decision]);
      if (state.failDecision) throw Object.assign(new Error("forbidden: not a reviewer"), { status: 403 });
      state.requests = state.requests.filter((item) => item.sessionID !== requestSessionID);
      return { ok: true };
    },
    async resources() {
      return { resources: state.files, total: state.files.length };
    },
    async deleteResource(roomID, resourceID, sessionID) {
      state.calls.push(["deleteResource", roomID, resourceID, sessionID]);
      if (state.failDelete) throw Object.assign(new Error("forbidden: your session cannot delete this file"), { status: 403 });
      state.files = state.files.filter((item) => item.id !== resourceID);
      return { ok: true };
    },
  };
  return api;
}

async function setup(api = makeApi()) {
  const context = await createTestRenderer({ width: 100, height: 30 });
  const app = createApp({ api, sessionID: "s1", participant: "alex", host: "server", autoPoll: false });
  await app.init();
  const ui = createTui(context.renderer, app);
  await app.openRoom(0);
  await context.renderOnce();
  return { ...context, app, ui, api, state: api.state };
}

async function teardown(context) {
  context.ui.destroy();
  context.renderer.destroy();
}

async function settle(context, needle, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await context.renderOnce();
    if (!needle || context.captureCharFrame().includes(needle)) break;
  }
  await context.flush();
}

async function openCommand(context, command) {
  context.mockInput.pressTab();
  await context.mockInput.typeText(`/${command}`);
  context.mockInput.pressEnter();
  await settle(context);
}

const humanRequest = {
  sessionID: "sess-bob",
  participantId: "bob",
  name: "bob",
  isAgent: false,
  createdAt: 1000,
};
const agentRequest = {
  sessionID: "sess-ops",
  participantId: "ops",
  name: "ops",
  isAgent: true,
  createdAt: 2000,
};

test("join requests list name, kind and time and approve or deny the selection", async () => {
  const api = makeApi({ requests: [humanRequest, agentRequest] });
  const context = await setup(api);
  try {
    await openCommand(context, "join-requests");
    await settle(context, "bob");
    let frame = context.captureCharFrame();
    assert.match(frame, /Join requests/);
    assert.match(frame, /bob · Human ·/);
    assert.match(frame, /ops · Agent ·/);

    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Approve "bob"/);
    context.mockInput.pressEnter();
    await settle(context, "approved bob");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "decideJoin"),
      ["decideJoin", "r1", "sess-bob", "s1", "approve"],
    );
    frame = context.captureCharFrame();
    assert.match(frame, /ops · Agent ·/);
    assert.doesNotMatch(frame, /bob · Human ·/);

    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Deny "ops"/);
    context.mockInput.pressEnter();
    await settle(context, "denied ops");
    assert.deepEqual(
      context.api.calls.filter((call) => call[0] === "decideJoin").at(-1),
      ["decideJoin", "r1", "sess-ops", "s1", "deny"],
    );
    assert.match(context.captureCharFrame(), /Nothing here/);
  } finally {
    await teardown(context);
  }
});

test("join-review 403 errors use the reviewer rule in plain language", async () => {
  const api = makeApi();
  api.state.failList = true;
  const context = await setup(api);
  try {
    await context.app.openJoinRequests();
    await settle(context, "designated management agent");
    assert.match(
      context.captureCharFrame(),
      /only a human administrator or the designated management agent may decide/,
    );
    assert.equal(context.app.state.palette?.kind, "join-requests");
  } finally {
    await teardown(context);
  }
});

test("a 403 on approve stays on the list with the reviewer error", async () => {
  const api = makeApi({ requests: [humanRequest] });
  const context = await setup(api);
  try {
    await context.app.openJoinRequests();
    await settle(context, "bob");
    api.state.failDecision = true;
    context.mockInput.pressEnter();
    await context.renderOnce();
    context.mockInput.pressEnter();
    await settle(context, "designated management agent");
    assert.match(
      context.captureCharFrame(),
      /only a human administrator or the designated management agent may decide/,
    );
    assert.equal(context.app.state.palette?.mode, "info");
    assert.match(context.captureCharFrame(), /bob · Human ·/);
  } finally {
    await teardown(context);
  }
});

test("/ask sends a question message and keeps normal sends untouched", async () => {
  const api = makeApi();
  const context = await setup(api);
  try {
    await openCommand(context, "ask");
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "message-ask");
    assert.match(context.captureCharFrame(), /Question text/);
    await context.mockInput.typeText("ship today?");
    context.mockInput.pressEnter();
    await settle(context, "question sent");
    const call = context.api.calls.find((item) => item[0] === "send");
    assert.deepEqual(call.slice(1), ["r1", "s1", "ship today?", { isQuestion: true }]);
    assert.match(context.captureCharFrame(), /question sent/);

    await context.app.setDraft("normal message");
    await context.app.send();
    const sends = context.api.calls.filter((item) => item[0] === "send");
    assert.deepEqual(sends.at(-1).slice(1), ["r1", "s1", "normal message"]);
  } finally {
    await teardown(context);
  }
});

test("files delete asks for confirmation and refreshes the list", async () => {
  const api = makeApi({
    files: [{ id: "f1", name: "notes.txt", size: 12, uploaderName: "bob", createdAt: 1000 }],
  });
  const context = await setup(api);
  try {
    await context.app.openFiles();
    await settle(context, "notes.txt");
    assert.match(context.captureCharFrame(), /d delete/);
    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Delete file "notes\.txt"/);
    context.mockInput.pressEnter();
    await settle(context, "deleted notes.txt");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "deleteResource"),
      ["deleteResource", "r1", "f1", "s1"],
    );
    assert.match(context.captureCharFrame(), /Nothing here/);
  } finally {
    await teardown(context);
  }
});

test("file delete server errors stay visible and keep the file listed", async () => {
  const api = makeApi({
    files: [{ id: "f1", name: "notes.txt", size: 12, uploaderName: "bob", createdAt: 1000 }],
  });
  const context = await setup(api);
  try {
    await context.app.openFiles();
    await settle(context, "notes.txt");
    api.state.failDelete = true;
    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    context.mockInput.pressEnter();
    await settle(context, "forbidden: your session cannot delete this file");
    assert.match(context.captureCharFrame(), /forbidden: your session cannot delete this file/);
    assert.match(context.captureCharFrame(), /notes\.txt/);
    assert.equal(context.app.state.palette?.mode, "info");
  } finally {
    await teardown(context);
  }
});