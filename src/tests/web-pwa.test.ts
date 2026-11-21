/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-pwa-token";

test.skipIf(!browserModule)("installs as an app and starts from the shell while offline", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-pwa-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    // The app keeps a worker out of automated browsers; this is the one test that wants it.
    await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
    await page.goto(`${origin}/chat`);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>("#joinView, #restoreView, #chatView")).some((node) => !node.hidden));
    const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    expect(manifest.start_url).toBe("/chat");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe(manifest.background_color);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
    expect(await page.locator('meta[name="mobile-web-app-capable"]').getAttribute("content")).toBe("yes");
    expect(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content")).toBe("yes");
    const worker = await (await fetch(`${origin}/sw.js`)).text();
    expect(worker).not.toContain("{{version}}");
    expect(worker).toContain('const VERSION = "v');
    expect(worker).toContain('if (!self.registration.active) await self.skipWaiting();');
    expect(worker).toContain('event.data?.type === "SKIP_WAITING"');
    expect((worker.match(/self\.skipWaiting\(\)/g) ?? []).length).toBe(2);
    expect((await fetch(`${origin}/assets/icons/icon-192.png`)).headers.get("content-type")).toBe("image/png");
    await page.evaluate(() => navigator.serviceWorker.ready.then((ready) => Boolean(ready.active)));
    // The second visit is the one a worker controls, which is what an offline start runs.
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>("#joinView, #restoreView, #chatView")).some((node) => !node.hidden), undefined, { timeout: 20000 });
    // Chat data must never come from a cache: a stale answer would show deleted rooms.
    expect(await page.evaluate(() => fetch("/rooms/summary").then(() => "served", () => "blocked"))).toBe("blocked");
    await context.setOffline(false);
    await context.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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
