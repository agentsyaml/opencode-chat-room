/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-web-history-time-token";
const stateUrl = "/assets/chat/state.js";

test.skipIf(!browserModule)("history timestamps keep the date and live messages keep the viewport", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-history-time-scroll-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any, ownerContext: any, context: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    ownerContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const owner = await ownerContext.newPage();
    owner.setDefaultTimeout(20000);
    const errors: string[] = [];
    owner.on("pageerror", (error: Error) => errors.push(error.message));
    await owner.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await owner.goto(`${origin}/chat`);
    await owner.locator("#inName").fill("__Test_HistoryReader");
    await owner.locator("#inRoomName").fill("__Test_HistoryRoom");
    await owner.locator("#btnCreate").click();
    await owner.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await owner.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    expect(roomId).not.toBe("");

    await owner.evaluate(async ({ url, roomId }: any) => {
      const { app } = await import(url);
      for (let index = 0; index < 450; index++) {
        await app.api(`/rooms/${encodeURIComponent(roomId)}/messages`, {
          method: "POST", body: JSON.stringify({ sessionID: app.LS.sessionID, text: `history message ${index} ${"lorem ipsum ".repeat(4 + index % 4)}` }),
        });
      }
    }, { url: stateUrl, roomId });
    const identity = await owner.evaluate(async (url: string) => {
      const { LS } = await import(url);
      return { sessionID: LS.sessionID, name: LS.name };
    }, stateUrl);

    // A fresh context only holds the newest 100 messages; the rest load by scrolling.
    context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript((values: any) => {
      localStorage.setItem("chat.token", values.token);
      localStorage.setItem("chat.browserIdentity", JSON.stringify({ sessionID: values.sessionID, name: values.name }));
      sessionStorage.setItem("chat.sessionID", values.sessionID);
      sessionStorage.setItem("chat.name", values.name);
      sessionStorage.setItem("chat.roomId", values.roomId);
    }, { token, roomId, ...identity });
    await page.goto(`${origin}/chat`);
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_HistoryRoom");
    const initialCount = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.length, stateUrl);
    expect(initialCount).toBeLessThanOrEqual(100);

    // Today stays HH:MM; an older message renders the localized short date and time.
    const stamps = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const target = app.state.room.messages.at(-2);
      const yesterday = Date.now() - 26 * 60 * 60 * 1000;
      target.createdAt = yesterday;
      app.rerenderMessages();
      const row = document.querySelector(`[data-msg-id="${CSS.escape(target.id)}"]`);
      const today = app.state.room.messages.at(-1);
      const todayRow = document.querySelector(`[data-msg-id="${CSS.escape(today.id)}"]`);
      return {
        oldText: row?.querySelector(".msg-time")?.textContent ?? "",
        expectedOld: app.fmtTime(yesterday),
        todayTime: todayRow?.querySelector(".msg-time")?.textContent ?? "",
        expectedToday: app.timeHM(today.createdAt),
      };
    }, stateUrl);
    expect(stamps.oldText).toBe(stamps.expectedOld);
    expect(stamps.oldText).not.toMatch(/^\d{1,2}:\d{2}/);
    expect(stamps.todayTime).toBe(stamps.expectedToday);

    // Scroll to the top until every history page has been prepended: the DOM now
    // holds more than the 300-row trim threshold.
    const box = await page.locator("#thread").boundingBox();
    if (!box) throw new Error("Thread is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < 30; attempt++) {
      const loaded = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.length, stateUrl);
      if (loaded >= 450) break;
      await page.mouse.wheel(0, -4000);
      await page.waitForTimeout(250);
    }
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.length >= 450, stateUrl);
    const domRows = await page.evaluate(() => document.querySelectorAll("#msgList [data-msg-id]").length);
    expect(domRows).toBeGreaterThan(400);

    // Move down into the middle of the loaded history like a reader browsing.
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(400);
    const before = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const thread = document.querySelector("#thread")!;
      const edge = thread.getBoundingClientRect();
      const top = Array.from(document.querySelectorAll("#msgList [data-msg-id]"))
        .find((row) => row.getBoundingClientRect().bottom > edge.top);
      return {
        scrollTop: thread.scrollTop,
        topId: (top as HTMLElement | undefined)?.dataset.msgId ?? "",
        gap: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
        followBottom: app.state.followBottom,
      };
    }, stateUrl);
    expect(before.gap).toBeGreaterThan(200);
    expect(before.topId).not.toBe("");
    expect(before.followBottom).toBe(false);

    const liveId = await page.evaluate(async ({ url, roomId }: any) => {
      const { app } = await import(url);
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST", body: JSON.stringify({ sessionID: app.LS.sessionID, text: "live message while reading history" }),
      });
      return room.messages.at(-1).id;
    }, { url: stateUrl, roomId });
    await page.waitForFunction((id: string) => Boolean(document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)), liveId);
    await page.waitForTimeout(250);
    const after = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const thread = document.querySelector("#thread")!;
      const edge = thread.getBoundingClientRect();
      const top = Array.from(document.querySelectorAll("#msgList [data-msg-id]"))
        .find((row) => row.getBoundingClientRect().bottom > edge.top);
      return {
        scrollTop: thread.scrollTop,
        topId: (top as HTMLElement | undefined)?.dataset.msgId ?? "",
        gap: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
        followBottom: app.state.followBottom,
      };
    }, stateUrl);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(3);
    expect(after.topId).toBe(before.topId);

    // Following the latest still auto-scrolls when a live message arrives.
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.jumpToBottom();
    }, stateUrl);
    await page.waitForTimeout(200);
    const liveId2 = await page.evaluate(async ({ url, roomId }: any) => {
      const { app } = await import(url);
      const room = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST", body: JSON.stringify({ sessionID: app.LS.sessionID, text: "live message while following" }),
      });
      return room.messages.at(-1).id;
    }, { url: stateUrl, roomId });
    await page.waitForFunction((id: string) => Boolean(document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)), liveId2);
    await page.waitForTimeout(250);
    const followed = await page.evaluate(() => {
      const thread = document.querySelector("#thread")!;
      return thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    });
    expect(followed).toBeLessThan(3);
    expect(errors).toEqual([]);
  } finally {
    await context?.close(); await ownerContext?.close(); await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 240000);

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}