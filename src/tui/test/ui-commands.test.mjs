import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../app.mjs";
import { createTui } from "../ui.mjs";

const TOKEN = "tok-SECRET-never-render";

function makeApi() {
  const messages = [{
    id: "m1",
    senderId: "bob",
    text: "hello **markdown** and <at>@alex</at>",
    createdAt: 1000,
  }];
  let announcementList = [{ name: "rules", content: "Be nice.\n\n- one\n- two", updatedAt: 1000 }];
  let questionList = [{ id: "q1", senderId: "bob", text: "ship today?", createdAt: 1000, isQuestion: true }];
  const fileList = [{ id: "f1", name: "notes.txt", size: 2048, uploaderName: "bob", createdAt: 1000 }];
  const reminders = [{
    id: "rem1",
    text: "standup",
    schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    paused: false,
    nextRunAt: "2026-11-23T09:00:00.000Z",
  }];
  const api = {
    calls: [],
    get announcementList() { return announcementList; },
    set announcementList(value) { announcementList = value; },
    get questionList() { return questionList; },
    set questionList(value) { questionList = value; },
    get fileList() { return fileList; },
    async listRooms() {
      return [{ id: "r1", name: "general", participants: [{ id: "alex", name: "alex" }], joined: true }];
    },
    async getRoom(id) {
      return { id, name: "general", participants: [{ id: "alex", name: "alex" }], messages };
    },
    async join() {
      return { pending: false };
    },
    async send(id, sessionID, text) {
      api.calls.push(["send", id, sessionID, text]);
      return { id: "sent", senderId: "alex", text, createdAt: 5000 };
    },
    async poll() {
      return { member: true, items: [] };
    },
    async markRead() {},
    async members() {
      return [
        { sessionID: "s1", name: "alex", type: "human", activity: { state: "idle" } },
        { sessionID: "s2", name: "bob", type: "agent", activity: { state: "working" } },
      ];
    },
    async announcements() {
      return announcementList;
    },
    async saveAnnouncement(roomID, name, content, sessionID) {
      api.calls.push(["saveAnnouncement", roomID, name, content, sessionID]);
      announcementList = announcementList.filter((item) => item.name !== name);
      announcementList.push({ name, content, updatedAt: 2000 });
      return { name, content };
    },
    async deleteAnnouncement(roomID, name, sessionID) {
      api.calls.push(["deleteAnnouncement", roomID, name, sessionID]);
      announcementList = announcementList.filter((item) => item.name !== name);
    },
    async questions() {
      return questionList;
    },
    async answerQuestion(roomID, questionID, sessionID, text) {
      api.calls.push(["answerQuestion", roomID, questionID, sessionID, text]);
      questionList = [];
      return { questionID, answer: { text } };
    },
    async resources() {
      return { resources: fileList, total: fileList.length };
    },
    async resourceContent(roomID, resourceID) {
      return { bytes: new TextEncoder().encode(`body of ${resourceID}`), contentType: "text/plain" };
    },
    async uploadResource(roomID, sessionID, filename, bytes) {
      api.calls.push(["uploadResource", roomID, sessionID, filename, bytes.length]);
      return { id: "f2", name: filename, size: bytes.length };
    },
    async reminders() {
      return reminders;
    },
  };
  return api;
}

async function setup({ api = makeApi(), downloadDir } = {}) {
  const directory = downloadDir ?? await mkdtemp(path.join(tmpdir(), "tui-commands-"));
  const context = await createTestRenderer({ width: 96, height: 28 });
  const app = createApp({
    api,
    sessionID: "s1",
    participant: "alex",
    host: "server",
    autoPoll: false,
    downloadDir: directory,
    settings: {
      server: "https://chat.example",
      participant: "alex",
      sessionFile: "/tmp/session.json",
      configFile: "/tmp/chatroom.json",
      requestTimeoutMs: 10000,
      pollTimeoutMs: 20000,
      token: TOKEN,
    },
  });
  await app.init();
  const ui = createTui(context.renderer, app);
  await app.openRoom(0);
  await context.renderOnce();
  return { ...context, app, ui, api, directory, ownsDirectory: !downloadDir };
}

async function teardown(context) {
  context.ui.destroy();
  context.renderer.destroy();
  if (context.ownsDirectory) await rm(context.directory, { recursive: true, force: true });
}

async function settle(context, needle, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await context.renderOnce();
    if (!needle || context.captureCharFrame().includes(needle)) break;
  }
  await context.flush();
}

