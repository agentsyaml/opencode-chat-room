/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-mobile-header-token";

test.skipIf(!browserModule)("the mobile chat header stays compact with usable controls", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-mobile-header-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_HeaderOwner");
    await page.locator("#inRoomName").fill("A very long room name 1234567890");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    for (const width of [549, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(180);
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => { const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
        const head = document.querySelector<HTMLElement>(".chat-head")!, title = document.querySelector<HTMLElement>("#roomName")!, meta = box(".room-meta"), drawer = box("#btnRoomsDrawer");
        const actions = box(".chat-head-actions"), main = box(".chat-head-main");
        const rows = Array.from(document.querySelectorAll<HTMLElement>(".chat-head-actions .chip")).map((chip) => { const rect = chip.getBoundingClientRect(); return { width: rect.width, height: rect.height, center: rect.y + rect.height / 2 }; });
        return {
          head: box(".chat-head"), drawer, chips: rows, meta, actions, main,
          title: { ...box("#roomName"), scroll: title.scrollWidth, client: title.clientWidth, ellipsis: getComputedStyle(title).textOverflow, center: box("#roomName").y + box("#roomName").height / 2 },
          roomId: document.querySelector("#roomIdShort")?.textContent || "",
          sameRow: rows.every((chip) => Math.abs(chip.center - (box("#roomName").y + box("#roomName").height / 2)) <= 2),
          actionsAfterTitle: actions.x >= box("#roomName").right - 1,
          overflow: document.documentElement.scrollWidth <= innerWidth && head.scrollWidth <= head.clientWidth,
        };
      });
      expect(metrics.head.height).toBeLessThanOrEqual(width === 549 ? 65 : width <= 380 ? 60 : 64);
      expect(metrics.head.bottom).toBeLessThanOrEqual(130);
      expect(metrics.overflow).toBe(true);
      expect(metrics.roomId.length).toBeGreaterThan(0);
      if (width <= 480) expect(metrics.meta.width).toBe(0);
      else {
        expect(metrics.meta.width).toBeGreaterThan(0);
        expect(metrics.title.right).toBeLessThanOrEqual(metrics.meta.x - 1);
      }
      expect(metrics.title.width).toBeGreaterThan(0);
      expect(metrics.title.ellipsis).toBe("ellipsis");
      expect(metrics.actionsAfterTitle).toBe(true);
      if (metrics.title.scroll > metrics.title.client) expect(metrics.title.scroll).toBeGreaterThan(metrics.title.client);
      expect(metrics.drawer.width).toBeGreaterThanOrEqual(44);
      expect(metrics.drawer.height).toBeGreaterThanOrEqual(44);
      expect(metrics.chips.length).toBe(4);
      const chipMin = width <= 380 ? 40 : 44;
      expect(metrics.chips.every((chip: { width: number; height: number }) => chip.width >= chipMin && chip.height >= chipMin)).toBe(true);
      expect(metrics.sameRow).toBe(true);
      expect(metrics.actions.y + metrics.actions.height / 2).toBeLessThanOrEqual(metrics.title.center + 2);
      expect(metrics.actions.y + metrics.actions.height / 2).toBeGreaterThanOrEqual(metrics.title.center - 2);
      if (width === 390 || width === 549) await page.screenshot({ path: path.join(artifacts, `chat-mobile-header-${width}.png`) });
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

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