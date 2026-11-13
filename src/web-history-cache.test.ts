/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-history-cache-test-token";

test.skipIf(!browserModule)("windowed history paginates upward, caches locally, and copy keeps the room ID", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-history-cache-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const seedContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const seed = await seedContext.newPage();
    await seed.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await seed.goto(`${origin}/chat`);
    await seed.locator("#inName").fill("__Test_CacheOwner");
    await seed.locator("#inRoomName").fill("__Test_HistoryCache");
    await seed.locator("#btnCreate").click();
    await seed.locator("#chatView").waitFor({ state: "visible" });
    const room = await seed.evaluate(async (url: string) => { const { app } = await import(url); return { id: app.state.room.id }; }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "__Test_CachePeer", participantId: "__Test_CachePeer", participantName: "__Test_CachePeer" });
    for (let index = 0; index < 250; index++) await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_CachePeer", text: `__Test_page ${index}\n${"Filler line for height.\n".repeat(3)}` });
    // The server hands back only the newest window plus a pagination cursor.
    const opened = await api(origin, `/rooms/${room.id}`);
    expect(opened.messages).toHaveLength(100);
    expect(opened.hasMore).toBe(true);
    expect(typeof opened.nextBeforeSeq).toBe("number");
    // A fresh profile (empty IndexedDB) joins and renders just that window.
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_CacheReader");
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => { const { app } = await import(url); await app.joinRoom(id, "__Test_CacheReader"); }, { url: "/assets/chat/state.js", id: room.id });
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll("#msgList .msg").length >= 50);
    const initial = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.length, "/assets/chat/state.js");
    expect(initial).toBeLessThanOrEqual(100);
    // Copy must not overwrite the ID span with "undefined".
    await page.locator("#btnCopyId").click();
    await page.waitForTimeout(1400);
    expect(await page.locator("#roomIdShort").textContent()).toBe(room.id.slice(0, 8));
    // Scrolling to the top pages older history in without teleporting the viewport.
    await page.evaluate(() => { const t = document.querySelector<HTMLElement>("#thread")!; t.scrollTop = 0; });
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.length > 100, "/assets/chat/state.js");
    const after = await page.evaluate(() => { const t = document.querySelector<HTMLElement>("#thread")!; return { scrollTop: t.scrollTop, rows: document.querySelectorAll("#msgList [data-msg-id]").length }; });
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.rows).toBeGreaterThan(100);
    // Let the debounced snapshot land, then prove a reopen renders from cache
    // before the (deliberately delayed) room list round trip completes.
    await page.waitForTimeout(1200);
    await page.route("**/rooms*", async (route: any) => { await new Promise((resolve) => setTimeout(resolve, 1500)); return route.continue(); });
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll("#msgList .msg").length > 0, undefined, { timeout: 900 });
    const cached = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.length, "/assets/chat/state.js");
    expect(cached).toBeGreaterThan(100);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
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
