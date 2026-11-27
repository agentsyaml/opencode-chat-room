/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-window-controls-token";

test.skipIf(!browserModule)("window controls overlay adds a drag strip only while visible", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-window-controls-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const viewport = { width: 1280, height: 800 };

    // A normal browser tab reports the overlay but it is not visible: no attribute,
    // no drag strip, and the framed card keeps its usual inset.
    const tab = await browser.newPage({ viewport });
    tab.setDefaultTimeout(15000);
    tab.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await tab.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await tab.goto(`${origin}/chat`);
    await createRoom(tab, "Tab person", "Tab room");
    expect(await tab.evaluate(() => navigator.windowControlsOverlay.visible)).toBe(false);
    expect(await layout(tab)).toMatchObject({ wco: null, drags: 0, appTop: 0, bodyDisplay: "block", chatBorder: "1px", chatRadius: "18px", chatMarginTop: "18px" });
    expect(Math.abs((await layout(tab)).appHeight - viewport.height)).toBeLessThanOrEqual(1);
    expect((await layout(tab)).chatWidth).toBeLessThan(viewport.width);
    expect((await layout(tab)).scrollOverflow).toBe(0);

    // Fake an installed PWA whose overlay becomes visible and changes geometry.
    const pwa = await browser.newPage({ viewport });
    pwa.setDefaultTimeout(15000);
    pwa.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await pwa.addInitScript(fakeWindowControlsOverlay);
    await pwa.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await pwa.goto(`${origin}/chat`);
    await createRoom(pwa, "PWA person", "PWA room");
    expect(await pwa.evaluate(() => navigator.windowControlsOverlay.visible)).toBe(false);
    expect(await layout(pwa)).toMatchObject({ wco: null, drags: 0, appTop: 0, bodyDisplay: "block", chatBorder: "1px", chatRadius: "18px" });

    await pwa.evaluate(() => window.__wco.set(true, { x: 0, y: 0, width: innerWidth - 138, height: 33 }));
    await pwa.waitForFunction(() => document.documentElement.dataset.wco === "true");
    expect(await layout(pwa)).toMatchObject({ wco: "true", drags: 1, appTop: 33, bodyDisplay: "grid", chatBorder: "0px", chatRadius: "0px", chatMarginTop: "0px", chatWidth: viewport.width });
    expect(Math.abs((await layout(pwa)).appHeight - (viewport.height - 33))).toBeLessThanOrEqual(1);
    expect(await dragRect(pwa)).toMatchObject({ x: 0, y: 0, width: viewport.width - 138, height: 33, position: "fixed", appRegion: "drag" });

    // The drag strip and the inset both follow titlebar geometry changes.
    await pwa.evaluate(() => window.__wco.set(true, { x: 80, y: 5, width: 600, height: 40 }));
    await pwa.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--wco-left").trim() === "80px");
    expect(await layout(pwa)).toMatchObject({ wco: "true", drags: 1, appTop: 45, chatWidth: viewport.width });
    expect(Math.abs((await layout(pwa)).appHeight - (viewport.height - 45))).toBeLessThanOrEqual(1);
    expect(await dragRect(pwa)).toMatchObject({ x: 80, y: 5, width: 600, height: 40, position: "fixed", appRegion: "drag" });
    expect((await layout(pwa)).scrollOverflow).toBe(0);

    // Turning the overlay off removes the attribute, drag strip, and inset again.
    await pwa.evaluate(() => window.__wco.set(false));
    await pwa.waitForFunction(() => !document.documentElement.dataset.wco);
    expect(await layout(pwa)).toMatchObject({ wco: null, drags: 0, appTop: 0, bodyDisplay: "block", chatBorder: "1px", chatRadius: "18px", chatMarginTop: "18px" });
    expect(Math.abs((await layout(pwa)).appHeight - viewport.height)).toBeLessThanOrEqual(1);
    expect(await pwa.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--wco-height"))).toBe("");
    expect((await layout(pwa)).scrollOverflow).toBe(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

function fakeWindowControlsOverlay() {
  const overlay = new EventTarget();
  let visible = false;
  let area = { x: 0, y: 0, width: 0, height: 0 };
  Object.defineProperties(overlay, {
    visible: { get: () => visible },
    getTitlebarAreaRect: {
      value: () => ({ ...area, top: area.y, left: area.x, right: area.x + area.width, bottom: area.y + area.height }),
    },
  });
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, get: () => overlay });
  window.__wco = {
    set(next: boolean, nextArea?: typeof area) {
      visible = next;
      if (nextArea) area = nextArea;
      overlay.dispatchEvent(new Event("geometrychange"));
    },
  };
}

declare global {
  interface Navigator {
    windowControlsOverlay: {
      visible: boolean;
      getTitlebarAreaRect(): { x: number; y: number; width: number; height: number };
    };
  }
  interface Window {
    __wco: { set: (visible: boolean, area?: { x: number; y: number; width: number; height: number }) => void };
  }
}

async function createRoom(page: any, name: string, room: string) {
  await page.locator("#inName").fill(name);
  await page.locator("#inRoomName").fill(room);
  await page.locator("#btnCreate").click();
  await page.locator("#chatView").waitFor({ state: "visible" });
}

async function layout(page: any) {
  return page.evaluate(() => {
    const app = document.querySelector<HTMLElement>("#app")!.getBoundingClientRect();
    const chat = document.querySelector<HTMLElement>("#chatView")!;
    const style = getComputedStyle(chat);
    const root = document.scrollingElement!;
    return {
      wco: document.documentElement.getAttribute("data-wco"),
      drags: document.querySelectorAll(".wco-drag").length,
      bodyDisplay: getComputedStyle(document.body).display,
      appTop: app.top,
      appHeight: app.height,
      chatBorder: style.borderTopWidth,
      chatRadius: style.borderRadius,
      chatMarginTop: style.marginTop,
      chatWidth: chat.getBoundingClientRect().width,
      scrollOverflow: root.scrollHeight - root.clientHeight,
    };
  });
}

async function dragRect(page: any) {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>(".wco-drag")!;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
      position: style.position,
      appRegion: style.getPropertyValue("-webkit-app-region"),
    };
  });
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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