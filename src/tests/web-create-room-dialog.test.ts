/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-create-dialog-token";

test.skipIf(!browserModule)("the rail opens a centered create-room dialog with a backdrop", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-create-dialog-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);

    // The join page keeps its own create card; this test enters the chat once.
    await page.locator("#inName").fill("Dialog tester");
    await page.locator("#inRoomName").fill("__Test_DialogSeed");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    const dialog = page.locator("#createRoomDialog");
    await page.locator("#btnNewRoom").click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const desktop = await page.evaluate(() => {
      const node = document.querySelector<HTMLDialogElement>("#createRoomDialog")!;
      const rect = node.getBoundingClientRect(), root = document.scrollingElement!;
      const form = document.querySelector<HTMLElement>("#railRoomForm")!;
      return {
        modal: node.matches(":modal"), open: node.open,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scrollX: root.scrollWidth - root.clientWidth,
        backdrop: getComputedStyle(node, "::backdrop").backgroundColor,
        formVisible: form.getBoundingClientRect().height > 0,
        focused: document.activeElement?.id,
        expanded: document.querySelector("#btnNewRoom")?.getAttribute("aria-expanded"),
        inputHeight: document.querySelector("#inRoomNameChat")?.getBoundingClientRect().height,
        headingSize: parseFloat(getComputedStyle(document.querySelector("#createRoomHeading")!).fontSize),
        buttonHeight: document.querySelector("#btnCreateChatRoom")?.getBoundingClientRect().height,
      };
    });
    expect(desktop.modal).toBe(true);
    expect(desktop.open).toBe(true);
    expect(desktop.width).toBeGreaterThanOrEqual(540);
    expect(desktop.width).toBeLessThanOrEqual(580);
    expect(desktop.height).toBeGreaterThanOrEqual(340);
    expect(desktop.inputHeight).toBeLessThanOrEqual(52);
    expect(desktop.headingSize).toBeLessThanOrEqual(26);
    expect(desktop.buttonHeight).toBeLessThanOrEqual(40);
    expect(Math.abs((desktop.left + desktop.right) / 2 - desktop.viewportWidth / 2)).toBeLessThanOrEqual(2);
    expect(desktop.top).toBeGreaterThan(0);
    expect(desktop.bottom).toBeLessThanOrEqual(desktop.viewportHeight);
    expect(desktop.backdrop).not.toBe("rgba(0, 0, 0, 0)");
    expect(desktop.formVisible).toBe(true);
    expect(desktop.focused).toBe("inRoomNameChat");
    expect(desktop.expanded).toBe("true");
    expect(desktop.scrollX).toBe(0);
    await page.screenshot({ path: path.join(screenshotDir, "create-room-dialog-1280.png") });

    // Empty names are rejected inside the dialog, not in the composer.
    await page.locator("#btnCreateChatRoom").click();
    await page.locator("#createRoomError").waitFor({ state: "visible" });
    expect(await page.locator("#createRoomError").textContent()).toContain("Enter a room name");
    expect(await page.locator("#sendError").isVisible()).toBe(false);

    await page.locator("#inRoomNameChat").fill("__Test_DialogRoom");
    await page.locator("#inApprovalRequiredChat").check();
    await page.locator("#btnCreateChatRoom").click();
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_DialogRoom");
    await dialog.waitFor({ state: "hidden" });
    expect(await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { name: app.state.room.name, policy: app.state.room.joinPolicy };
    }, "/assets/chat/state.js")).toEqual({ name: "__Test_DialogRoom", policy: "approval" });

    // Cancel, Escape, and the backdrop each dismiss the modal and restore focus.
    await page.locator("#btnNewRoom").click();
    await dialog.waitFor({ state: "visible" });
    await page.locator("#btnCancelCreateRoom").click();
    await dialog.waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnNewRoom");
    expect(await page.locator("#btnNewRoom").getAttribute("aria-expanded")).toBe("false");

    await page.locator("#btnNewRoom").click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnNewRoom");

    await page.locator("#btnNewRoom").click();
    await dialog.waitFor({ state: "visible" });
    await page.mouse.click(6, 6);
    await dialog.waitFor({ state: "hidden" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#btnRoomsDrawer").click();
    await page.locator("#roomRail.drawer-open").waitFor();
    await page.locator("#btnNewRoom").click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const mobile = await page.evaluate(() => {
      const node = document.querySelector<HTMLDialogElement>("#createRoomDialog")!;
      const rect = node.getBoundingClientRect(), root = document.scrollingElement!;
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scrollX: root.scrollWidth - root.clientWidth,
      };
    });
    expect(mobile.width).toBeGreaterThanOrEqual(390 - 24);
    expect(mobile.left).toBeGreaterThanOrEqual(0);
    expect(mobile.right).toBeLessThanOrEqual(390);
    expect(Math.abs((mobile.left + mobile.right) / 2 - 195)).toBeLessThanOrEqual(2);
    expect(mobile.top).toBeGreaterThanOrEqual(0);
    expect(mobile.bottom).toBeLessThanOrEqual(mobile.viewportHeight);
    expect(mobile.scrollX).toBe(0);
    await page.screenshot({ path: path.join(screenshotDir, "create-room-dialog-390.png") });

    // With the drawer open, Escape must reach the modal instead of closing the drawer.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await page.locator("#roomRail").evaluate((rail: HTMLElement) => rail.classList.contains("drawer-open"))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnNewRoom");

    await context.close();
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

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