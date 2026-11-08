import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-receipt-popover-local-token";

test.skipIf(!browserModule)("receipt details float beside their trigger and remain keyboard and touch accessible", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-receipt-popover-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Receipt tester");
    await page.locator("#inRoomName").fill("__Test_ReceiptPopover");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgInput").fill("Popover anchor message");
    await page.locator("#btnSend").click();
    const message = page.locator('[data-msg-id]').filter({ hasText: "Popover anchor message" }).last();
    await message.waitFor();
    const id = await message.getAttribute("data-msg-id");
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    await page.evaluate(async ({ url, roomId, id }: any) => {
      const { app } = await import(url);
      app.renderReceiptData(roomId, [{ messageID: id, readers: [{ sessionID: "reader-one", name: "Reader One", evidence: "displayed", currentMember: true }] }]);
    }, { url: "/assets/chat/state.js", roomId, id });
    const trigger = message.locator(".message-readers");
    await trigger.focus(); await page.keyboard.press("Enter");
    const panel = page.locator("#readerPanel"); await panel.waitFor({ state: "visible" });
    await page.locator('#readerList [data-reader-session-id="reader-one"]').waitFor();
    expect(await page.locator("#readerList").getByText("Reader One").count()).toBe(1);
    expect(await panel.getAttribute("role")).toBe("dialog");
    const desktop = await geometry(page, trigger);
    expect(desktop.near).toBe(true); expect(desktop.inBounds).toBe(true);
    await page.keyboard.press("Escape");
    expect(await trigger.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
    await page.setViewportSize({ width: 320, height: 640 });
    const touchTarget = await trigger.boundingBox();
    await page.touchscreen.tap(touchTarget!.x + touchTarget!.width / 2, touchTarget!.y + touchTarget!.height / 2);
    await panel.waitFor({ state: "visible" });
    const mobile = await geometry(page, trigger);
    expect(mobile.inBounds).toBe(true);
    expect(mobile.width).toBeLessThanOrEqual(296);
    await page.locator("#roomName").click();
    await panel.waitFor({ state: "hidden" });
    await page.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function geometry(page: any, trigger: any) {
  return page.evaluate((button: HTMLElement) => {
    const a = button.getBoundingClientRect(), p = document.querySelector<HTMLElement>("#readerPanel")!.getBoundingClientRect();
    const verticalGap = Math.min(Math.abs(p.bottom - a.top), Math.abs(p.top - a.bottom));
    return { near: p.left < a.right && p.right > a.left && verticalGap <= 10,
      inBounds: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight, width: p.width };
  }, await trigger.elementHandle());
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
