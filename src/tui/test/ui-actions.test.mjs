import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";
import { parseReminderSchedule } from "../info-content.mjs";

const baseRoom = (overrides = {}) => ({
  id: "r1",
  name: "general",
  description: "Team room",
  joinPolicy: "open",
  ownerId: "alex",
  adminIds: ["carol"],
  successorId: "bob",
  adminSessionID: "s9",
  kind: "group",
  participants: [
    { id: "alex", name: "alex" },
    { id: "bob", name: "bob" },
    { id: "carol", name: "carol" },
  ],
  ...overrides,
});

function makeApi({ room = baseRoom(), messages = [], reminderSeed = [] } = {}) {
  const state = {
    room,
    messages: [...messages],
    reminders: [...reminderSeed],
    deleted: false,
    calls: [],
  };
  const api = {
    state,
    calls: state.calls,
    async listRooms() {
      return [{ id: room.id, name: room.name, participants: room.participants, joined: true }];
    },
    async getRoom() {
      return { ...room, messages: state.messages };
    },
    async join() {
      return { pending: false };
    },
    async send(id, sessionID, text, options) {
      state.calls.push(["send", id, sessionID, text, options]);
      const sent = { id: "sent", senderId: "alex", text, createdAt: 9000 };
      state.messages.push(sent);
      return sent;
    },
    async poll() {
      return { member: true, items: [] };
    },
    async markRead() {},
    async members() {
      return [
        { sessionID: "s1", name: "alex", type: "human", activity: { state: "idle" } },
        { sessionID: "s2", name: "bob", type: "human", activity: { state: "idle" } },
        { sessionID: "s9", name: "ops", type: "agent", activity: { state: "working" } },
      ];
    },
    async reminders() {
      return state.reminders.map((item) => ({ ...item, schedule: { ...item.schedule } }));
    },
    async createReminder(roomID, sessionID, text, schedule) {
      state.calls.push(["createReminder", roomID, sessionID, text, schedule]);
      const reminder = {
        id: `rem${state.reminders.length + 1}`,
        text,
        schedule,
        paused: false,
        nextRunAt: "2026-11-23T01:00:00.000Z",
      };
      state.reminders.push(reminder);
      return reminder;
    },
    async updateReminder(roomID, reminderID, sessionID, patch) {
      state.calls.push(["updateReminder", roomID, reminderID, sessionID, patch]);
      const reminder = state.reminders.find((item) => item.id === reminderID);
      if (reminder) Object.assign(reminder, patch);
      return reminder;
    },
    async deleteReminder(roomID, reminderID, sessionID) {
      state.calls.push(["deleteReminder", roomID, reminderID, sessionID]);
      state.reminders = state.reminders.filter((item) => item.id !== reminderID);
    },
    async updateRoom(roomID, sessionID, patch) {
      state.calls.push(["updateRoom", roomID, sessionID, patch]);
      Object.assign(state.room, patch);
      return { ...state.room };
    },
    async deleteRoom(roomID, sessionID) {
      state.calls.push(["deleteRoom", roomID, sessionID]);
      state.deleted = true;
      return { ok: true };
    },
    async recall(roomID, messageID, sessionID) {
      state.calls.push(["recall", roomID, messageID, sessionID]);
      return { ok: true };
    },
    async reveal(roomID, messageID, sessionID) {
      state.calls.push(["reveal", roomID, messageID, sessionID]);
      return { messageID, text: "the original secret", senderId: "bob", createdAt: 1000, recalledAt: 2000 };
    },
    async resources() {
      return { resources: [], total: 0 };
    },
  };
  return api;
}

