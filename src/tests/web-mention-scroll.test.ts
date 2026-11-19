/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-mention-scroll-token";

test.skipIf(!browserModule)("arrow keys scroll the mention picker to the active member", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-mention-scroll-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_MentionOwner");
    await page.locator("#inRoomName").fill("__Test_MentionScroll");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id };
    }, "/assets/chat/state.js");
    for (let index = 0; index < 20; index++) {
      const name = `scroll-member-${String(index).padStart(2, "0")}`;
      expect((await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: name, participantId: name, participantName: name })).status).toBe(201);
    }
    await page.evaluate(async (url: string) => { const { app } = await import(url); await app.loadManageableMembers(); }, "/assets/chat/state.js");
    await page.locator("#msgInput").fill("@scroll");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    expect(await page.locator(".mention-opt").count()).toBe(20);
    for (let index = 0; index < 10; index++) await page.keyboard.press("ArrowDown");
    const metrics = await page.evaluate(() => {
      const picker = document.querySelector<HTMLElement>("#mentionPicker")!;
      const active = picker.querySelector<HTMLElement>(".mention-opt.active")!;
      const pickerBox = picker.getBoundingClientRect(), activeBox = active.getBoundingClientRect();
      return { scrollTop: picker.scrollTop, activeTop: activeBox.top, activeBottom: activeBox.bottom, pickerTop: pickerBox.top, pickerBottom: pickerBox.bottom, label: active.textContent };
    });
    expect(metrics.label).toContain("scroll-member-10");
    expect(metrics.scrollTop).toBeGreaterThan(0);
    expect(metrics.activeTop).toBeGreaterThanOrEqual(metrics.pickerTop - 1);
    expect(metrics.activeBottom).toBeLessThanOrEqual(metrics.pickerBottom + 1);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function api(origin: string, route: string, method: string, body: unknown) {
  return fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start");
}