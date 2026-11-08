/// <reference lib="dom" />
// The browser side of image messages: attach, preview, send, render, and the
// authenticated fetch that an <img> cannot do by itself.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/K6kAAAAASUVORK5CYII=",
  "base64");

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

test.skipIf(!browserModule)("an image can be attached, sent and rendered", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-image-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const imagePath = path.join(stateDir, "pixel.png");
  await Bun.write(imagePath, PNG_1PX);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.CHAT_ROOM_SERVER_URL;
  delete env.CHAT_ROOM_SERVER_TOKEN;
  delete env.CHAT_ROOM_WAKE_SERVE_URL;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(),
    env: {
      ...env,
      CHAT_ROOM_STATE_DIR: stateDir,
      CHAT_ROOM_SERVER_HOST: "127.0.0.1",
      CHAT_ROOM_SERVER_PORT: String(port),
      CHAT_ROOM_SERVER_TOKEN: "image-ui-token",
      HOME: path.join(stateDir, "home"),
      XDG_STATE_HOME: path.join(stateDir, "state"),
      XDG_CONFIG_HOME: path.join(stateDir, "config"),
    },
    stdio: "ignore",
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("chat.token", "image-ui-token"));
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Alice");
    await page.locator("#inRoomName").fill("Pictures");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#imageInput").setInputFiles(imagePath);
    await page.locator(".image-draft img").waitFor({ state: "visible" });
    await page.locator("#btnSend").click();
    const rendered = page.locator(".message-images img").first();
    await rendered.waitFor({ state: "visible" });
    const natural = await rendered.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, src: node.src.slice(0, 5) }));
    expect(natural.width).toBe(1);
    expect(natural.src).toBe("blob:");
    await page.screenshot({ path: path.join(screenshotDir, "chat-image-desktop.png"), fullPage: true });
    expect(errors).toEqual([]);
    // 360 px: the composer and the thumbnail must still fit.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.locator(".message-images img").first().waitFor({ state: "visible" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(screenshotDir, "chat-image-mobile.png"), fullPage: true });
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
});
