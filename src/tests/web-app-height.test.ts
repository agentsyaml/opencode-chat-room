import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-app-height-token";

// A stale --app-height from an earlier viewport must not make the page scroll.
test.skipIf(!browserModule)("a short viewport stays inside the visible height", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-app-height-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Height tester");
    await page.locator("#inRoomName").fill("Height room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    await page.setViewportSize({ width: 1350, height: 316 });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    // Simulate a viewport change that the page did not observe.
    await page.evaluate(() => document.documentElement.style.setProperty("--app-height", "600px"));
    await page.locator("#msgInput").click();
    await page.waitForTimeout(200);

    const metrics = await page.evaluate(() => {
      const root = document.scrollingElement!;
      const app = document.querySelector<HTMLElement>("#app")!.getBoundingClientRect();
      const head = document.querySelector<HTMLElement>(".chat-head")!.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect();
      return { viewport: innerHeight, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, scrollY: root.scrollTop, appHeight: app.height, headTop: head.top, composerBottom: composer.bottom };
    });
    expect(metrics.scrollHeight).toBe(metrics.clientHeight);
    expect(metrics.scrollY).toBe(0);
    expect(metrics.appHeight).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.headTop).toBeGreaterThanOrEqual(0);
    expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.viewport);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("msgInput");
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

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