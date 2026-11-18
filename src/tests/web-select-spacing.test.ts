/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-select-spacing-token";

test.skipIf(!browserModule)("select controls keep the chevron gap equal to the text gap", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-select-spacing-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await expectSelect(page, "#localeSelectJoin", 9);
    const joinIcon = page.locator(".locale-control .locale-icon");
    await joinIcon.waitFor({ state: "visible" });
    expect(await joinIcon.getAttribute("aria-hidden")).toBe("true");
    expect(await joinIcon.evaluate((element: SVGElement) => element.tagName.toLowerCase())).toBe("svg");
    await page.locator("#inName").fill("__Test_SelectOwner");
    await page.locator("#inRoomName").fill("__Test_SelectRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
    await expectSelect(page, "#localeSelectSettings", 9);
    await page.locator("#chatSettings .locale-icon").waitFor({ state: "visible" });
    // The native control still focuses and changes like a select after the arrow is redrawn.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("localeSelectSettings");
    expect(await page.locator("#localeSelectSettings").evaluate((element: HTMLElement) => getComputedStyle(element).outlineWidth)).toBe("2px");
    await page.locator("#localeSelectSettings").selectOption("zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    expect(await page.locator("#localeSelectSettings").inputValue()).toBe("zh-CN");
    await page.locator("#chatSettings .locale-icon").waitFor({ state: "visible" });
    expect(await page.locator("#chatSettings .locale-label span").textContent()).toBe("语言");
    await page.locator("#localeSelectSettings").selectOption("en");
    await page.locator("#btnSettings").click();

    await page.locator("#btnRoomOptions").click(); await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    for (const selector of ["#editRoomSuccessor", "#editRoomAdmin", "#editRoomOwner"]) await expectSelect(page, selector, 10);
    await page.locator("#editRoomSuccessor").screenshot({ path: path.join(artifacts, "select-admin-light.png") });
    const lightIcon = await iconSource(page, "#editRoomSuccessor");
    await page.emulateMedia({ colorScheme: "dark" });
    const darkIcon = await iconSource(page, "#editRoomSuccessor");
    expect(darkIcon).not.toBe(lightIcon);
    expect(darkIcon).toContain("a6b3aa");
    await page.locator("#editRoomSuccessor").screenshot({ path: path.join(artifacts, "select-admin-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator("#btnCloseEditRoom").click();

    await page.locator("#btnReminders").click(); await page.locator("#btnNewReminder").click();
    await page.locator("#reminderDialog[open]").waitFor();
    await expectSelect(page, "#reminderType", 13);
    expect(await page.locator("#reminderType").evaluate((element: HTMLSelectElement) => getComputedStyle(element).fontSize)).toBe("16px");
    await page.locator("#btnCloseReminder").click();

    // The same control stays usable and aligned inside the mobile rail drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#roomRail.drawer-open").waitFor();
    await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
    await expectSelect(page, "#localeSelectSettings", 9);
    await page.locator("#chatSettings .locale-icon").waitFor({ state: "visible" });
    await page.locator("#btnSettings").click();
    await page.keyboard.press("Escape"); await page.locator("#roomRail.drawer-open").waitFor({ state: "detached" });
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    await expectSelect(page, "#editRoomSuccessor", 10);
    await page.locator("#editRoomSuccessor").screenshot({ path: path.join(artifacts, "select-admin-mobile.png") });
    await page.locator("#btnCloseEditRoom").click();
    await page.locator("#btnReminders").click(); await page.locator("#btnNewReminder").click();
    await page.locator("#reminderDialog[open]").waitFor();
    await expectSelect(page, "#reminderType", 13);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function expectSelect(page: any, selector: string, gap: number) {
  await page.locator(selector).waitFor({ state: "visible" });
  const metrics = await page.locator(selector).evaluate((element: HTMLSelectElement) => {
    const style = getComputedStyle(element);
    return {
      appearance: style.appearance, padLeft: parseFloat(style.paddingLeft), padRight: parseFloat(style.paddingRight),
      position: style.backgroundPosition, size: style.backgroundSize, image: style.backgroundImage,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(metrics.appearance).toBe("none");
  expect(metrics.padLeft).toBe(gap);
  expect(metrics.position).toContain(`calc(100% - ${gap}px)`);
  expect(metrics.size).toBe("12px 8px");
  expect(metrics.image).toContain("data:image/svg+xml");
  expect(metrics.padRight - metrics.padLeft).toBeGreaterThanOrEqual(20);
  expect(Math.round(metrics.height)).toBeGreaterThanOrEqual(36);
}

async function iconSource(page: any, selector: string) {
  return page.locator(selector).evaluate((element: HTMLSelectElement) => getComputedStyle(element).backgroundImage);
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
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