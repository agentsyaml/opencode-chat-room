import test from "node:test";
import assert from "node:assert/strict";
import { CliRenderEvents, RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";
import { updateRoomStyles } from "../ui-content.mjs";
import { themeFor } from "../ui-theme.mjs";

const message = (id, text, createdAt, extra = {}) => ({ id, senderId: "bob", text, createdAt, ...extra });

const rooms = [
  { id: "r1", name: "general", participants: [{ id: "alex", name: "alex" }, { id: "bob", name: "bob" }], joined: true },
  { id: "r2", name: "design", participants: [{ id: "alex", name: "alex" }], joined: false },
];

function history(count = 3) {
  return Array.from({ length: count }, (_, index) =>
    message(`m${index}`, `hello ${index} <at>@tip</at>`, 1000 + index * 1000));
}

function fakeApi({ messages = history(), joinPending = false } = {}) {
  const api = {
    calls: [],
    async listRooms(sessionID) {
      api.calls.push(["listRooms", sessionID]);
      return rooms.map((room) => ({ ...room }));
    },
    async getRoom(id) {
      api.calls.push(["getRoom", id]);
      const room = rooms.find((item) => item.id === id);
      return { id, name: room.name, participants: room.participants, messages };
    },
    async join(id, sessionID, name) {
      api.calls.push(["join", id, sessionID, name]);
      if (joinPending) return { pending: true, message: "Waiting for an administrator" };
      const room = rooms.find((item) => item.id === id);
      return { pending: false, room: { id, name: room.name, participants: room.participants, messages } };
    },
    async joinStatus() {
      return "pending";
    },
    async send(id, sessionID, text) {
      api.calls.push(["send", id, sessionID, text]);
      return message("sent", text, 5000, { senderId: "alex" });
    },
    async poll() {
      return { member: true, items: [], hasMore: false, recallVersion: 1 };
    },
    async markRead(id, sessionID, ts) {
      api.calls.push(["markRead", id, sessionID, ts]);
    },
  };
  return api;
}

async function setup({ width = 80, height = 24, api = fakeApi() } = {}) {
  const context = await createTestRenderer({ width, height });
  const app = createApp({ api, sessionID: "s1", participant: "alex", autoPoll: false });
  await app.init();
  const ui = createTui(context.renderer, app);
  await context.renderOnce();
  return { ...context, app, ui, api };
}

async function teardown(context) {
  context.ui.destroy();
  context.renderer.destroy();
}

async function settle(context, needle) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await context.renderOnce();
    if (!needle || context.captureCharFrame().includes(needle)) break;
  }
  await context.flush();
}

test("renders header, rooms, messages and composer", async () => {
  const api = fakeApi({
    messages: [
      message("m1", "hello 世界", 1000),
      message("m2", "lunch?", 2000, { isQuestion: true }),
      message("m3", "hidden body", 3000, { recalledAt: 4000 }),
    ],
  });
  const context = await setup({ api });
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    await settle(context, "hello 世界");
    const frame = context.captureCharFrame();
    assert.match(frame, /opencode-chat-room/);
    assert.match(frame, /alex/);
    assert.match(frame, /connected/);
    assert.match(frame, /● general\s+2/);
    assert.match(frame, /○ design\s+1/);
    assert.match(frame, /# general/);
    assert.match(frame, /2 members/);
    assert.match(frame, /hello 世界/);
    assert.match(frame, /\? \d\d:\d\d bob/);
    assert.match(frame, /lunch\?/);
    assert.match(frame, /\[recalled\]/);
    assert.doesNotMatch(frame, /hidden body/);
    assert.match(frame, /Write a message/);
  } finally {
    await teardown(context);
  }
});

test("Enter opens a joined room and Tab plus typing sends", async () => {
  const context = await setup();
  try {
    context.mockInput.pressEnter();
    await context.waitFor(() => context.app.state.current?.id === "r1");
    await context.renderOnce();
    assert.match(context.captureCharFrame(), /# general/);

    context.mockInput.pressTab();
    await context.renderOnce();
    assert.equal(context.app.state.focus, "composer");
    await context.mockInput.typeText("hi there");
    context.mockInput.pressEnter();
    await context.waitFor(() => context.api.calls.some((call) => call[0] === "send"));
    await context.waitFor(() => context.app.state.messages.some((item) => item.id === "sent"));
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "send"),
      ["send", "r1", "s1", "hi there"],
    );
    assert.equal(context.app.state.draft, "");
  } finally {
    await teardown(context);
  }
});