async function setup({ api = makeApi() } = {}) {
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

test("reminder schedule parser rejects bad fields and timezones", () => {
  assert.deepEqual(parseReminderSchedule("cron 0 9 * * * Asia/Shanghai"), {
    type: "cron",
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  });
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(parseReminderSchedule(`once ${future}`), { type: "once", at: future });
  assert.throws(() => parseReminderSchedule("cron 0 9"), /5 fields/);
  assert.throws(() => parseReminderSchedule("cron 0 9 * * * Mars/Base"), /invalid timezone/);
  assert.throws(() => parseReminderSchedule("once 2020-01-01T00:00"), /future/);
  assert.throws(() => parseReminderSchedule("later"), /start with/);
});

test("reminders support create, pause, edit and delete from the overlay", async () => {
  const context = await setup();
  try {
    await openCommand(context, "reminders");
    assert.match(context.captureCharFrame(), /Reminders/);
    await context.app.openReminders();
    await settle(context, "Nothing here");

    context.mockInput.pressKeys(["n"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "reminder-text");
    await context.mockInput.typeText("standup");
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "reminder-schedule");
    await context.mockInput.typeText("cron 0 9 * * * Asia/Shanghai");
    context.mockInput.pressEnter();
    await settle(context, "standup");
    const created = context.api.calls.find((call) => call[0] === "createReminder");
    assert.equal(created[3], "standup");
    assert.deepEqual(created[4], { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" });

    context.mockInput.pressKeys(["p"]);
    await settle(context, "paused reminder");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "updateReminder").slice(3),
      ["s1", { paused: true }],
    );
    assert.match(context.captureCharFrame(), /⏸ standup/);

    context.mockInput.pressKeys(["e"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "reminder-edit-text");
    context.app.setPalettePrompt("renamed reminder");
    context.mockInput.pressEnter();
    await settle(context, "renamed reminder");
    assert.deepEqual(
      context.api.calls.filter((call) => call[0] === "updateReminder").at(-1).slice(3),
      ["s1", { text: "renamed reminder" }],
    );

    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Delete reminder "renamed reminder"/);
    context.mockInput.pressEnter();
    await settle(context, "reminder deleted");
    assert.equal(context.api.calls.some((call) => call[0] === "deleteReminder"), true);
    assert.match(context.captureCharFrame(), /Nothing here/);
  } finally {
    await teardown(context);
  }
});

test("invalid reminder schedules stay in the prompt with an actionable error", async () => {
  const context = await setup();
  try {
    await context.app.openReminders();
    await settle(context, "Nothing here");
    context.mockInput.pressKeys(["n"]);
    await context.renderOnce();
    await context.mockInput.typeText("standup");
    context.mockInput.pressEnter();
    await context.renderOnce();
    await context.mockInput.typeText("cron 0 9");
    context.mockInput.pressEnter();
    await settle(context, "cron needs 5 fields");
    assert.equal(context.api.calls.some((call) => call[0] === "createReminder"), false);
    assert.equal(context.app.state.palette?.mode, "prompt");
  } finally {
    await teardown(context);
  }
});

test("reminder permission errors stay visible in the overlay", async () => {
  const api = makeApi({
    reminderSeed: [{
      id: "rem1",
      text: "standup",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      paused: false,
      nextRunAt: "2026-11-23T01:00:00.000Z",
    }],
  });
  api.updateReminder = async () => {
    throw new Error("forbidden: your session is not a room member or lacks permission (HTTP 403)");
  };
  const context = await setup({ api });
  try {
    await context.app.openReminders();
    await settle(context, "standup");
    context.mockInput.pressKeys(["p"]);
    await settle(context, "forbidden");
    assert.match(context.captureCharFrame(), /forbidden: your session/);
    assert.equal(context.app.state.palette?.mode, "info");
    assert.equal(context.app.state.palette?.kind, "reminders");
  } finally {
    await teardown(context);
  }
});

test("room settings shows roles and applies rename, description and policy", async () => {
  const context = await setup();
  try {
    await openCommand(context, "room-settings");
    await settle(context, "Your role: owner");
    let frame = context.captureCharFrame();
    assert.match(frame, /Room settings/);
    assert.match(frame, /Description.*Team room/);
    assert.match(frame, /Join policy.*open/);
    assert.match(frame, /Owner.*alex/);
    assert.match(frame, /Admins.*carol/);
    assert.match(frame, /Successor.*bob/);
    assert.match(frame, /Management agent.*ops \(agent\)/);
    assert.match(frame, /Your role.*owner/);
    assert.match(frame, /Editing.*available/);
    assert.match(frame, /r rename · d desc · j policy/);
    assert.match(frame, /x delete/);

    context.mockInput.pressKeys(["r"]);
    await context.renderOnce();
    context.app.setPalettePrompt("renamed room");
    context.mockInput.pressEnter();
    await settle(context, "renamed room");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "updateRoom").slice(2),
      ["s1", { name: "renamed room" }],
    );

    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    context.app.setPalettePrompt("new description");
    context.mockInput.pressEnter();
    await settle(context, "new description");
    assert.deepEqual(
      context.api.calls.filter((call) => call[0] === "updateRoom").at(-1).slice(2),
      ["s1", { description: "new description" }],
    );

    context.mockInput.pressKeys(["j"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Set join policy to approval/);
    context.mockInput.pressEnter();
    await settle(context, "join policy set to approval");
    assert.deepEqual(
      context.api.calls.filter((call) => call[0] === "updateRoom").at(-1).slice(2),
      ["s1", { joinPolicy: "approval" }],
    );
    frame = context.captureCharFrame();
    assert.match(frame, /Join policy.*approval/);
  } finally {
    await teardown(context);
  }
});

