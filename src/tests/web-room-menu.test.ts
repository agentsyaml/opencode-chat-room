/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-room-menu-token";

test.skipIf(!browserModule)("announcements open from the Options menu and leaving as a human asks first", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-room-menu-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_MenuOwner");
    await page.locator("#inRoomName").fill("__Test_RoomMenu");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForTimeout(300);

    // Members stay a header chip; only announcements moved into the Options menu.
    expect(await page.locator("#btnMembers").isVisible()).toBe(true);
    expect(await page.locator("#roomOptions #btnMembers").count()).toBe(0);
    expect(await page.locator("#roomOptions").isHidden()).toBe(true);
    expect(await page.locator("#roomOptions .menu-action").first().getAttribute("id")).toBe("btnAnnouncements");
    expect(await page.locator("#roomOptions .menu-action svg").count()).toBe(6);

    await page.locator("#btnRoomOptions").click();
    expect(await page.locator("#btnRoomOptions").getAttribute("aria-expanded")).toBe("true");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "room-options-menu-1280.png") });
    await page.locator("#btnAnnouncements").click();
    await page.locator("#announcementPanel").waitFor({ state: "visible" });
    expect(await page.locator("#roomOptions").isHidden()).toBe(true);
    expect(await page.locator("#btnRoomOptions").getAttribute("aria-expanded")).toBe("false");
    await page.waitForFunction(() => document.activeElement?.id === "announcementHeading");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "announcement-panel-1280.png") });
    await page.keyboard.press("Escape");
    await page.locator("#announcementPanel").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnRoomOptions");

    // Phone layout: the menu and the panel stay inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    await page.locator("#btnRoomOptions").click();
    const menuBox = await page.locator("#roomOptions").boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "room-options-menu-390.png") });
    await page.keyboard.press("Escape");
    await page.locator("#roomOptions").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnRoomOptions");
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnAnnouncements").click();
    const panelBox = await page.locator("#announcementPanel").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(390);
    expect(panelBox!.y).toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "announcement-panel-390.png") });
    await page.keyboard.press("Escape");
    await page.locator("#announcementPanel").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnRoomOptions");

    // Narrow, tablet, and short desktop widths keep the menu inside the viewport.
    for (const [width, height] of [[320, 700], [768, 600], [1280, 500]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
      await page.locator("#btnRoomOptions").click();
      const box = await page.locator("#roomOptions").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      await page.keyboard.press("Escape");
      await page.locator("#roomOptions").waitFor({ state: "hidden" });
    }

    // Cancelling the leave confirmation keeps the room; the palette path asks too.
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnLeave").click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    const message = (await page.locator("#confirmMessage").textContent())?.trim() ?? "";
    expect(message).toContain("__Test_RoomMenu");
    expect(message.toLowerCase()).toContain("leave");
    await page.locator("#btnCancelConfirm").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    expect(await page.locator("#chatView").isVisible()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");

    const leftRoomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill("/leave");
    await page.locator("#paletteInput").fill("/");
    await page.locator("#paletteList .palette-command").filter({ hasText: "Leave room" }).click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    await page.locator("#btnAcceptConfirm").click();
    await page.locator("#joinView").waitFor({ state: "visible" });
    await page.locator(`#roomList [data-room-id="${leftRoomId}"]`).waitFor();
    expect(await page.locator("#confirmDialog").isHidden()).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port");
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