test("slash opens command mode and /quit quits", async () => {
  const context = await setup();
  try {
    context.mockInput.pressTab();
    await context.renderOnce();
    await context.mockInput.typeText("/");
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "commands");
    assert.equal(context.app.state.palette?.query, "/");
    const frame = context.captureCharFrame();
    assert.match(frame, /Palette/);
    assert.match(frame, /Members/);
    assert.match(frame, /Announcements/);
    assert.match(frame, /Questions/);
    assert.match(frame, /Files/);
    assert.match(frame, /Reminders/);
    assert.match(frame, /Settings/);
    assert.match(frame, /Quit/);

    await context.mockInput.typeText("quit");
    await settle(context, "/quit");
    assert.deepEqual(context.app.paletteCommands().map((command) => command.id), ["quit"]);
    context.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(context.app.state.quit, true);
  } finally {
    await teardown(context);
  }
});

test("slash filters the new commands without turning into message search", async () => {
  const context = await setup();
  try {
    const commands = [
      ["members", "members"], ["join-requests", "join-requests"],
      ["announcements", "announcements"], ["questions", "questions"],
      ["files", "files"], ["reminders", "reminders"], ["settings", "settings"],
      ["room-settings", "room-settings"], ["delete-room", "delete-room"],
      ["recall", "recall-message"],
      ["reveal", "reveal-message"], ["reply", "reply-message"],
      ["ask", "ask-question"], ["quit", "quit"],
    ];
    for (const [query, id] of commands) {
      context.app.openPalette({ slash: true });
      context.app.setPaletteQuery(`/${query}`);
      assert.equal(context.app.state.palette.mode, "commands", query);
      const ids = context.app.paletteCommands().map((item) => item.id);
      assert.ok(ids.includes(id), `${query}: ${ids.join(",")}`);
      if (query !== "settings") assert.deepEqual(ids, [id], query);
    }
    context.app.setPaletteQuery("hello");
    assert.equal(context.app.state.palette.mode, "search");
  } finally {
    await teardown(context);
  }
});

test("running /members from the slash palette opens the member list", async () => {
  const context = await setup();
  try {
    context.mockInput.pressTab();
    await context.mockInput.typeText("/members");
    context.mockInput.pressEnter();
    await settle(context, "bob");
    assert.equal(context.app.state.palette?.kind, "members");
    assert.match(context.captureCharFrame(), /Members/);
    assert.match(context.captureCharFrame(), /● alex \(you\) · member · human · idle/);
  } finally {
    await teardown(context);
  }
});

test("members list marks you and shows human and agent rows", async () => {
  const context = await setup();
  try {
    await context.app.openMembers();
    await settle(context, "bob");
    const frame = context.captureCharFrame();
    assert.match(frame, /Members/);
    assert.match(frame, /● alex \(you\) · member · human · idle/);
    assert.match(frame, /○ bob · member · agent · working/);
    assert.match(frame, /#general/);
  } finally {
    await teardown(context);
  }
});

test("announcements read, create and delete through the overlay", async () => {
  const context = await setup();
  try {
    await context.app.openAnnouncements();
    await settle(context, "rules");
    assert.match(context.captureCharFrame(), /rules · updated/);

    context.app.state.palette.selected = 0;
    context.mockInput.pressEnter();
    await settle(context, "Be nice.");
    let frame = context.captureCharFrame();
    assert.match(frame, /Be nice\./);
    assert.match(frame, /- one/);
    assert.match(frame, /d delete · Esc back/);
    assert.doesNotMatch(frame, /<at>|\*\*/);

    context.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(context.app.state.palette?.mode, "info");
    context.mockInput.pressKeys(["n"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "announcement-name");
    assert.match(context.captureCharFrame(), /existing name replaces/);
    await context.mockInput.typeText("news");
    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "announcement-content");
    await context.mockInput.typeText("fresh announcement");
    context.mockInput.pressEnter();
    await settle(context, "fresh announcement");
    const save = context.api.calls.find((call) => call[0] === "saveAnnouncement");
    assert.deepEqual(save, ["saveAnnouncement", "r1", "news", "fresh announcement", "s1"]);
    frame = context.captureCharFrame();
    assert.match(frame, /news · updated/);
    assert.match(frame, /rules · updated/);

    const index = context.app.state.palette.items.findIndex((item) => item.value === "rules");
    context.app.state.palette.selected = index;
    context.mockInput.pressKeys(["d"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.mode, "confirm");
    assert.match(context.captureCharFrame(), /Delete announcement "rules"/);
    context.mockInput.pressEnter();
    await settle(context, "fresh announcement");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "deleteAnnouncement"),
      ["deleteAnnouncement", "r1", "rules", "s1"],
    );
    assert.doesNotMatch(context.captureCharFrame(), /rules · updated/);
  } finally {
    await teardown(context);
  }
});

