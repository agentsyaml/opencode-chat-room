/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-window-frame-token";

test.skipIf(!browserModule)("window frame defaults framed and switches live", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-window-frame-"));
  const screenshots = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshots, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, pwaContext: any;
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await createRoom(page, "Window Frame", "Framed room");
    expect(await page.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("framed");
    const framed = await frameStyles(page);
    expect(framed).toMatchObject({ appMax: "1440px", border: "1px", radius: "18px", marginTop: "18px" });
    expect(framed.marginLeft).not.toBe("0px");
    expect(framed.left).toBeGreaterThan(0);
    expect(framed.shadow).not.toBe("none");
    expect(framed.width).toBeLessThan(1440);
    expect(Math.abs(framed.overflowY)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "window-frame-framed-1440.png") });

    // Appearance exposes a persistent label and live Framed/Borderless values.
    await openAppearance(page);
    await page.waitForTimeout(250);
    const modeRow = page.locator(".panel-mode-row").last();
    await modeRow.scrollIntoViewIfNeeded();
    const hoverGeometry = () => modeRow.evaluate((row: Element) => {
      const rect = (node: Element | null) => {
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      };
      return { row: rect(row), label: rect(row.querySelector("label, span")), select: rect(row.querySelector("select")) };
    });
    const beforeHover = await hoverGeometry();
    await modeRow.hover();
    expect(await hoverGeometry()).toEqual(beforeHover);
    expect(await page.locator("#inWindowFrame").inputValue()).toBe("framed");
    expect(await page.locator('label[for="inWindowFrame"] span').textContent()).toBe("Display mode");
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#localeSelectSettings").selectOption("zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    await page.locator("#settingsTabAppearance").click();
    expect(await page.locator('label[for="inWindowFrame"] span').textContent()).toBe("显示模式");
    expect(await page.locator("#inWindowFrame option").allTextContents()).toEqual(["窗口模式", "内容铺满"]);
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#localeSelectSettings").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.locator("#settingsTabAppearance").click();

    await page.locator("#inWindowFrame").selectOption("borderless");
    await page.waitForFunction(() => document.documentElement.dataset.windowFrame === "borderless");
    const borderless = await frameStyles(page);
    expect(borderless).toMatchObject({ appMax: "none", border: "0px", radius: "0px", marginTop: "0px", marginLeft: "0px", shadow: "none" });
    expect(Math.abs(borderless.width - 1440)).toBeLessThanOrEqual(1);
    expect(Math.abs(borderless.height - 900)).toBeLessThanOrEqual(1);
    expect(borderless.rail).toBe(252);
    expect(borderless.chatPane).toBeGreaterThan(300);
    expect(borderless.backgroundImage).toBe("none");
    expect(Math.abs(borderless.overflowY)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(250);
    await page.locator("#inWindowFrame").selectOption("framed");
    await page.waitForFunction(() => document.documentElement.dataset.windowFrame === "framed");
    const restored = await frameStyles(page);
    expect(restored).toMatchObject({ border: "1px", radius: "18px", marginTop: "18px" });
    await page.locator("#inWindowFrame").selectOption("borderless");
    await page.waitForFunction(() => document.documentElement.dataset.windowFrame === "borderless");
    await page.locator("#btnCloseSettings").click();
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "window-frame-borderless-1440.png") });

    // Borderless persists across reload; auto and bad saved values fall back to framed.
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("borderless");
    expect(await page.evaluate(() => localStorage.getItem("chat.windowFrame"))).toBe("borderless");
    await page.evaluate(() => localStorage.setItem("chat.windowFrame", "auto"));
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("framed");
    await page.evaluate(() => localStorage.setItem("chat.windowFrame", "not-a-mode"));
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("framed");

    // An installed display mode still defaults to the framed card.
    pwaContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const pwa = await pwaContext.newPage();
    pwa.setDefaultTimeout(15000);
    pwa.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await pwa.addInitScript(standaloneDisplayMode);
    await pwa.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await pwa.goto(`${origin}/chat`);
    await createRoom(pwa, "Installed Window", "PWA room");
    expect(await pwa.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("framed");
    const installedFramed = await frameStyles(pwa);
    expect(installedFramed).toMatchObject({ appMax: "1440px", border: "1px", radius: "18px", marginTop: "18px", rail: 252 });
    await pwa.waitForTimeout(250);
    await pwa.screenshot({ path: path.join(screenshots, "window-frame-framed-pwa-1440.png") });

    await openAppearance(pwa);
    expect(await pwa.locator("#inWindowFrame").inputValue()).toBe("framed");
    await pwa.locator("#inWindowFrame").selectOption("borderless");
    await pwa.waitForFunction(() => document.documentElement.dataset.windowFrame === "borderless");
    const installed = await frameStyles(pwa);
    expect(installed).toMatchObject({ appMax: "none", border: "0px", radius: "0px", marginTop: "0px", shadow: "none", rail: 252 });
    expect(installed.chatPane).toBeGreaterThan(300);
    expect(installed.overflowX).toBe(0);
    await pwa.locator("#btnCloseSettings").click();
    await pwa.locator("#chatSettings").waitFor({ state: "hidden" });
    await pwa.waitForTimeout(250);
    await pwa.screenshot({ path: path.join(screenshots, "window-frame-borderless-pwa-1440.png") });
    await pwa.reload();
    await pwa.locator("#chatView").waitFor({ state: "visible" });
    expect(await pwa.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("borderless");
    await openAppearance(pwa);
    await pwa.locator("#inWindowFrame").selectOption("framed");
    await pwa.waitForFunction(() => document.documentElement.dataset.windowFrame === "framed");
    expect((await frameStyles(pwa)).radius).toBe("18px");
    await pwa.locator("#inWindowFrame").selectOption("borderless");
    await pwa.waitForFunction(() => document.documentElement.dataset.windowFrame === "borderless");
    await pwa.locator("#btnCloseSettings").click();
    await pwa.locator("#chatSettings").waitFor({ state: "hidden" });

    // The shared splitter still resizes a pane without changing the rail or header.
    await pwa.locator("#btnRoomOptions").click();
    await pwa.locator("#btnTasks").click();
    await pwa.locator("#tasksDialog.is-pane[open]").waitFor();
    const handle = pwa.locator("#sidePaneHandle");
    await handle.waitFor({ state: "visible" });
    const beforePane = (await pwa.locator("#tasksDialog").boundingBox())!;
    expect(await pwa.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>("#app")!).maxWidth)).toBe("none");
    await pwa.setViewportSize({ width: 1800, height: 900 });
    await pwa.waitForTimeout(150);
    expect(await pwa.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>("#app")!).maxWidth)).toBe("none");
    expect(Math.abs(await pwa.evaluate(() => document.querySelector<HTMLElement>("#chatView")!.getBoundingClientRect().width - innerWidth))).toBeLessThanOrEqual(1);
    await pwa.setViewportSize({ width: 1440, height: 900 });
    await pwa.waitForTimeout(150);
    const handleBox = (await handle.boundingBox())!;
    await pwa.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await pwa.mouse.down();
    await pwa.mouse.move(handleBox.x + handleBox.width / 2 - 80, handleBox.y + handleBox.height / 2, { steps: 6 });
    await pwa.mouse.up();
    await pwa.waitForFunction((width: number) => Math.abs(document.querySelector("#tasksDialog")!.getBoundingClientRect().width - width) > 20, beforePane.width);
    expect(await pwa.evaluate(() => document.querySelector<HTMLElement>("#roomRail")!.getBoundingClientRect().width)).toBe(252);
    await pwa.locator("#btnCloseTasks").click();
    await pwa.locator("#tasksDialog").waitFor({ state: "hidden" });

    await pwa.reload();
    await pwa.locator("#chatView").waitFor({ state: "visible" });
    expect(await pwa.evaluate(() => document.documentElement.dataset.windowFrame)).toBe("borderless");
    await pwa.setViewportSize({ width: 390, height: 844 });
    await pwa.waitForTimeout(150);
    const mobile = await frameStyles(pwa);
    expect(mobile.overflowX).toBe(0);
    expect(Math.abs(mobile.overflowY)).toBeLessThanOrEqual(1);
    expect(mobile).toMatchObject({ appMax: "none", border: "0px", radius: "0px", marginTop: "0px", shadow: "none" });
    expect(await pwa.locator("#chatView > .chat-head").isVisible()).toBe(true);
    expect(await pwa.locator("#msgInput").isVisible()).toBe(true);
    await pwa.screenshot({ path: path.join(screenshots, "window-frame-borderless-390.png") });

    expect(pageErrors).toEqual([]);
  } finally {
    await pwaContext?.close();
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

function standaloneDisplayMode() {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    if (query.includes("display-mode:")) {
      const matches = query.includes("standalone");
      return {
        matches, media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        dispatchEvent() { return false; },
      } as MediaQueryList;
    }
    return original(query);
  };
}

