/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-double-escape-token";

test.skipIf(!browserModule)("double Escape focuses the composer only without an open overlay", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-double-escape-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Escape tester");
    await page.locator("#inRoomName").fill("__Test_DoubleEscape");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    // A single Escape leaves focus alone; the second press within the window owns the composer.
    await page.locator("#btnSettings").focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnSettings");
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");

    // An open panel absorbs the first Escape, so the next press is a new single.
    await page.locator("#btnMembers").click();
    await page.locator("#memberPanel:not([hidden])").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    expect(await page.locator("#memberPanel").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnMembers");

    // The mobile drawer behaves the same: closing it leaves focus in the rail.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#btnRoomsDrawer").click();
    await page.locator("#roomRail.drawer-open").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    expect(await page.locator("#roomRail").evaluate((rail: HTMLElement) => rail.classList.contains("drawer-open"))).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnRoomsDrawer");

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