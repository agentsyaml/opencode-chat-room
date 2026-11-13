/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-question-unread-test-token";

test.skipIf(!browserModule)("reading clears the unread badge while the question stays pending in the Questions panel", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-question-unread-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(10000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_QuestionOwner");
    await page.locator("#inRoomName").fill("__Test_QuestionUnread");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "__Test_QuestionPeer", participantId: "__Test_QuestionPeer", participantName: "__Test_QuestionPeer" });
    const sent = await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_open_question", isQuestion: true });
    const questionId = sent.messages.at(-1).id;
    await page.locator("#msgList").getByText("__Test_open_question").waitFor();

    // A read acknowledgement may already be in flight from the arrival render;
    // retry until the watermark lands instead of asserting one instant.
    const read = async () => {
      let result = { unread: -1, ids: [] as string[] };
      for (let attempt = 0; attempt < 50; attempt++) {
        result = await page.evaluate(async (url: string) => {
          const { app } = await import(url);
          document.querySelector<HTMLElement>("#thread")!.scrollTop = 1e9;
          await app.markActiveRoomRead(true);
          const entry = app.state.rooms.get(app.state.room.id);
          return { unread: app.state.unread, ids: [...entry.unreadIds.keys()] };
        }, "/assets/chat/state.js");
        if (result.unread === 0 && result.ids.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    };

    // Reading to the bottom clears the badge even though the question is unanswered.
    const openQuestion = await read();
    expect(openQuestion.unread).toBe(0);
    expect(openQuestion.ids).toHaveLength(0);
    // The pending question is still surfaced by the Questions panel.
    await page.waitForFunction(async ({ url, qid }: any) => (await import(url)).app.unansweredQuestionIds()?.has(qid), { url: "/assets/chat/state.js", qid: questionId }, { timeout: 15000 });
    await page.locator("#btnQuestions").click();
    await page.locator(`#questionList [data-question-id="${questionId}"]`).waitFor({ timeout: 15000 });
    await page.locator("#btnQuestions").click();

    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_plain_reply" });
    await page.locator("#msgList").getByText("__Test_plain_reply").waitFor();
    expect((await read()).unread).toBe(0);

    await api(origin, `/rooms/${room.id}/questions/${questionId}/answers`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_answer" });
    // Answering keeps the badge clear and empties the Questions panel.
    await page.waitForFunction(async ({ url, qid }: any) => !(await import(url)).app.unansweredQuestionIds()?.has(qid), { url: "/assets/chat/state.js", qid: questionId }, { timeout: 15000 });
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(async (url: string) => {
      const { app } = await import(url);
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 1e9;
      await app.markActiveRoomRead(true);
      return app.state.unread === 0;
    }, "/assets/chat/state.js");
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!browserModule)("reading clears own messages and entries older than the watermark", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-unread-stuck-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(10000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_StuckOwner");
    await page.locator("#inRoomName").fill("__Test_UnreadStuck");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const result = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const room = app.state.room, entry = app.state.rooms.get(room.id), ts = Date.now();
      const own = { id: "own-unread", roomId: room.id, senderId: app.state.myName, senderSessionID: app.LS.sessionID, text: "mine", createdAt: ts };
      const old = { id: "old-unread", roomId: room.id, senderId: "peer", text: "older", createdAt: ts - 5000 };
      room.messages.push(own, old);
      entry.unreadIds.set(own.id, own); entry.unreadIds.set(old.id, old);
      entry.readTs = ts + 1; app.state.lastReadTs.set(room.id, entry.readTs);
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 1e9;
      await app.markActiveRoomRead(true);
      return { unread: app.state.unread, ids: [...entry.unreadIds.keys()] };
    }, "/assets/chat/state.js");
    expect(result.ids).toEqual([]);
    expect(result.unread).toBe(0);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!browserModule)("an answered question leaves the unread set while another room is open", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-question-away-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const sid = "88888888-8888-4888-8888-888888888888", peer = "__Test_AwayPeer";
    const roomA = await api(origin, "/rooms", "POST", { name: "__Test_AwayA", ownerId: "Watcher", sessionID: sid });
    const roomB = await api(origin, "/rooms", "POST", { name: "__Test_AwayB", ownerId: "Watcher", sessionID: sid });
    await api(origin, `/rooms/${roomA.id}/join`, "POST", { sessionID: peer, participantId: peer, participantName: peer });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript(({ sid, a, b, token }: any) => {
      localStorage.setItem("chat.token", token);
      sessionStorage.setItem("chat.sessionID", sid);
      sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([a, b]));
      sessionStorage.setItem("chat.roomId", a);
      sessionStorage.setItem("chat.name", "Watcher");
    }, { sid, a: roomA.id, b: roomB.id, token });
    await page.goto(`${origin}/chat`);
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(async ({ url, a, b }: any) => {
      const { app } = await import(url);
      return app.state.rooms.has(a) && app.state.rooms.has(b);
    }, { url: "/assets/chat/state.js", a: roomA.id, b: roomB.id });

    const sent = await api(origin, `/rooms/${roomA.id}/messages`, "POST", { sessionID: peer, text: "__Test_away_question", isQuestion: true });
    const question = sent.messages.at(-1);
    await page.locator("#msgList").getByText("__Test_away_question").waitFor();
    await page.waitForFunction(async ({ url, id, qid }: any) => {
      const { app } = await import(url);
      return app.state.rooms.get(id)!.unreadIds.has(qid);
    }, { url: "/assets/chat/state.js", id: roomA.id, qid: question.id });

    await page.evaluate(async ({ url, id }: any) => {
      const { app } = await import(url);
      app.activateRoom(id);
    }, { url: "/assets/chat/state.js", id: roomB.id });
    await api(origin, `/rooms/${roomA.id}/questions/${question.id}/answers`, "POST", { sessionID: peer, text: "__Test_away_answer" });
    await page.waitForFunction(async ({ url, id, qid }: any) => {
      const { app } = await import(url), entry = app.state.rooms.get(id);
      return Boolean(entry) && !entry.unreadIds.has(qid);
    }, { url: "/assets/chat/state.js", id: roomA.id, qid: question.id }, { timeout: 20000 });
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("a room with an unanswered question shows a question-mark badge in the sidebar", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-question-badge-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(20000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_BadgeOwner");
    await page.locator("#inRoomName").fill("__Test_BadgeRoomA");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomA = await page.evaluate(async (url: string) => { const { app } = await import(url); return { id: app.state.room.id, sessionID: app.LS.sessionID }; }, "/assets/chat/state.js");
    await api(origin, `/rooms/${roomA.id}/join`, "POST", { sessionID: "__Test_BadgePeer", participantId: "__Test_BadgePeer", participantName: "__Test_BadgePeer" });
    // Switch to a second room so room A is watched from the sidebar.
    const roomB = await api(origin, "/rooms", "POST", { name: "__Test_BadgeRoomB", ownerId: "__Test_BadgeOwner", sessionID: roomA.sessionID });
    await page.evaluate(async ({ url, id }: any) => { const { app } = await import(url); await app.joinRoom(id, "__Test_BadgeOwner"); }, { url: "/assets/chat/state.js", id: roomB.id });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_BadgeRoomB");
    // The pending question shows a "?" badge in the same slot as unread, not a count.
    const sent = await api(origin, `/rooms/${roomA.id}/messages`, "POST", { sessionID: "__Test_BadgePeer", text: "__Test_badge_question", isQuestion: true });
    const questionId = sent.messages.at(-1).id;
    await page.waitForFunction((id: string) => document.querySelector(`#roomListChat [data-room-id="${id}"] .r-badge-question`)?.textContent === "?", roomA.id, { timeout: 20000 });
    // Answering clears the question-mark badge.
    await api(origin, `/rooms/${roomA.id}/questions/${questionId}/answers`, "POST", { sessionID: "__Test_BadgePeer", text: "__Test_badge_answer" });
    await page.waitForFunction((id: string) => !document.querySelector(`#roomListChat [data-room-id="${id}"] .r-badge-question`), roomA.id, { timeout: 20000 });
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}
