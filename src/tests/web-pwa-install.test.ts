/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;

test.skipIf(!browserModule)("the install prompt is offered once on phones and explains iOS", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-install-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  const fireInstallable = (page: any) => page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    (event as any).prompt = async () => ({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });

    const open = async (page: any) => {
      await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), "chat-install-token");
      await page.goto(`${origin}/chat`);
    };
    const desktop = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await open(desktop);
    await fireInstallable(desktop);
    await desktop.waitForTimeout(150);
    expect(await desktop.locator("#installPrompt").isHidden()).toBe(true);
    expect(await desktop.locator("#railInstall").isHidden()).toBe(true);
    await desktop.close();

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const phoneErrors: string[] = [];
    phone.on("pageerror", (error: Error) => phoneErrors.push(error.message));
    await open(phone);
    expect(await phone.locator("#installPrompt").isHidden()).toBe(true);
    await fireInstallable(phone);
    await phone.locator("#installPrompt").waitFor();
    expect(await phone.locator("#btnInstallApp").isVisible()).toBe(true);
    expect(await phone.locator("#btnInstallGuide").isHidden()).toBe(true);
    await phone.waitForTimeout(350);
    await phone.screenshot({ path: path.join(artifacts, "chat-install-prompt.png") });
    await phone.locator("#btnDismissInstall").click();
    expect(await phone.locator("#installPrompt").isHidden()).toBe(true);
    expect(await phone.evaluate(() => document.activeElement?.id)).toBe("inName");
    expect(await phone.evaluate(() => Number(localStorage.getItem("chat.installDismissedAt")) > 0)).toBe(true);
    await phone.reload();
    await fireInstallable(phone);
    await phone.waitForTimeout(150);
    expect(await phone.locator("#installPrompt").isHidden()).toBe(true);
    expect(phoneErrors).toEqual([]);
    await phone.close();

    const accepted = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await open(accepted);
    await fireInstallable(accepted);
    await accepted.locator("#btnInstallApp").click();
    expect(await accepted.locator("#installPrompt").isHidden()).toBe(true);
    expect(await accepted.evaluate(() => localStorage.getItem("chat.installedApp"))).toBe("1");
    await accepted.reload();
    await fireInstallable(accepted);
    await accepted.waitForTimeout(150);
    expect(await accepted.locator("#installPrompt").isHidden()).toBe(true);
    await accepted.close();

    const drawer = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await open(drawer);
    await fireInstallable(drawer);
    await drawer.locator("#inName").fill("__Test_InstallOwner");
    await drawer.locator("#inRoomName").fill("Install drawer room");
    await drawer.locator("#btnCreate").click();
    await drawer.locator("#chatView").waitFor({ state: "visible" });
    await drawer.locator("#btnRoomsDrawer").click();
    await drawer.locator("#railInstall").waitFor();
    expect(await drawer.locator("#btnRailInstall").isVisible()).toBe(true);
    await drawer.waitForTimeout(450);
    await drawer.screenshot({ path: path.join(artifacts, "chat-install-drawer.png") });
    await drawer.locator("#btnRailInstall").click();
    expect(await drawer.locator("#railInstall").isHidden()).toBe(true);
    expect(await drawer.evaluate(() => document.activeElement?.id)).toBe("btnSettings");
    expect(await drawer.evaluate(() => localStorage.getItem("chat.installedApp"))).toBe("1");
    await drawer.close();

    const iosContext = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
    const ios = await iosContext.newPage();
    await ios.addInitScript(() => localStorage.setItem("chat.locale", "zh-CN"));
    await open(ios);
    await ios.locator("#installPrompt").waitFor();
    expect(await ios.locator("#installPromptTitle").textContent()).toBe("安装 OC Chat");
    expect(await ios.locator("#btnInstallApp").isHidden()).toBe(true);
    expect(await ios.locator("#installGuide").isHidden()).toBe(true);
    await ios.locator("#btnInstallGuide").click();
    expect(await ios.locator("#installGuide").isVisible()).toBe(true);
    expect(await ios.locator("#installGuide").textContent()).toContain("添加到主屏幕");
    expect(await ios.locator("#btnInstallGuide").getAttribute("aria-expanded")).toBe("true");
    await ios.screenshot({ path: path.join(artifacts, "chat-install-ios.png") });
    await iosContext.close();

    const standalone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await standalone.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => query.includes("display-mode: standalone")
        ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as any
        : original(query);
    });
    await open(standalone);
    await fireInstallable(standalone);
    await standalone.waitForTimeout(150);
    expect(await standalone.locator("#installPrompt").isHidden()).toBe(true);
    await standalone.close();

    const blocked = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const blockedErrors: string[] = [];
    blocked.on("pageerror", (error: Error) => blockedErrors.push(error.message));
    await blocked.addInitScript(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key: string) { if (String(key).startsWith("chat.install")) throw new Error("blocked"); return get.call(this, key); };
      Storage.prototype.setItem = function (key: string, value: string) { if (String(key).startsWith("chat.install")) throw new Error("blocked"); return set.call(this, key, value); };
    });
    await open(blocked);
    await fireInstallable(blocked);
    await blocked.locator("#installPrompt").waitFor();
    await blocked.locator("#btnDismissInstall").click();
    expect(await blocked.locator("#installPrompt").isHidden()).toBe(true);
    expect(blockedErrors).toEqual([]);
    await blocked.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: "chat-install-token" };
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