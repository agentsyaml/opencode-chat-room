/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-mobile-input-token";

test.skipIf(!browserModule)("mobile Enter inserts a newline and the composer stays inside the viewport", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-mobile-input-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_MobileInput");
    await page.locator("#inRoomName").fill("__Test_MobileInput");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    expect(await page.locator("#msgInput").getAttribute("enterkeyhint")).toBe("enter");
    expect(await page.evaluate(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight))).toBeLessThanOrEqual(1);

    await page.locator("#msgInput").fill("first line");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    expect(await page.locator("#msgList .msg").filter({ hasText: "first line" }).count()).toBe(0);
    expect((await page.locator("#msgInput").innerText()).replace(/\u00a0/g, " ")).toContain("first line\n");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("msgInput");

    await page.locator("#btnSend").click();
    await page.locator("#msgList .msg").filter({ hasText: "first line" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return {
    ...env,
    CHAT_ROOM_STATE_DIR: path.join(stateDir, "rooms"),
    CHAT_ROOM_SERVER_HOST: "127.0.0.1",
    CHAT_ROOM_SERVER_PORT: String(port),
    CHAT_ROOM_SERVER_TOKEN: token,
    HOME: path.join(stateDir, "home"),
    XDG_CONFIG_HOME: path.join(stateDir, "config"),
    XDG_STATE_HOME: path.join(stateDir, "state"),
  };
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}