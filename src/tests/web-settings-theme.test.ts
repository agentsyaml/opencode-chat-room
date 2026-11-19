/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-settings-token";

test.skipIf(!browserModule)("settings keeps language, theme, and the token in one dialog", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-settings-"));
  const screenshots = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshots, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#joinView").waitFor({ state: "visible" });
    expect(await page.locator("#localeSelectJoin").count()).toBe(0);
    expect(await page.locator("#btnJoinSettings").count()).toBe(1);

    // The public dialog opens before joining and exposes all five themes.
    await page.locator("#btnJoinSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#chatSettings").getAttribute("aria-labelledby")).toBe("settingsHeading");
    expect(await page.locator("#settingsHeading").textContent()).toBe("Settings");
    await page.waitForFunction(() => document.activeElement?.id === "localeSelectSettings");
    const choices = await page.locator('#chatSettings input[name="theme"]').evaluateAll((nodes: HTMLInputElement[]) => nodes.map((node) => node.value));
    expect(choices).toEqual(["system", "light", "dark", "forest", "sand"]);
    expect(await page.locator('#chatSettings input[value="system"]').isChecked()).toBe(true);
    expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#f3f1ea");

    await page.locator("#localeSelectSettings").selectOption("zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    expect(await page.locator("#btnJoin").textContent()).toBe("加入房间");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-join-zh.png"), fullPage: true });

    const languages: Record<string, string> = {
      ja: "ルームに参加", ko: "방 참여", fr: "Rejoindre le salon",
      de: "Raum beitreten", es: "Entrar en la sala", it: "Entra nella stanza",
    };
    expect(await page.locator("#localeSelectSettings option").count()).toBe(8);
    for (const [code, label] of Object.entries(languages)) {
      await page.locator("#localeSelectSettings").selectOption(code);
      await page.waitForFunction((lang: string) => document.documentElement.lang === lang, code);
      expect(await page.locator("#btnJoin").textContent()).toBe(label);
      expect(await page.evaluate(() => localStorage.getItem("chat.locale"))).toBe(code);
    }
    await page.locator("#localeSelectSettings").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");

    await page.locator('[data-theme-choice="dark"]').click();
    expect(await page.locator("#chatSettings").evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#111b19");
    expect(await page.locator("#chatSettings").evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toBe("#111b19");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-join-dark.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnJoinSettings");

    // An explicit choice survives a reload, and the pre-paint bootstrap applies it.
    await page.reload();
    await page.locator("#joinView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#111b19");
    expect(await page.evaluate(() => localStorage.getItem("chat.theme"))).toBe("dark");

    // System follows the emulated color scheme; an explicit light choice does not.
    await page.locator("#btnJoinSettings").click();
    await page.locator('[data-theme-choice="system"]').click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#111b19");
    expect(await page.locator("#chatSettings").evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toBe("#111b19");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#f3f1ea");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator('[data-theme-choice="light"]').click();
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#f3f1ea");
    expect(await page.locator("#chatSettings").evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    await page.emulateMedia({ colorScheme: "light" });

    await page.locator('[data-theme-choice="forest"]').click();
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#e7ede2");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-join-forest.png"), fullPage: true });
    await page.locator("#btnCloseSettings").click();
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    // The signed-in chat opens the same dialog from its rail entry.
    await page.locator("#inName").fill("Alice");
    await page.locator("#inRoomName").fill("Design room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#btnSettings").count()).toBe(1);
    expect(await page.locator('#chatSettings input[value="forest"]').isChecked()).toBe(true);
    expect(await page.locator("#chatSettings .settings-section").count()).toBe(3);

    await page.locator("#inTokenChat").fill(token);
    await page.locator('[data-token-save="inTokenChat"]').click();
    await page.waitForFunction(() => document.querySelector('[data-token-save="inTokenChat"]')?.textContent === "Saved");
    expect(await page.evaluate(() => localStorage.getItem("chat.token"))).toBe(token);

    await page.locator('[data-theme-choice="sand"]').click();
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#f4e9d6");
    expect(await page.locator("#chatSettings").evaluate(() => document.documentElement.dataset.theme)).toBe("sand");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-chat-sand.png"), fullPage: true });
    await page.mouse.click(6, 6);
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnSettings");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30000);

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
  delete env.CHAT_ROOM_SERVER_URL;
  delete env.CHAT_ROOM_SERVER_TOKEN;
  delete env.CHAT_ROOM_WAKE_SERVE_URL;
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