test("pending join shows the server message and a pending marker", async () => {
  const context = await setup({ api: fakeApi({ joinPending: true }) });
  try {
    context.mockInput.pressArrow("down");
    await context.renderOnce();
    context.mockInput.pressEnter();
    await context.waitFor(() => context.app.state.pending !== null);
    await context.renderOnce();
    const frame = context.captureCharFrame();
    assert.match(frame, /\? design\s+1/);
    assert.match(frame, /Waiting for an administrator/);
    assert.match(frame, /Waiting for approval/);
    assert.equal(context.app.state.joined, false);
  } finally {
    await teardown(context);
  }
});

test("Alt+Space opens the palette and typing searches", async () => {
  const context = await setup();
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    context.mockInput.pressKeys(["\x1b "]);
    await context.renderOnce();
    assert.ok(context.app.state.palette);
    assert.match(context.captureCharFrame(), /Palette/);
    assert.match(context.captureCharFrame(), /commands/);
    assert.match(context.captureCharFrame(), /Refresh rooms/);
    assert.match(context.captureCharFrame(), /Search all joined rooms/);

    await context.mockInput.typeText("hello");
    await context.waitFor(() => context.app.state.palette?.mode === "search");
    await context.renderOnce();
    const frame = context.captureCharFrame();
    assert.match(frame, /Search messages/);
    assert.match(frame, /this room/);
    assert.match(frame, /general/);
    assert.match(frame, /hello/);

    context.mockInput.pressEnter();
    await context.waitFor(() => context.app.state.palette === null);
    assert.equal(context.app.state.highlight, "m2");
    await context.renderOnce();
    assert.match(context.captureCharFrame(), /▸/);

    context.mockInput.pressKeys(["\x1b "]);
    await context.renderOnce();
    assert.ok(context.app.state.palette);
    context.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(context.app.state.palette, null);
    assert.equal(context.app.state.focus, "composer");

    context.mockInput.pressKeys(["\x10"]);
    await context.waitFor(() => context.app.state.palette);
    context.mockInput.pressKeys(["\x10"]);
    await context.waitFor(() => context.app.state.palette === null);
  } finally {
    await teardown(context);
  }
});

test("palette command execution and Esc focus restore", async () => {
  const context = await setup();
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    context.mockInput.pressTab();
    await context.renderOnce();
    context.mockInput.pressKeys(["\x1b "]);
    await context.renderOnce();
    assert.ok(context.app.state.palette);
    for (let index = 0; index < 4; index += 1) context.mockInput.pressArrow("down");
    await context.renderOnce();
    context.mockInput.pressEnter();
    await context.waitFor(() => context.app.state.palette === null);
    assert.equal(context.app.state.help, true);
    assert.equal(context.app.state.focus, "rooms");
  } finally {
    await teardown(context);
  }
});

test("PageUp scrolls the message history", async () => {
  const context = await setup({ api: fakeApi({ messages: history(40) }), height: 20 });
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    await settle(context, "hello 39");
    await context.flush();
    const bottomFrame = context.captureCharFrame();
    assert.match(bottomFrame, /hello 39/);
    assert.doesNotMatch(bottomFrame, /hello 0\b/);
    const before = context.ui.scrollBox.scrollTop;
    assert.ok(before > 0);
    context.mockInput.pressKeys(["\x1b[5~"]);
    await context.renderOnce();
    assert.ok(context.ui.scrollBox.scrollTop < before);
  } finally {
    await teardown(context);
  }
});

test("Ctrl+J inserts a newline and Esc clears the composer", async () => {
  const context = await setup();
  try {
    context.mockInput.pressTab();
    await context.renderOnce();
    await context.mockInput.typeText("first");
    context.mockInput.pressKeys(["\n"]);
    await context.mockInput.typeText("second");
    await context.renderOnce();
    assert.equal(context.ui.textarea.plainText, "first\nsecond");

    context.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.renderOnce();
    assert.equal(context.app.state.draft, "", "draft after escape");
    assert.equal(context.ui.textarea.plainText, "");
    assert.equal(context.app.state.focus, "rooms");
    assert.equal(context.app.state.focus, "rooms");
  } finally {
    await teardown(context);
  }
});

