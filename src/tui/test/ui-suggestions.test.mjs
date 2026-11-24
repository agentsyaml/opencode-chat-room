import test from "node:test";
import assert from "node:assert/strict";
import { CliRenderEvents, RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";
import { canonicalizeMentions, mentionTrigger } from "../mentions.mjs";

const participants = [
  { id: "alex", name: "alex" },
  { id: "bob", name: "Bob" },
  { id: "carol", name: "Carol" },
  { id: "mary", name: "mary jane" },
];

function makeApi() {
  const state = { calls: [], messages: [] };
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
    async send(id, sessionID, text) {
      state.calls.push(["send", id, sessionID, text]);
      return { id: "sent", senderId: "alex", text, createdAt: 5000 };
    },
    async members() {
      return [
        { sessionID: "s1", name: "alex", type: "human", activity: { state: "idle" } },
        { sessionID: "s2", name: "Bob", type: "human", activity: { state: "idle" } },
      ];
    },
  };
  return api;
}

async function setup() {
  const context = await createTestRenderer({ width: 96, height: 28 });
  const app = createApp({ api: makeApi(), sessionID: "s1", participant: "alex", host: "server", autoPoll: false });
  await app.init();
  const ui = createTui(context.renderer, app);
  await app.openRoom(0);
  await context.renderOnce();
  return { ...context, app, ui, api: app.api, state: app.api.state };
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

async function until(check, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function focusComposer(context) {
  context.mockInput.pressTab();
  await context.renderOnce();
  assert.equal(context.app.state.focus, "composer");
}

test("slash stays in the composer and opens a popup above it", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("/");
    await context.renderOnce();
    assert.equal(context.app.state.palette, null);
    assert.equal(context.app.state.draft, "/");
    assert.equal(context.app.state.focus, "composer");
    assert.equal(context.ui.textarea.plainText, "/");
    assert.equal(context.ui.suggestBox.visible, true);
    assert.equal(context.ui.suggestKind, "slash");
    assert.equal(context.ui.paletteInput.focused, false);
    assert.ok(context.ui.focusKey === "composer" || context.ui.textarea.focused);
    assert.ok(
      context.ui.suggestBox.y + context.ui.suggestBox.height <= context.ui.composer.y,
      `popup ${context.ui.suggestBox.y}+${context.ui.suggestBox.height} composer ${context.ui.composer.y}`,
    );
    assert.match(context.captureCharFrame(), /commands/);
    assert.match(context.captureCharFrame(), /Refresh rooms/);
  } finally {
    await teardown(context);
  }
});

test("slash from the room list focuses the composer with the same popup", async () => {
  const context = await setup();
  try {
    assert.equal(context.app.state.focus, "rooms");
    await context.mockInput.typeText("/");
    await context.renderOnce();
    assert.equal(context.app.state.focus, "composer");
    assert.equal(context.app.state.draft, "/");
    assert.equal(context.app.state.palette, null);
    assert.equal(context.ui.textarea.plainText, "/");
    assert.equal(context.ui.suggestBox.visible, true);
    assert.equal(context.ui.suggestKind, "slash");
  } finally {
    await teardown(context);
  }
});

test("slash filters, moves selection and runs a command without the full palette first", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("/mem");
    await context.renderOnce();
    assert.deepEqual(context.ui.suggestItems.map((item) => item.id), ["members"]);
    context.mockInput.pressArrow("down");
    await context.renderOnce();
    context.mockInput.pressEnter();
    await settle(context, "Members");
    assert.equal(await until(() => context.app.state.palette?.kind === "members"), true);
    assert.equal(context.app.state.draft, "");
    assert.equal(context.ui.textarea.plainText, "");
    assert.equal(context.ui.suggestBox.visible, false);
    assert.equal(context.app.state.focus, "composer");
  } finally {
    await teardown(context);
  }
});

test("slash Esc keeps the draft and removing the slash closes the popup", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("/mem");
    await context.renderOnce();
    context.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.renderOnce();
    assert.equal(context.app.state.palette, null);
    assert.equal(context.app.state.draft, "/mem");
    assert.equal(context.ui.suggestBox.visible, false);
    assert.equal(context.app.state.focus, "composer");
    for (let index = 0; index < 4; index += 1) context.mockInput.pressBackspace();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "");
    assert.equal(context.ui.suggestBox.visible, false);
  } finally {
    await teardown(context);
  }
});

