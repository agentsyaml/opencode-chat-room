import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-room-keys-local-token";

test.skipIf(!browserModule)("Alt+Arrow steps through joined rooms in rail order", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-room-keys-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((context: any) => context.newPage());
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Key tester");
    await page.locator("#inRoomName").fill("__Test_KeysA");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await roomName(page, "__Test_KeysA");

    // A single joined room has nowhere to switch to.
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Alt+ArrowUp");
    await page.waitForTimeout(300);
    await roomName(page, "__Test_KeysA");

    await page.locator("#btnNewRoom").click();
    await page.locator("#inRoomNameChat").fill("__Test_KeysB");
    await page.locator("#btnCreateChatRoom").click();
    await roomName(page, "__Test_KeysB");

    const joined = await page.$$eval("#roomListChat .room-row.joined", (rows: any[]) => rows.map((row) => ({
      id: row.dataset.roomId, name: row.querySelector(".r-name").textContent })));
    expect(joined.length).toBe(2);
    const startId = await selectedRoomID(page);
    const start = joined.findIndex((room: any) => room.id === startId);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = joined[(start + 1) % joined.length];

    await page.keyboard.press("Alt+ArrowDown");
    await roomName(page, next.name);
    expect(await selectedRoomID(page)).toBe(next.id);

    await page.keyboard.press("Alt+ArrowUp");
    await roomName(page, joined[start].name);
    expect(await selectedRoomID(page)).toBe(joined[start].id);

    // A modal owns the arrow keys while it is open.
    await page.evaluate(() => (document.querySelector("#tokenBox") as HTMLDialogElement).showModal());
    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForTimeout(300);
    expect(await selectedRoomID(page)).toBe(joined[start].id);
    await page.evaluate(() => (document.querySelector("#tokenBox") as HTMLDialogElement).close());

    // Combined modifiers are not the shortcut.
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await page.keyboard.press("Control+Alt+ArrowDown");
    await page.waitForTimeout(300);
    expect(await selectedRoomID(page)).toBe(joined[start].id);

    // Switching to a room with thousands of cached messages renders only the
    // newest window, and scrolling up consumes the cache before any request.
    let listRequests = 0, historyRequests = 0;
    page.on("request", (request: any) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/rooms") listRequests++;
      if (pathname.endsWith("/history")) historyRequests++;
    });
    const cache = await page.evaluate(async ({ url, roomId }: { url: string; roomId: string }) => {
      const { app } = await import(url);
      const entry = app.state.rooms.get(roomId);
      const base = Date.now();
      entry.room.messages = Array.from({ length: 5000 }, (_, index) => ({
        id: `seed-${index}`,
        seq: index + 1,
        senderId: "Seed",
        senderSessionID: "seed-session",
        text: `cached message ${index}`,
        createdAt: base - (5000 - index) * 1000,
      }));
      entry.historyComplete = false;
      entry.historyBeforeSeq = 1;
      const started = performance.now();
      app.activateRoom(roomId);
      const switchMs = performance.now() - started;
      const rows = document.querySelectorAll("#msgList [data-msg-id]").length;
      const beforeScroll = rows;
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 0;
      await app.loadOlderHistory();
      return {
        switchMs,
        rows,
        afterScroll: document.querySelectorAll("#msgList [data-msg-id]").length,
        beforeScroll,
      };
    }, { url: "/assets/chat/state.js", roomId: next.id });
    await page.waitForTimeout(120);
    expect(cache.switchMs).toBeLessThan(250);
    expect(cache.rows).toBeGreaterThanOrEqual(300);
    expect(cache.rows).toBeLessThan(400);
    expect(cache.afterScroll).toBeGreaterThan(cache.beforeScroll);
    expect(listRequests).toBe(0);
    expect(historyRequests).toBe(0);
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function roomName(page: any, name: string) {
  await page.waitForFunction((value: string) => document.querySelector("#roomName")?.textContent === value, name);
}
async function selectedRoomID(page: any) {
  return page.$eval("#roomListChat .room-row.selected", (row: any) => row.dataset.roomId);
}
async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local isolated chat server did not start");
}
