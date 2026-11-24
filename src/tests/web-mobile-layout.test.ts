/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-mobile-layout-token";
const androidUA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const ipadUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

test.skipIf(!browserModule)("mobile header, drawer, composer, and shortcut hint stay compact", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-mobile-layout-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_MobileOwner");
    await page.locator("#inRoomName").fill("__Test_MobileLayout");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const boot = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>("#roomRail")!;
      return {
        visibility: getComputedStyle(rail).visibility,
        transform: getComputedStyle(rail).transform,
        animations: document.getAnimations().filter((animation) => (animation.effect as KeyframeEffect | null)?.target === rail).length,
      };
    });
    expect(boot.visibility).toBe("hidden");
    expect(boot.transform).not.toBe("none");
    expect(boot.animations).toBe(0);
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>("#chatView")!).opacity === "1");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 700 });
      await page.waitForTimeout(120);
      const metrics = await mobileMetrics(page);
      expect(metrics.overflow).toBe(false);
      expect(metrics.head.height).toBeLessThanOrEqual(width <= 380 ? 60 : 64);
      expect(metrics.headFits).toBe(true);
      expect(metrics.head.padding).toBeLessThanOrEqual(10);
      expect(metrics.actions.length).toBe(4);
      expect(metrics.actions.every((size: number) => size >= (width <= 380 ? 40 : 44))).toBe(true);
      expect(metrics.sameRow).toBe(true);
      expect(metrics.metaVisible).toBe(false);
      expect(metrics.title.width).toBeGreaterThan(0);
      expect(metrics.title.right).toBeLessThanOrEqual(metrics.actionsStart - 1);
      expect(metrics.drawer.width).toBeGreaterThanOrEqual(44);
      expect(metrics.composer.height).toBeLessThanOrEqual(160);
      expect(metrics.composer.input).toBeGreaterThanOrEqual(44);
      expect(metrics.composer.input).toBeLessThanOrEqual(48);
      expect(metrics.composer.send).toBeGreaterThanOrEqual(44);
      expect(metrics.composer.attach).toBeGreaterThanOrEqual(44);
      expect(Math.abs(metrics.composer.input - metrics.composer.send)).toBeLessThanOrEqual(4);
      expect(metrics.meta.height).toBeLessThanOrEqual(20);
      expect(metrics.meta.singleRow).toBe(true);
      // A narrow desktop window keeps the hardware-keyboard hint.
      expect(metrics.shortcut).toBe(true);
      expect(metrics.placeholder).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `web-mobile-layout-${width}.png`) });
    }

    // The drawer slides in over a fading backdrop and never reflows the thread.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(120);
    const rail = page.locator("#roomRail"), backdrop = page.locator("#roomDrawerBackdrop");
    const threadBefore = await page.locator("#msgScroll").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    await page.locator("#btnRoomsDrawer").click();
    await rail.waitFor({ state: "visible" });
    const drawer = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>("#roomRail")!, style = getComputedStyle(rail);
      return {
        duration: parseFloat(style.transitionDuration), properties: style.transitionProperty,
        transform: style.transform, left: rail.getBoundingClientRect().left,
        animation: (() => { const noAnim = rail.classList.contains("no-drawer-animation"); return noAnim; })(),
      };
    });
    expect(drawer.properties).toContain("transform");
    expect(drawer.duration).toBeGreaterThanOrEqual(0.18);
    expect(drawer.duration).toBeLessThanOrEqual(0.22);
    await page.waitForFunction(() => {
      const style = getComputedStyle(document.querySelector<HTMLElement>("#roomRail")!);
      return style.transform === "none" || style.transform === "matrix(1, 0, 0, 1, 0, 0)";
    });
    expect(await rail.evaluate((node: HTMLElement) => node.getBoundingClientRect().left)).toBe(0);
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>("#roomDrawerBackdrop")!).opacity === "1");
    expect(await page.locator("#msgScroll").evaluate((node: HTMLElement) => node.getBoundingClientRect().height)).toBe(threadBefore);
    await page.screenshot({ path: path.join(artifacts, "web-mobile-layout-drawer-390.png") });

    await page.keyboard.press("Escape");
    await rail.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#roomDrawerBackdrop")!.hidden);
    expect(await page.locator("#btnRoomsDrawer").getAttribute("aria-expanded")).toBe("false");

    await page.locator("#btnRoomsDrawer").click();
    await rail.waitFor({ state: "visible" });
    await page.locator("#roomDrawerBackdrop").click({ position: { x: 380, y: 600 } });
    await rail.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#roomDrawerBackdrop")!.hidden);

    // Reduced motion removes the slide instead of lengthening it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#btnRoomsDrawer").click();
    await rail.waitFor({ state: "visible" });
    const reduced = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>("#roomRail")!).transitionDuration.split(",").map((part) => parseFloat(part)));
    expect(reduced.every((value: number) => value === 0)).toBe(true);
    await page.keyboard.press("Escape");
    await rail.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#roomDrawerBackdrop")!.hidden);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>("#chatView")!).opacity === "1");

    // Landscape phones keep the composer on screen without horizontal overflow.
    await page.setViewportSize({ width: 740, height: 360 });
    await page.waitForTimeout(120);
    const landscape = await mobileMetrics(page);
    expect(landscape.overflow).toBe(false);
    expect(landscape.head.height).toBeLessThanOrEqual(64);
    expect(landscape.headFits).toBe(true);
    expect(landscape.sameRow).toBe(true);
    expect(landscape.composer.bottom).toBeLessThanOrEqual(360);
    expect(landscape.composer.height).toBeLessThanOrEqual(160);
    expect(Math.abs(landscape.composer.input - landscape.composer.send)).toBeLessThanOrEqual(4);
    await page.screenshot({ path: path.join(artifacts, "web-mobile-layout-landscape-740x360.png") });

    // A keyboard-sized viewport still leaves the composer fully on screen.
    await page.setViewportSize({ width: 740, height: 300 });
    await page.locator("#msgInput").click();
    await page.waitForTimeout(120);
    const keyboard = await mobileMetrics(page);
    expect(keyboard.overflow).toBe(false);
    expect(keyboard.composer.bottom).toBeLessThanOrEqual(300);
    expect(keyboard.composer.input).toBeGreaterThanOrEqual(44);

    // A real Android UA hides the keyboard hint and keeps every touch control.
    const android = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: androidUA, hasTouch: true, colorScheme: "light" });
    const androidPage = await android.newPage();
    androidPage.setDefaultTimeout(15000);
    androidPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await androidPage.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await androidPage.goto(`${origin}/chat`);
    await androidPage.locator("#inName").fill("__Test_MobileAndroid");
    await androidPage.locator("#inRoomName").fill("__Test_MobileAndroidRoom");
    await androidPage.locator("#btnCreate").click();
    await androidPage.locator("#chatView").waitFor({ state: "visible" });
    await androidPage.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>("#chatView")!).opacity === "1");
    expect(await androidPage.evaluate(() => document.documentElement.dataset.mobile)).toBe("true");
    expect(await androidPage.locator("#btnShortcuts").isVisible()).toBe(false);
    expect(await androidPage.locator("#btnAddAttachments").isVisible()).toBe(true);
    expect(await androidPage.locator("#btnSend").isVisible()).toBe(true);
    expect(await androidPage.locator("#draftCount").isVisible()).toBe(true);
    const androidMetrics = await mobileMetrics(androidPage);
    expect(androidMetrics.overflow).toBe(false);
    expect(androidMetrics.head.height).toBeLessThanOrEqual(64);
    expect(androidMetrics.sameRow).toBe(true);
    expect(androidMetrics.actions.every((size: number) => size >= 44)).toBe(true);
    expect(androidMetrics.metaVisible).toBe(false);
    expect(androidMetrics.composer.height).toBeLessThanOrEqual(160);
    expect(androidMetrics.meta.height).toBeLessThanOrEqual(20);
    expect(androidMetrics.shortcut).toBe(false);
    await androidPage.waitForTimeout(320);
    await androidPage.screenshot({ path: path.join(artifacts, "web-mobile-layout-android-390.png") });
    await android.close();

    // iPadOS claims to be a Macintosh; touch points must still count as mobile.
    const ipad = await browser.newContext({ viewport: { width: 820, height: 1180 }, userAgent: ipadUA });
    const ipadPage = await ipad.newPage();
    ipadPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await ipadPage.addInitScript(() => {
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
      localStorage.setItem("chat.token", "chat-mobile-layout-token");
    });
    await ipadPage.goto(`${origin}/chat`);
    await ipadPage.locator("#joinView").waitFor({ state: "visible" });
    expect(await ipadPage.evaluate(() => document.documentElement.dataset.mobile)).toBe("true");
    expect(await ipadPage.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>("#btnShortcuts")!).display)).toBe("none");
    await ipad.close();

    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function mobileMetrics(page: any) {
  return page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const head = rect(".chat-head");
    const headNode = document.querySelector<HTMLElement>(".chat-head")!;
    const composer = rect(".composer");
    const row = rect(".composer-row");
    const input = rect("#msgInput"), send = rect("#btnSend"), attach = rect("#btnAddAttachments");
    const meta = rect(".composer-meta"), count = rect("#draftCount");
    const short = document.querySelector<HTMLElement>("#btnShortcuts")!;
    const headStyle = getComputedStyle(headNode);
    const title = rect("#roomName"), actions = rect(".chat-head-actions");
    const chips = Array.from(document.querySelectorAll<HTMLElement>(".chat-head-actions .chip")).map((chip) => {
      const box = chip.getBoundingClientRect();
      return { width: box.width, height: box.height, center: box.y + box.height / 2 };
    });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth || headNode.scrollWidth > headNode.clientWidth,
      head: { height: head.height, padding: parseFloat(headStyle.paddingTop) + parseFloat(headStyle.paddingBottom) },
      actions: chips.map((chip) => chip.width),
      actionsStart: actions.x,
      drawer: { width: rect("#btnRoomsDrawer").width },
      sameRow: chips.every((chip) => Math.abs(chip.center - (title.y + title.height / 2)) <= 2),
      title: { width: title.width, right: title.right },
      metaVisible: rect(".room-meta").width > 0,
      composer: { height: composer.height, bottom: composer.bottom, input: input.height, send: send.height, attach: attach.height, row: row.height },
      meta: { height: meta.height, singleRow: Math.abs(count.top + count.height / 2 - (meta.top + meta.height / 2)) <= 1 },
      shortcut: short.getClientRects().length > 0 && getComputedStyle(short).display !== "none",
      placeholder: (() => { const content = getComputedStyle(document.querySelector<HTMLElement>("#msgInput")!, "::before").content; return Boolean(content) && content !== "none" && content !== "normal"; })(),
      headFits: head.right <= innerWidth && head.left >= 0,
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