async function createRoom(page: any, name: string, room: string) {
  await page.locator("#inName").fill(name);
  await page.locator("#inRoomName").fill(room);
  await page.locator("#btnCreate").click();
  await page.locator("#chatView").waitFor({ state: "visible" });
}

async function openAppearance(page: any) {
  await page.locator("#btnSettings").click();
  await page.locator("#chatSettings[open]").waitFor();
  await page.locator("#settingsTabAppearance").click();
  await page.locator("#settingsPanelAppearance").waitFor({ state: "visible" });
}

async function frameStyles(page: any) {
  return page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>("#chatView")!;
    const app = document.querySelector<HTMLElement>("#app")!;
    const style = getComputedStyle(chat);
    return {
      appMax: getComputedStyle(app).maxWidth,
      border: style.borderTopWidth,
      radius: style.borderRadius,
      marginTop: style.marginTop,
      marginLeft: style.marginLeft,
      shadow: style.boxShadow,
      width: chat.getBoundingClientRect().width,
      height: chat.getBoundingClientRect().height,
      left: chat.getBoundingClientRect().left,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      overflowY: document.documentElement.scrollHeight - innerHeight,
      backgroundImage: getComputedStyle(document.body).backgroundImage,
      rail: document.querySelector<HTMLElement>("#roomRail")?.getBoundingClientRect().width ?? 0,
      chatPane: document.querySelector<HTMLElement>("#msgScroll")?.getBoundingClientRect().width ?? 0,
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