test("help, refresh and quit shortcuts", async () => {
  const context = await setup();
  try {
    context.mockInput.pressKeys(["?"]);
    await context.renderOnce();
    assert.equal(context.app.state.help, true);
    assert.match(context.captureCharFrame(), /Keyboard shortcuts/);
    assert.match(context.captureCharFrame(), /↑ \/ ↓/);

    const before = context.api.calls.filter((call) => call[0] === "listRooms").length;
    context.mockInput.pressKey("r", { ctrl: true });
    await context.waitFor(() => context.api.calls.filter((call) => call[0] === "listRooms").length > before);

    context.mockInput.pressKeys(["?"]);
    await context.renderOnce();
    assert.equal(context.app.state.help, false);
    context.mockInput.pressKeys(["q"]);
    assert.equal(context.app.state.quit, true);
  } finally {
    await teardown(context);
  }
});

test("Ctrl+C quits", async () => {
  const context = await setup();
  try {
    context.mockInput.pressCtrlC();
    assert.equal(context.app.state.quit, true);
  } finally {
    await teardown(context);
  }
});

test("Alt+Home and Alt+End jump through the message history", async () => {
  const context = await setup({ api: fakeApi({ messages: history(40) }), height: 20 });
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    await settle(context, "hello 0");
    context.mockInput.pressKeys(["\x1b\x1b[H"]);
    await context.renderOnce();
    assert.equal(context.ui.scrollBox.scrollTop, 0);
    assert.match(context.captureCharFrame(), /hello 0/);
    context.mockInput.pressKeys(["\x1b\x1b[F"]);
    await context.renderOnce();
    assert.ok(context.ui.scrollBox.scrollTop > 0);
    assert.match(context.captureCharFrame(), /hello 39/);
  } finally {
    await teardown(context);
  }
});

test("selected room, hover and composer focus use theme colors", async () => {
  const context = await setup();
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    const ui = context.ui;
    const selected = ui.roomRows.get("r1").row;
    assert.ok(selected.backgroundColor.equals(RGBA.fromHex(ui.theme.selectedBg)));

    const hovered = ui.roomRows.get("r2").row;
    ui.hoverRoomId = "r2";
    updateRoomStyles(ui, context.app.state);
    assert.ok(hovered.backgroundColor.equals(RGBA.fromHex(ui.theme.raised)));
    ui.hoverRoomId = null;
    updateRoomStyles(ui, context.app.state);

    context.mockInput.pressTab();
    await context.renderOnce();
    assert.ok(ui.composer.borderColor.equals(RGBA.fromHex(ui.theme.accent)));
  } finally {
    await teardown(context);
  }
});

test("renderer theme changes switch the semantic palette", async () => {
  const context = await setup();
  try {
    assert.equal(context.ui.theme.text, themeFor("dark").text);
    context.renderer.emit(CliRenderEvents.THEME_MODE, "light");
    await context.renderOnce();
    assert.equal(context.ui.themeState.mode, "light");
    assert.equal(context.ui.theme.text, themeFor("light").text);
    assert.notEqual(themeFor("light").surface, themeFor("dark").surface);
  } finally {
    await teardown(context);
  }
});

test("narrow terminals hide the room pane", async () => {
  const context = await setup({ width: 80, height: 20 });
  try {
    assert.equal(context.ui.roomsPane.visible, true);
    context.resize(60, 20);
    await context.renderOnce();
    assert.equal(context.ui.roomsPane.visible, false);
    assert.doesNotMatch(context.captureCharFrame(), /design/);
    assert.equal(context.ui.composer.x, 0);
    assert.equal(context.ui.statusHints.visible, false);
    context.resize(80, 20);
    await context.renderOnce();
    assert.equal(context.ui.roomsPane.visible, true);
    assert.equal(context.ui.composer.x, 1);
  } finally {
    await teardown(context);
  }
});

test("typing from the room list keeps the first character first", async () => {
  const context = await setup();
  try {
    assert.equal(context.app.state.focus, "rooms");
    context.mockInput.typeText("hello");
    await context.renderOnce();
    assert.equal(context.app.state.focus, "composer");
    assert.equal(context.app.state.draft, "hello");
    assert.equal(context.ui.textarea.plainText, "hello");
    assert.equal(context.ui.textarea.cursorOffset, 5);
  } finally {
    await teardown(context);
  }
});