import test from "node:test";
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";
import { themeFor } from "../ui-theme.mjs";

const rooms = [
  { id: "r1", name: "general", participants: [{ id: "alex", name: "alex" }, { id: "bob", name: "bob" }], joined: true },
  { id: "r2", name: "design", participants: [{ id: "alex", name: "alex" }], joined: false },
];
const messages = [
  { id: "m1", senderId: "bob", text: "hello room", createdAt: 1000 },
  { id: "m2", senderId: "alex", text: "hi bob", createdAt: 2000 },
];

function fakeApi({ roomList = rooms, failList = false } = {}) {
  return {
    async listRooms() {
      if (failList) throw new Error("network down");
      return roomList.map((room) => ({ ...room }));
    },
    async getRoom(id) {
      return { id, name: "general", participants: rooms[0].participants, messages };
    },
    async join() { return { pending: false }; },
    async poll() { return { member: true, items: [] }; },
    async markRead() {},
  };
}

async function setup({ width = 80, height = 24, api = fakeApi(), settings = {} } = {}) {
  const context = await createTestRenderer({ width, height });
  const app = createApp({ api, sessionID: "s1", participant: "alex", autoPoll: false, settings });
  await app.init();
  const ui = createTui(context.renderer, app);
  await context.renderOnce();
  return { ...context, app, ui };
}

async function teardown(context) {
  context.ui.destroy();
  context.renderer.destroy();
}

function frameLines(context) {
  return context.captureCharFrame().split("\n").filter((line, index, all) => index < all.length - 1);
}

test("room rail and footer adapt at 80, 100 and 120 columns", async () => {
  for (const [width, rail] of [[80, 24], [100, 28], [120, 32]]) {
    const context = await setup({ width, height: 24 });
    try {
      await context.app.openRoom(0);
      await context.renderOnce();
      assert.equal(context.ui.roomsPane.visible, true, `${width}`);
      assert.equal(context.ui.roomsPane.width, rail, `${width}`);
      assert.equal(context.ui.roomsFooter.visible, true);
      assert.equal(context.ui.statusHints.visible, true);
      for (const line of frameLines(context)) {
        assert.ok(line.length <= width, `${width}: line wider than terminal: ${line.length}`);
      }
      const frame = context.captureCharFrame();
      assert.match(frame, /opencode-chat-room/);
      assert.match(frame, /connected/, "connection state must be text, not color only");
      assert.match(frame, /Tab composer/);
    } finally {
      await teardown(context);
    }
  }
});

test("narrow terminals keep the chat usable without the rail", async () => {
  const context = await setup({ width: 60, height: 20 });
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    assert.equal(context.ui.roomsPane.visible, false);
    assert.equal(context.ui.composer.x, 0);
    assert.equal(context.ui.statusHints.visible, false);
    assert.doesNotMatch(context.captureCharFrame(), /design/);
    assert.match(context.captureCharFrame(), /# general/);
    assert.match(context.captureCharFrame(), /Write a message/);
  } finally {
    await teardown(context);
  }
});

test("short terminals compact the composer and help overlay inside the screen", async () => {
  const context = await setup({ width: 90, height: 14 });
  try {
    await context.app.openRoom(0);
    context.app.toggleHelp();
    await context.renderOnce();
    assert.equal(context.ui.composer.height, 4);
    assert.ok(context.ui.helpBox.y >= 0);
    assert.ok(context.ui.helpBox.y + context.ui.helpBox.height <= context.renderer.height);
    const frame = context.captureCharFrame();
    assert.match(frame, /Keyboard shortcuts/);
    assert.match(frame, /↑ \/ ↓/);
    assert.doesNotMatch(frame, /Alt\+Home/, "compact help drops low-priority rows");
    assert.doesNotMatch(frame, /Ctrl\+R/, "compact help drops low-priority rows");
  } finally {
    await teardown(context);
  }
});