test("unmatched slash sends as a normal message", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("/zzz");
    await context.renderOnce();
    assert.equal(context.ui.suggestBox.visible, true);
    assert.equal(context.ui.suggestItems.length, 0);
    context.mockInput.pressEnter();
    await settle(context, "sent");
    const sent = context.api.calls.find((call) => call[0] === "send");
    assert.equal(sent[3], "/zzz");
    assert.equal(context.ui.suggestBox.visible, false);
  } finally {
    await teardown(context);
  }
});

test("inline slash suggestions also keep their creation-time snapshot", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("/");
    await context.renderOnce();
    const before = context.ui.suggestSnapshot.length;
    context.app.state.rooms.push({ id: "r2", name: "designer", participants: [], joined: false });
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.ui.suggestSnapshot.length, before);
    assert.equal(context.ui.suggestItems.some((command) => command.roomId === "r2"), false);
  } finally {
    await teardown(context);
  }
});

test("full palette commands are snapshotted until it is reopened", async () => {
  const context = await setup();
  try {
    context.app.openPalette({ slash: true });
    await context.renderOnce();
    const before = context.app.state.palette.commands.length;
    context.app.state.rooms.push({ id: "r2", name: "designer", participants: [], joined: false });
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.app.state.palette.commands.length, before);
    assert.equal(context.app.paletteCommands().length, before);
    assert.doesNotMatch(context.captureCharFrame(), /Join #designer/);

    context.app.closePalette();
    context.app.openPalette({ slash: true });
    await context.renderOnce();
    assert.equal(context.app.state.palette.commands.length, before + 1);
    assert.match(context.captureCharFrame(), /Join #designer/);
  } finally {
    await teardown(context);
  }
});

test("@ opens member suggestions, inserts @Bob and sends the wire tag", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("@");
    await context.renderOnce();
    assert.equal(context.app.state.palette, null);
    assert.equal(context.ui.suggestKind, "mention");
    assert.equal(context.ui.suggestBox.visible, true);
    assert.deepEqual(context.ui.suggestItems.map((item) => item.name), ["alex", "Bob", "Carol", "mary jane", "all"]);
    assert.equal(context.app.state.focus, "composer");

    await context.mockInput.typeText("b");
    await context.renderOnce();
    assert.deepEqual(context.ui.suggestItems.map((item) => item.name), ["Bob"]);
    context.mockInput.pressBackspace();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "@");
    assert.equal(context.ui.suggestItems.length, 5);
    context.mockInput.pressArrow("down");
    await context.renderOnce();
    assert.equal(context.ui.suggestSelected, 1);
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "@Bob ");
    assert.equal(context.ui.textarea.plainText, "@Bob ");
    assert.equal(context.ui.textarea.cursorOffset, 5);
    assert.equal(context.ui.suggestBox.visible, false);
    assert.equal(context.app.state.focus, "composer");
    const marks = context.ui.textarea.extmarks.getAll();
    assert.equal(marks.length, 1);
    assert.deepEqual([marks[0].start, marks[0].end], [0, 4]);

    context.mockInput.pressEnter();
    await settle(context, "sent");
    const sent = context.api.calls.find((call) => call[0] === "send");
    assert.deepEqual(sent.slice(1), ["r1", "s1", "<at>@Bob</at>"]);
  } finally {
    await teardown(context);
  }
});

test("spaced display names filter, insert and canonicalize", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("@mary j");
    await context.renderOnce();
    assert.equal(context.ui.suggestBox.visible, true);
    assert.deepEqual(context.ui.suggestItems.map((item) => item.name), ["mary jane"]);
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "@mary jane ");
    assert.equal(context.ui.textarea.plainText, "@mary jane ");
    assert.deepEqual(
      context.ui.textarea.extmarks.getAll().map((mark) => [mark.start, mark.end]),
      [[0, 10]],
    );
    context.mockInput.pressEnter();
    await settle(context, "sent");
    const sent = context.api.calls.find((call) => call[0] === "send");
    assert.equal(sent[3], "<at>@mary jane</at>");
  } finally {
    await teardown(context);
  }
});

