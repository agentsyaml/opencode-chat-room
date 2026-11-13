/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-read-watermark-test-token";

test.skipIf(!browserModule)("a new tab starts from the server read watermark", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-read-watermark-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    const first = await context.newPage();
    first.setDefaultTimeout(15000);
    await first.goto(`${origin}/chat`);
    await first.locator("#inName").fill("__Test_WatermarkOwner");
    await first.locator("#inRoomName").fill("__Test_Watermark");
    await first.locator("#btnCreate").click();
    await first.locator("#chatView").waitFor({ state: "visible" });
    const room = await first.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "__Test_WatermarkPeer", participantId: "__Test_WatermarkPeer", participantName: "__Test_WatermarkPeer" });
    for (let index = 0; index < 4; index++) await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_WatermarkPeer", text: `__Test_read ${index}\n${"Filler line for height.\n".repeat(12)}` });
    await first.reload();
    await first.locator("#msgList .msg").nth(3).waitFor();
    await first.evaluate(async (url: string) => (await import(url)).app.jumpToBottom(), "/assets/chat/state.js");
    await first.waitForFunction(async ({ url, id, peer }: { url: string; id: string; peer: string }) => {
      const { app } = await import(url), entry = app.state.rooms.get(id);
      const read = entry?.room.messages.filter((message: any) => message.senderId === peer).at(-1);
      return Boolean(read && entry.readTs >= read.createdAt);
    }, { url: "/assets/chat/state.js", id: room.id, peer: "__Test_WatermarkPeer" });
    // This tab is the only holder of the local watermark; the next tab has none.
    await first.close();
    for (let index = 0; index < 3; index++) await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_WatermarkPeer", text: `__Test_unread ${index}\n${"Filler line for height.\n".repeat(12)}` });
    const second = await context.newPage();
    second.setDefaultTimeout(15000);
    await second.goto(`${origin}/chat`);
    await second.locator("#chatView").waitFor({ state: "visible" });
    await second.waitForFunction(async (url: string) => (await import(url)).app.state.unread >= 3, "/assets/chat/state.js");
    await second.waitForTimeout(500);
    const state = await second.evaluate(async (url: string) => {
      const { app } = await import(url), entry = app.state.rooms.get(app.state.room.id);
      return { unread: app.state.unread, readTs: entry.readTs };
    }, "/assets/chat/state.js");
    expect(state.unread).toBe(3);
    expect(state.readTs).toBeGreaterThan(0);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!browserModule)("a render-failed message blocks the watermark even when later messages render", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-read-failed-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_FailedOwner");
    await page.locator("#inRoomName").fill("__Test_FailedRender");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "__Test_FailedPeer", participantId: "__Test_FailedPeer", participantName: "__Test_FailedPeer" });
    for (let index = 0; index < 3; index++) await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_FailedPeer", text: `__Test_failed ${index}\n${"Filler line for height.\n".repeat(12)}` });
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    // Fail the middle message's render; the third still renders, so the watermark must stop at the middle.
    const middle = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      let peer: any[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        peer = (app.state.room?.messages ?? []).filter((message: any) => message.senderId === "__Test_FailedPeer");
        if (peer.length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (peer.length < 3) throw new Error(`expected 3 peer messages, found ${peer.length}`);
      const target = peer[1];
      const original = app.renderMessage;
      app.renderMessage = (message: any, live: boolean) => {
        if (message.id === target.id) throw new Error("test render failure");
        return original(message, live);
      };
      app.rerenderMessages();
      return { createdAt: target.createdAt, failed: app.failedRenderIds.has(target.id) };
    }, "/assets/chat/state.js");
    expect(middle.failed).toBe(true);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.state.rooms.get(app.state.room.id).readTs = 0;
      app.jumpToBottom();
    }, "/assets/chat/state.js");
    await page.waitForFunction(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.state.rooms.get(id).readTs > 0, { url: "/assets/chat/state.js", id: room.id });
    const readTs = await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.state.rooms.get(id).readTs, { url: "/assets/chat/state.js", id: room.id });
    expect(readTs).toBeLessThan(middle.createdAt);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