test("the palette stays inside the screen and keeps a stable hint row", async () => {
  const context = await setup({ width: 80, height: 20 });
  try {
    context.app.openPalette({ slash: true });
    await context.renderOnce();
    assert.ok(context.ui.paletteBox.y >= 0);
    assert.ok(context.ui.paletteBox.y + context.ui.paletteBox.height <= context.renderer.height);
    assert.ok(context.ui.paletteBox.x >= 0);
    assert.ok(context.ui.paletteBox.x + context.ui.paletteBox.width <= context.renderer.width);
    assert.match(context.captureCharFrame(), /↑↓ select · Enter run · Esc close/);
  } finally {
    await teardown(context);
  }
});

test("empty and offline states are explained in plain text", async () => {
  const empty = await setup({ api: fakeApi({ roomList: [] }) });
  try {
    const frame = empty.captureCharFrame();
    assert.match(frame, /No rooms yet/);
    assert.match(frame, /Ctrl\+R refresh/);
    assert.match(frame, /connected/);
  } finally {
    await teardown(empty);
  }
  const offline = await setup({ api: fakeApi({ failList: true }) });
  try {
    const frame = offline.captureCharFrame();
    assert.match(frame, /offline/);
    assert.match(frame, /could not refresh rooms/);
  } finally {
    await teardown(offline);
  }
});

test("overlays dim the background and keep the palette inset", async () => {
  const context = await setup({ width: 120, height: 30 });
  try {
    context.app.openPalette({ slash: true });
    await context.renderOnce();
    assert.equal(context.ui.overlayBackdrop.visible, true);
    assert.ok(context.ui.paletteBox.x > 0, "wide palettes stay inset");
    assert.ok(context.ui.paletteBox.width < context.renderer.width);
    context.app.closePalette();
    await context.renderOnce();
    assert.equal(context.ui.overlayBackdrop.visible, false);
    context.app.toggleHelp();
    await context.renderOnce();
    assert.equal(context.ui.overlayBackdrop.visible, true);
    assert.match(context.captureCharFrame(), /\/exit/);
    assert.match(context.captureCharFrame(), /Ctrl\+C/);
  } finally {
    await teardown(context);
  }
});

test("the settings surface lists every editable preference plus details", async () => {
  const context = await setup({ width: 100, height: 28 });
  try {
    context.app.openSettingsEditor();
    await context.renderOnce();
    const frame = context.captureCharFrame();
    for (const label of ["Language", "Display name", "Server URL", "Theme", "Connection details"]) {
      assert.match(frame, new RegExp(label), label);
    }
    assert.match(frame, /Enter edit · Esc close/);
    assert.equal(context.app.state.palette.kind, "settings");
    context.app.state.palette.selected = context.app.settingsItems().length - 1;
    await context.app.runInfoSelection();
    assert.equal(context.app.state.palette.mode, "detail");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await context.renderOnce();
      if (context.captureCharFrame().includes("Token")) break;
    }
    await context.flush();
    assert.match(context.captureCharFrame(), /Token/);
  } finally {
    await teardown(context);
  }
});

test("switching language updates visible labels without a restart", async () => {
  const context = await setup({ settings: { language: "en" } });
  try {
    await context.app.openRoom(0);
    await context.renderOnce();
    assert.match(context.captureCharFrame(), /ROOMS/);
    context.app.state.language = "zh-CN";
    context.app.touch();
    await context.renderOnce();
    let frame = context.captureCharFrame();
    assert.match(frame, /房间/);
    assert.match(frame, /已连接/);
    assert.match(frame, /输入消息/);
    assert.match(frame, /Tab 输入/);
    context.app.state.language = "en";
    context.app.touch();
    await context.renderOnce();
    frame = context.captureCharFrame();
    assert.match(frame, /ROOMS/);
    assert.match(frame, /connected/);
    context.app.state.theme = "light";
    context.app.touch();
    await context.renderOnce();
    assert.equal(context.ui.themeState.mode, "light");
    assert.equal(context.ui.theme.text, themeFor("light").text);
  } finally {
    await teardown(context);
  }
});