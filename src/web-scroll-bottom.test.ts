/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-scroll-bottom-test-token";

test.skipIf(!browserModule)("physical scroll reaches a stable zero-gap thread bottom", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-scroll-bottom-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const measurements: unknown[] = [];
    if (process.env.CHAT_UI_SCREENSHOT_DIR) await mkdir(process.env.CHAT_UI_SCREENSHOT_DIR, { recursive: true });
    for (const [width, height, scale] of [[1280, 850, 1], [768, 900, 1.25], [390, 844, 2]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale }), page = await context.newPage();
      await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
      await page.goto(`${origin}/chat`); await page.locator("#inName").fill("__Test_ScrollOwner");
      await page.locator("#inRoomName").fill(`__Test_ScrollBottom_${width}`); await page.locator("#btnCreate").click();
      await page.locator("#chatView").waitFor({ state: "visible" });
      const roomInfo = await page.evaluate(async (url: string) => { const { app } = await import(url); return { roomId: app.state.room.id, sessionID: app.LS.sessionID }; }, "/assets/chat/state.js");
      await api(origin, `/rooms/${roomInfo.roomId}/join`, "POST", { sessionID: "__Test_ScrollPeer", participantId: "__Test_ScrollPeer", participantName: "__Test_ScrollPeer" });
      for (let index = 0; index < 24; index++) await api(origin, `/rooms/${roomInfo.roomId}/messages`, "POST", { sessionID: roomInfo.sessionID, text: `__Test_scroll ${index}\n${"A line of conversation content.\n".repeat(3)}` });
      await page.reload(); await page.locator("#msgList .msg").nth(23).waitFor();
      const thread = page.locator("#thread"), box = await thread.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.wheel(0, -10000); await page.waitForTimeout(30);
      const scrolledUp = await page.evaluate(() => { const node = document.querySelector<HTMLElement>("#thread")!; return node.scrollTop < node.scrollHeight - node.clientHeight; });
      expect(scrolledUp).toBe(true);
      await page.locator("#btnJump").waitFor({ state: "visible" });
      const jump = await page.evaluate(() => { const button = document.querySelector<HTMLElement>("#btnJump")!, icon = button.firstElementChild!.getBoundingClientRect(), box = button.getBoundingClientRect(); return { width: box.width, height: box.height, radius: getComputedStyle(button).borderRadius, centered: Math.abs(icon.left + icon.width / 2 - (box.left + box.width / 2)) < 1 && Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2)) < 1, badgePosition: getComputedStyle(document.querySelector("#jumpBadge")!).position }; });
      expect(jump).toEqual({ width: 44, height: 44, radius: "50%", centered: true, badgePosition: "absolute" });
      if (process.env.CHAT_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, `scroll-jump-${width}-dpr-${scale}.png`), fullPage: true });
      await page.mouse.wheel(0, 10000);
      await page.waitForTimeout(180);
      const metrics = await page.evaluate(async () => {
        const thread = document.querySelector<HTMLElement>("#thread")!;
        const samples: number[] = [];
        for (let index = 0; index < 5; index++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          samples.push(thread.scrollHeight - thread.clientHeight - thread.scrollTop);
        }
        const root = document.scrollingElement!;
        const rect = (selector: string) => { const { top, bottom, height } = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect(); return { top, bottom, height }; };
        return { threadGaps: samples, pageX: root.scrollWidth - root.clientWidth, pageY: root.scrollHeight - root.clientHeight, jumpHidden: (document.querySelector<HTMLElement>("#btnJump")!).hidden, app: rect("#app"), chat: rect("#chatView"), thread: rect("#thread"), viewport: innerHeight };
      });
      if (!metrics.threadGaps.every((gap: number) => Math.abs(gap) < 1)) throw new Error(JSON.stringify({ width, height, scale, metrics }));
      expect(metrics.pageX).toBe(0); expect(metrics.pageY).toBe(0); expect(metrics.jumpHidden).toBe(true);
      await api(origin, `/rooms/${roomInfo.roomId}/messages`, "POST", { sessionID: "__Test_ScrollPeer", text: `__Test_new_tail_${width}` });
      await page.locator("#msgList").getByText(`__Test_new_tail_${width}`).waitFor(); await page.waitForTimeout(180);
      const afterTail = await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!, root = document.scrollingElement!; return { gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop, pageY: root.scrollHeight - root.clientHeight }; });
      expect(Math.abs(afterTail.gap)).toBeLessThan(1); expect(afterTail.pageY).toBe(0);
      measurements.push({ width, height, deviceScaleFactor: scale, ...metrics, afterTail });
      if (process.env.CHAT_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, `scroll-bottom-${width}-dpr-${scale}.png`), fullPage: true });
      await context.close();
    }
    if (process.env.CHAT_UI_SCREENSHOT_DIR) await writeFile(path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "scroll-bottom-metrics.json"), JSON.stringify(measurements, null, 2));
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

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
