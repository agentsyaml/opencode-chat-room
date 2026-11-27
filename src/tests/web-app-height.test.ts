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

// Pinch zoom shrinks the visual viewport; the layout must keep its size.
test.skipIf(!browserModule)("pinch zoom does not resize the app", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-pinch-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#app").waitFor({ state: "visible" });
    const height = () => page.evaluate(() => ({
      app: document.querySelector<HTMLElement>("#app")!.getBoundingClientRect().height,
      css: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")),
      scale: visualViewport?.scale ?? 1,
    }));
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    const before = await height();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.waitForTimeout(250);
    const zoomed = await height();
    expect(zoomed.scale).toBeGreaterThan(1.5);
    expect(zoomed.app).toBeCloseTo(before.app, 0);
    expect(zoomed.css).toBeCloseTo(before.css, 0);

    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page.waitForTimeout(250);
    const restored = await height();
    expect(restored.scale).toBeCloseTo(1, 1);
    expect(restored.app).toBeCloseTo(before.app, 0);
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

// The thread blocks wheel events at its scroll edges. While pinch-zoomed the
// document cannot scroll, so that block must yield to the visual viewport.
test.skipIf(!browserModule)("pinch zoom keeps wheel panning responsive", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-pinch-scroll-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Pinch tester");
    await page.locator("#inRoomName").fill("Pinch room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgInput").fill("one short message");
    await page.locator("#btnSend").click();
    await page.locator(".msg").first().waitFor();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.waitForTimeout(250);
    const thread = await page.locator("#thread").boundingBox();
    if (!thread) throw new Error("thread is not visible");
    await page.mouse.move(thread.x + thread.width / 2, thread.y + thread.height / 2);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const panned = await page.evaluate(() => ({
      scale: visualViewport?.scale ?? 1,
      offsetTop: visualViewport?.offsetTop ?? 0,
      scrollY: document.scrollingElement?.scrollTop ?? 0,
    }));
    expect(panned.scale).toBeGreaterThan(1.5);
    expect(panned.offsetTop + panned.scrollY).toBeGreaterThan(0);

    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page.waitForTimeout(250);
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