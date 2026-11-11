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

test.skipIf(!browserModule)("an unanswered question stays unread until it is answered", async () => {
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
    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_open_question", isQuestion: true });
    await page.locator("#msgList").getByText("__Test_open_question").waitFor();

    const read = () => page.evaluate(async (url: string) => {
      const { app } = await import(url);
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 1e9;
      await app.markActiveRoomRead(true);
      const entry = app.state.rooms.get(app.state.room.id);
      return { unread: app.state.unread, ids: [...entry.unreadIds.keys()] };
    }, "/assets/chat/state.js");

    const openQuestion = await read();
    expect(openQuestion.unread).toBe(1);
    expect(openQuestion.ids).toHaveLength(1);

    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_plain_reply" });
    await page.locator("#msgList").getByText("__Test_plain_reply").waitFor();
    expect((await read()).unread).toBe(1);

    const questionId = (await api(origin, `/rooms/${room.id}/questions`, "GET", undefined) as any).questions[0].id;
    await api(origin, `/rooms/${room.id}/questions/${questionId}/answers`, "POST", { sessionID: "__Test_QuestionPeer", text: "__Test_answer" });
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
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 1e9;
      await app.markActiveRoomRead(true);
    }, "/assets/chat/state.js");
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