test("room owner can delete the room after a destructive confirmation", async () => {
  const context = await setup();
  try {
    await openCommand(context, "delete-room");
    await settle(context, "cannot be undone");
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Delete #general/);
    context.mockInput.pressEnter();
    await settle(context, "deleted #general");
    assert.deepEqual(context.api.calls.find((call) => call[0] === "deleteRoom").slice(1), ["r1", "s1"]);
    assert.equal(context.api.state.deleted, true);
    assert.equal(context.app.state.current, null);
  } finally {
    await teardown(context);
  }
});

test("non-owners get a read-only room settings summary", async () => {
  const api = makeApi({ room: baseRoom({ ownerId: "bob", adminIds: [], successorId: null, adminSessionID: null }) });
  const context = await setup({ api });
  try {
    await context.app.openRoomSettings();
    await settle(context, "Your role: member");
    assert.match(context.captureCharFrame(), /Editing.*read-only/);
    assert.match(context.captureCharFrame(), /Read-only · Esc close/);
    context.mockInput.pressKeys(["r"]);
    await settle(context, "only the room owner or an admin");
    assert.equal(context.api.calls.some((call) => call[0] === "updateRoom"), false);
    assert.equal(context.app.state.palette?.mode, "detail");
    context.app.askDeleteRoom();
    await settle(context, "only the room owner can delete");
    assert.equal(context.app.state.palette?.mode, "detail");
  } finally {
    await teardown(context);
  }
});

test("cancelling reminder and room-settings confirms restores the previous overlay", async () => {
  const api = makeApi({
    reminderSeed: [{
      id: "rem1",
      text: "standup",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      paused: false,
      nextRunAt: "2026-11-23T01:00:00.000Z",
    }],
  });
  const context = await setup({ api });
  try {
    await context.app.openReminders();
    await settle(context, "standup");
    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    context.mockInput.pressKeys(["n"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "info");
    assert.equal(context.app.state.palette?.kind, "reminders");
    assert.match(context.app.state.palette?.hint ?? "", /pause\/resume/);
    assert.doesNotMatch(context.captureCharFrame(), /Announcements/);

    context.app.closePalette();
    await context.app.openRoomSettings();
    await settle(context, "Your role: owner");
    context.mockInput.pressKeys(["j"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    context.mockInput.pressKeys(["n"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "detail");
    assert.equal(context.app.state.palette?.kind, "room-settings");
    assert.match(context.app.state.palette?.hint ?? "", /r rename/);
    assert.doesNotMatch(context.captureCharFrame(), /Announcements/);
  } finally {
    await teardown(context);
  }
});

test("file upload rejects files over 100 MiB before reading", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tui-big-"));
  const file = path.join(directory, "big.bin");
  await writeFile(file, "");
  await truncate(file, 100 * 1024 * 1024 + 1);
  const context = await setup();
  try {
    await context.app.openFiles();
    await settle(context, "Nothing here");
    context.mockInput.pressKeys(["u"]);
    await context.renderOnce();
    assert.match(context.captureCharFrame(), /Absolute file path \(max 100 MiB\)/);
    await context.mockInput.typeText(file);
    context.mockInput.pressEnter();
    await settle(context, "too large");
    assert.match(context.captureCharFrame(), /too large for terminal upload; limit 100 MiB/);
    assert.equal(context.api.calls.some((call) => call[0] === "uploadResource"), false);
  } finally {
    await teardown(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("message recall, reveal and reply flows use the message API", async () => {
  const api = makeApi({ messages: [{ id: "m1", senderId: "bob", text: "secret", createdAt: 1000 }] });
  const context = await setup({ api });
  try {
    await openCommand(context, "recall");
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "message-recall-id");
    await context.mockInput.typeText("m1");
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    context.mockInput.pressEnter();
    await settle(context, "recalled m1");
    assert.deepEqual(context.api.calls.find((call) => call[0] === "recall").slice(1), ["r1", "m1", "s1"]);

    await openCommand(context, "reveal");
    await context.renderOnce();
    await context.mockInput.typeText("m1");
    context.mockInput.pressEnter();
    await context.renderOnce();
    context.mockInput.pressEnter();
    await settle(context, "the original secret");
    assert.match(context.captureCharFrame(), /Revealed message/);
    assert.deepEqual(context.api.calls.find((call) => call[0] === "reveal").slice(1), ["r1", "m1", "s1"]);
    context.app.closePalette();

    await openCommand(context, "reply");
    await context.renderOnce();
    await context.mockInput.typeText("m1");
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "message-reply-text");
    await context.mockInput.typeText("yes, on it");
    context.mockInput.pressEnter();
    await settle(context, "reply sent");
    const sent = context.api.calls.find((call) => call[0] === "send");
    assert.deepEqual(sent.slice(1), ["r1", "s1", "yes, on it", { replyToMessageID: "m1" }]);
  } finally {
    await teardown(context);
  }
});