test("@all inserts and sends its canonical tag; email stays plain", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("@all");
    await context.renderOnce();
    assert.deepEqual(context.ui.suggestItems.map((item) => item.name), ["all"]);
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "@all ");
    assert.equal(context.ui.textarea.extmarks.getAll().length, 1);
    context.mockInput.pressEnter();
    await settle(context, "sent");
    const sent = context.api.calls.find((call) => call[0] === "send");
    assert.equal(sent[3], "<at>@all</at>");

    await context.mockInput.typeText("a@b");
    await context.renderOnce();
    assert.equal(context.ui.suggestBox.visible, false);
    assert.equal(context.ui.textarea.extmarks.getAll().length, 0);
    context.mockInput.pressEnter();
    await settle(context, "sent");
    const plain = context.api.calls.filter((call) => call[0] === "send").at(-1);
    assert.equal(plain[3], "a@b");
  } finally {
    await teardown(context);
  }
});

test("@ Esc closes only the popup and keeps the draft", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    await context.mockInput.typeText("@B");
    await context.renderOnce();
    assert.equal(context.ui.suggestBox.visible, true);
    context.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await context.renderOnce();
    assert.equal(context.app.state.draft, "@B");
    assert.equal(context.ui.suggestBox.visible, false);
    assert.equal(context.app.state.palette, null);
    assert.equal(context.app.state.focus, "composer");
  } finally {
    await teardown(context);
  }
});

test("mention highlights survive edits, clear on deletion and follow the theme", async () => {
  const context = await setup();
  try {
    await focusComposer(context);
    context.app.setDraft("hi @Bob");
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.ui.textarea.extmarks.getAll().length, 1);
    assert.deepEqual(
      context.ui.textarea.extmarks.getAll().map((mark) => [mark.start, mark.end]),
      [[3, 7]],
    );

    for (let index = 0; index < 4; index += 1) context.mockInput.pressBackspace();
    await context.renderOnce();
    assert.equal(context.app.state.draft, "hi ");
    assert.equal(context.ui.textarea.extmarks.getAll().length, 0);

    context.app.setDraft("<at>@Bob</at>");
    context.ui.sync();
    await context.renderOnce();
    assert.deepEqual(
      context.ui.textarea.extmarks.getAll().map((mark) => [mark.start, mark.end]),
      [[4, 8]],
    );

    context.app.setDraft("hi a@b");
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.ui.textarea.extmarks.getAll().length, 0);

    context.app.setDraft("@all");
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.ui.textarea.extmarks.getAll().length, 1);

    context.renderer.emit(CliRenderEvents.THEME_MODE, "light");
    await context.renderOnce();
    const mentionStyle = context.ui.textarea.syntaxStyle.getStyle("mention");
    assert.ok(mentionStyle.fg.equals(RGBA.fromHex(context.ui.theme.accent)));
    assert.equal(context.ui.textarea.extmarks.getAll().length, 1);
    assert.equal(context.app.state.draft, "@all");
    const accent = RGBA.fromHex(context.ui.theme.accent);
    const composerLine = context.captureSpans().lines.find((line) =>
      line.spans.some((span) => span.text === "@all" && span.fg.equals(accent) && span.attributes === 1),
    );
    assert.ok(composerLine, "composer should render the mention with accent color and bold");

    context.app.setDraft("");
    context.ui.sync();
    await context.renderOnce();
    assert.equal(context.ui.textarea.extmarks.getAll().length, 0);
  } finally {
    await teardown(context);
  }
});

test("canonical mention conversion preserves tags and ignores emails and longer names", () => {
  assert.equal(
    canonicalizeMentions("@Bob @Bobson a@Bob <at>@Bob</at> @all", [{ name: "Bob" }]),
    "<at>@Bob</at> @Bobson a@Bob <at>@Bob</at> <at>@all</at>",
  );
  assert.equal(mentionTrigger("@")?.query, "");
  assert.equal(mentionTrigger("hi,@B")?.query, "B");
  assert.equal(mentionTrigger("hi\n@B")?.query, "B");
  assert.equal(mentionTrigger("@mary j")?.query, "mary j");
  assert.equal(mentionTrigger("a@b"), null);
  assert.equal(mentionTrigger("word@"), null);
});