test("questions list opens an answer prompt and posts it", async () => {
  const context = await setup();
  try {
    context.app.state.messages.push({
      id: "q0",
      senderId: "carol",
      text: "old question",
      isQuestion: true,
      answeredByMessageID: "a1",
      createdAt: 900,
    });
    await context.app.openQuestions();
    await settle(context, "ship today?");
    const list = context.captureCharFrame();
    assert.match(list, /Questions/);
    assert.match(list, /\? bob: ship today\?/);
    assert.match(list, /✓ carol: old question \(answered\)/);

    context.mockInput.pressEnter();
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "question-answer");
    await context.mockInput.typeText("yes, after tests");
    context.mockInput.pressEnter();
    await settle(context, "answer posted");
    assert.deepEqual(
      context.api.calls.find((call) => call[0] === "answerQuestion"),
      ["answerQuestion", "r1", "q1", "s1", "yes, after tests"],
    );
  } finally {
    await teardown(context);
  }
});

test("files list downloads to a local path and uploads an absolute path", async () => {
  const context = await setup();
  try {
    await context.app.openFiles();
    await settle(context, "notes.txt");
    const frame = context.captureCharFrame();
    assert.match(frame, /notes.txt · 2\.0 KB · bob ·/);
    assert.match(frame, /Enter download · u upload/);

    context.mockInput.pressEnter();
    await settle(context, "saved ");
    const saved = context.app.state.status;
    assert.match(saved, /saved .*notes\.txt/);
    assert.equal(await readFile(path.join(context.directory, "notes.txt"), "utf8"), "body of f1");

    const upload = path.join(context.directory, "upload.txt");
    await writeFile(upload, "payload");
    await context.app.openFiles();
    await settle(context, "notes.txt");
    context.mockInput.pressKeys(["u"]);
    await context.renderOnce();
    assert.equal(context.app.state.palette?.prompt?.action, "file-upload");
    await context.mockInput.typeText(upload);
    context.mockInput.pressEnter();
    await settle(context, "uploaded upload.txt");
    const call = context.api.calls.find((item) => item[0] === "uploadResource");
    assert.equal(call[1], "r1");
    assert.equal(call[2], "s1");
    assert.equal(call[3], "upload.txt");
    assert.equal(call[4], 7);
  } finally {
    await teardown(context);
  }
});

test("reminders list shows schedule, paused state and next run", async () => {
  const context = await setup();
  try {
    await context.app.openReminders();
    await settle(context, "standup");
    const frame = context.captureCharFrame();
    assert.match(frame, /Reminders/);
    assert.match(frame, /● standup · cron 0 9 \* \* \* \(UTC\) · next/);
    assert.doesNotMatch(frame, /paused/);
  } finally {
    await teardown(context);
  }
});

test("settings redact the token and every command frame stays clean", async () => {
  const context = await setup();
  try {
    const frames = [];
    await context.app.openMembers();
    await settle(context, "bob");
    frames.push(context.captureCharFrame());
    await context.app.openAnnouncements();
    await settle(context, "rules");
    frames.push(context.captureCharFrame());
    await context.app.openQuestions();
    await settle(context, "ship today?");
    frames.push(context.captureCharFrame());
    await context.app.openFiles();
    await settle(context, "notes.txt");
    frames.push(context.captureCharFrame());
    await context.app.openReminders();
    await settle(context, "standup");
    frames.push(context.captureCharFrame());
    await context.app.openSettings();
    await settle(context, "Token: set (redacted)");
    frames.push(context.captureCharFrame());

    const settings = frames.at(-1);
    assert.match(settings, /Server: https:\/\/chat\.example/);
    assert.match(settings, /Participant: alex/);
    assert.match(settings, /Session file: \/tmp\/session\.json/);
    assert.match(settings, /Config file: \/tmp\/chatroom\.json/);
    assert.match(settings, /Theme: dark/);
    assert.match(settings, /20s hold/);
    assert.match(settings, /Request timeout: 10s/);
    assert.match(settings, /Token: set \(redacted\)/);
    for (const frame of frames) assert.equal(frame.includes(TOKEN), false, "token leaked into a frame");
  } finally {
    await teardown(context);
  }
});

test("messages render Markdown and mentions without raw tags", async () => {
  const context = await setup();
  try {
    await settle(context, "hello markdown");
    const frame = context.captureCharFrame();
    assert.match(frame, /hello markdown and/);
    assert.doesNotMatch(frame, /\*\*|<at>|<\/at>/);
  } finally {
    await teardown(context);
  }
});