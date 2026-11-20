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

test.skipIf(!browserModule)("settings uses tabbed categories for language, appearance, and connection", async () => {
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#joinView").waitFor({ state: "visible" });
    expect(await page.locator("#localeSelectJoin").count()).toBe(0);
    expect(await page.locator("#btnJoinSettings").count()).toBe(1);

    // The public dialog opens before joining on General with the three categories.
    await page.locator("#btnJoinSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#chatSettings").getAttribute("aria-labelledby")).toBe("settingsHeading");
    expect(await page.locator("#settingsHeading").textContent()).toBe("Settings");
    await page.waitForFunction(() => document.activeElement?.id === "localeSelectSettings");
    expect(await page.locator('#chatSettings [role="tab"]').count()).toBe(3);
    expect(await page.locator('#chatSettings [role="tabpanel"]').count()).toBe(3);
    expect(await page.locator("#settingsTabGeneral").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#settingsTabAppearance").getAttribute("aria-selected")).toBe("false");
    expect(await page.locator("#settingsTabConnection").getAttribute("aria-selected")).toBe("false");
    expect(await page.locator("#settingsPanelGeneral").isVisible()).toBe(true);
    expect(await page.locator("#settingsPanelAppearance").isVisible()).toBe(false);
    expect(await page.locator("#settingsPanelConnection").isVisible()).toBe(false);
    const selectedFill = await page.locator("#settingsTabGeneral").evaluate((node: HTMLElement) => getComputedStyle(node).backgroundColor);
    expect(selectedFill).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.locator("#chatSettings .locale-icon").isVisible()).toBe(true);
    expect(await page.locator("#inContentTransition").isVisible()).toBe(true);
    expect(await page.locator("#inPageStep").isVisible()).toBe(true);
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-desktop-general-light.png") });

    // Arrow keys move selection, the panel, and focus; the tablist keeps one tab stop.
    await page.locator("#settingsTabGeneral").focus();
    await page.keyboard.press("ArrowDown");
    expect(await page.locator("#settingsTabAppearance").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#settingsPanelAppearance").isVisible()).toBe(true);
    expect(await page.locator("#settingsPanelGeneral").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("settingsTabAppearance");
    expect(await page.locator("#settingsTabAppearance").evaluate((node: HTMLElement) => getComputedStyle(node).outlineWidth)).toBe("2px");
    expect(await page.locator("#settingsTabAppearance").getAttribute("tabindex")).toBe("0");
    expect(await page.locator("#settingsTabGeneral").getAttribute("tabindex")).toBe("-1");
    await page.keyboard.press("ArrowDown");
    expect(await page.locator("#settingsTabConnection").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("ArrowDown");
    expect(await page.locator("#settingsTabGeneral").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#settingsPanelGeneral").isVisible()).toBe(true);

    await page.locator("#localeSelectSettings").selectOption("zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    expect(await page.locator("#btnJoin").textContent()).toBe("加入房间");
    expect(await page.locator("#settingsTabGeneral span").textContent()).toBe("通用");
    expect(await page.locator("#settingsTabAppearance span").textContent()).toBe("外观");
    expect(await page.locator("#settingsTabConnection span").textContent()).toBe("连接");

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

    // General switches persist immediately; the page-step control clamps to 20–200.
    expect(await page.locator("#inContentTransition").isChecked()).toBe(false);
    await page.locator("#inContentTransition").check();
    expect(await page.evaluate(() => localStorage.getItem("chat.contentTransition"))).toBe("1");
    expect(await page.locator("#inPageStep").inputValue()).toBe("90");
    await page.locator("#inPageStep").fill("55");
    await page.locator("#inPageStep").press("Tab");
    expect(await page.evaluate(() => localStorage.getItem("chat.pageStep"))).toBe("55");
    await page.locator("#inPageStep").fill("5");
    await page.locator("#inPageStep").press("Tab");
    expect(await page.evaluate(() => localStorage.getItem("chat.pageStep"))).toBe("20");
    await page.locator("#inPageStep").fill("55");
    await page.locator("#inPageStep").press("Tab");

    // All five themes are large cards that switch live and follow the system option.
    await page.locator("#settingsTabAppearance").click();
    const choices = await page.locator('#chatSettings input[name="theme"]').evaluateAll((nodes: HTMLInputElement[]) => nodes.map((node) => node.value));
    expect(choices).toEqual(["system", "light", "dark", "forest", "sand"]);
    expect(await page.locator("#chatSettings .theme-option").count()).toBe(5);
    const cardMetrics = await page.locator("#chatSettings .theme-option").evaluateAll((nodes: HTMLElement[]) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, border: getComputedStyle(node).borderTopWidth })));
    for (const card of cardMetrics) {
      expect(card.width).toBeGreaterThan(96);
      expect(card.height).toBeGreaterThan(96);
      expect(card.border).toBe("1px");
    }
    expect(await page.locator('#chatSettings input[value="system"]').isChecked()).toBe(true);
    for (const [value, color] of [["light", "#f3f1ea"], ["dark", "#111b19"], ["forest", "#e7ede2"], ["sand", "#f4e9d6"]] as const) {
      await page.locator(`[data-theme-choice="${value}"]`).click();
      expect(await page.locator("#chatSettings").evaluate(() => document.documentElement.dataset.theme)).toBe(value);
      expect(await page.evaluate(() => localStorage.getItem("chat.theme"))).toBe(value);
      await page.waitForFunction((expected: string) => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === expected, color);
    }
    await page.locator('[data-theme-choice="system"]').click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#111b19");
    expect(await page.locator("#chatSettings").evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toBe("#111b19");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#f3f1ea");
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-desktop-light.png") });
    await page.locator('[data-theme-choice="dark"]').click();
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-desktop-dark.png") });

    // A reload keeps the language, theme, transition, and page step.
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#localeSelectSettings").selectOption("zh-CN");
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnJoinSettings");
    expect(await page.locator("#btnJoinSettings").getAttribute("aria-expanded")).toBe("false");
    await page.reload();
    await page.locator("#joinView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.waitForFunction(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#111b19");
    await page.locator("#btnJoinSettings").click();
    expect(await page.locator("#settingsTabGeneral").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#localeSelectSettings").inputValue()).toBe("zh-CN");
    expect(await page.locator("#inContentTransition").isChecked()).toBe(true);
    expect(await page.locator("#inPageStep").inputValue()).toBe("55");
    await page.locator("#settingsTabAppearance").click();
    expect(await page.locator('#chatSettings input[value="dark"]').isChecked()).toBe(true);
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#localeSelectSettings").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");

    // The 401 path opens Connection, focuses the token, and shows the required hint.
    await page.locator("#btnCloseSettings").click();
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    await page.evaluate(async (url: string) => (await import(url)).app.openChatSettings(), "/assets/chat/state.js");
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#settingsTabConnection").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#settingsPanelConnection").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("inTokenChat");
    expect(await page.locator("#tokenHint").isVisible()).toBe(true);
    expect(await page.locator("#inTokenChat").inputValue()).toBe(token);
    expect(await page.locator('[data-token-save="inTokenChat"]').isVisible()).toBe(true);
    expect(await page.locator('[data-i18n="privacyNote"]').isVisible()).toBe(true);
    await page.locator("#inTokenChat").fill(token);
    await page.locator('[data-token-save="inTokenChat"]').click();
    await page.waitForFunction(() => document.querySelector('[data-token-save="inTokenChat"]')?.textContent === "Saved");
    expect(await page.locator("#tokenHint").isVisible()).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("chat.token"))).toBe(token);
    await page.locator("#btnCloseSettings").click();
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    // A normal open returns to General; the 401 hint stays hidden in Connection.
    await page.locator("#btnJoinSettings").click();
    expect(await page.locator("#settingsTabGeneral").getAttribute("aria-selected")).toBe("true");
    await page.locator("#settingsTabConnection").click();
    expect(await page.locator("#tokenHint").isVisible()).toBe(false);
    await page.mouse.click(6, 6);
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnJoinSettings");
    expect(await page.locator("#btnJoinSettings").getAttribute("aria-expanded")).toBe("false");

    // The signed-in chat opens the same dialog from its rail entry.
    await page.locator("#inName").fill("Alice");
    await page.locator("#inRoomName").fill("Design room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#settingsTabGeneral").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#inContentTransition").isChecked()).toBe(true);
    expect(await page.locator("#inPageStep").inputValue()).toBe("55");
    await page.locator("#settingsTabAppearance").click();
    expect(await page.locator('#chatSettings input[value="dark"]').isChecked()).toBe(true);
    expect(await page.locator("#chatSettings .theme-option").count()).toBe(5);
    await page.locator("#settingsTabConnection").click();
    expect(await page.locator("#inTokenChat").inputValue()).toBe(token);
    expect(await page.locator("#tokenHint").isVisible()).toBe(false);
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-desktop-connection-dark.png") });
    await page.mouse.click(6, 6);
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnSettings");
    expect(await page.locator("#btnSettings").getAttribute("aria-expanded")).toBe("false");

    // Mobile: the categories become one horizontal segmented row without clipping or overflow.
    await page.setViewportSize({ width: 390, height: 812 });
    await page.locator("#btnRoomsDrawer").click();
    await page.locator("#roomRail.drawer-open").waitFor();
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await expectMobileDialog(page);
    await page.locator("#settingsTabAppearance").click();
    await page.locator('[data-theme-choice="light"]').click();
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-mobile-390-light.png") });
    await page.locator('[data-theme-choice="dark"]').click();
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-mobile-390-dark.png") });
    await page.locator("#settingsTabConnection").click();
    expect(await page.locator("#inTokenChat").isVisible()).toBe(true);
    expect(await page.locator('[data-token-save="inTokenChat"]').isVisible()).toBe(true);
    expect(await page.locator('[data-i18n="privacyNote"]').isVisible()).toBe(true);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator("#settingsTabGeneral").click();
    await expectMobileDialog(page);

    // A short viewport keeps the page fixed and scrolls only the settings content.
    await page.setViewportSize({ width: 390, height: 400 });
    await page.locator("#settingsTabAppearance").click();
    const scroll = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>("#chatSettings .settings-content")!;
      content.scrollTop = 120;
      return {
        overflow: getComputedStyle(content).overflowY,
        scrollable: content.scrollHeight > content.clientHeight,
        scrolled: content.scrollTop > 0,
        pageX: document.documentElement.scrollWidth - innerWidth,
        pageY: document.documentElement.scrollHeight - innerHeight,
        dialogBottom: document.querySelector<HTMLElement>("#chatSettings")!.getBoundingClientRect().bottom,
        viewport: innerHeight,
      };
    });
    expect(scroll.overflow).toBe("auto");
    expect(scroll.scrollable).toBe(true);
    expect(scroll.scrolled).toBe(true);
    expect(scroll.pageX).toBeLessThanOrEqual(1);
    expect(scroll.dialogBottom).toBeLessThanOrEqual(scroll.viewport);

    await page.setViewportSize({ width: 390, height: 812 });
    await page.locator("#settingsTabGeneral").click();
    await expectMobileDialog(page);

    // A small phone keeps the segmented tabs on one row and the token field usable.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator("#settingsTabConnection").click();
    const small = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("#chatSettings")!, close = document.querySelector<HTMLElement>("#btnCloseSettings")!, token = document.querySelector<HTMLInputElement>("#inTokenChat")!, save = document.querySelector<HTMLElement>('[data-token-save="inTokenChat"]')!, content = dialog.querySelector<HTMLElement>(".settings-content")!;
      const rect = dialog.getBoundingClientRect(), closeRect = close.getBoundingClientRect(), tokenRect = token.getBoundingClientRect();
      const tabs = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) => ({ top: Math.round(tab.getBoundingClientRect().top), width: tab.getBoundingClientRect().width, font: parseFloat(getComputedStyle(tab).fontSize), text: tab.querySelector("span")!.textContent }));
      return {
        tabs, tokenWidth: tokenRect.width, tokenHeight: tokenRect.height, tokenVisible: token.getClientRects().length > 0, saveVisible: save.getClientRects().length > 0,
        closeInside: closeRect.left >= rect.left && closeRect.right <= rect.right && closeRect.top >= rect.top && closeRect.bottom <= rect.bottom,
        clamped: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
        pageX: document.documentElement.scrollWidth - innerWidth, pageY: document.documentElement.scrollHeight - innerHeight,
        dialogX: dialog.scrollWidth - dialog.clientWidth, contentX: content.scrollWidth - content.clientWidth,
        selected: document.querySelector('#chatSettings [role="tab"][aria-selected="true"]')?.getAttribute("data-settings-tab"),
      };
    });
    expect(small.tabs).toHaveLength(3);
    expect(new Set(small.tabs.map((tab: { top: number }) => tab.top)).size).toBe(1);
    expect(small.tabs.every((tab: { width: number; font: number; text: string }) => tab.width >= 60 && tab.font >= 11 && tab.text.length > 0)).toBe(true);
    expect(small.selected).toBe("connection");
    expect(small.tokenVisible && small.saveVisible).toBe(true);
    expect(small.tokenWidth).toBeGreaterThan(120);
    expect(small.tokenHeight).toBeGreaterThanOrEqual(36);
    expect(small.closeInside && small.clamped).toBe(true);
    expect(small.pageX).toBeLessThanOrEqual(1);
    expect(small.pageY).toBeLessThanOrEqual(1);
    expect(small.dialogX).toBeLessThanOrEqual(1);
    expect(small.contentX).toBeLessThanOrEqual(1);
    await page.locator("#inTokenChat").fill(token);
    expect(await page.locator("#inTokenChat").inputValue()).toBe(token);
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshots, "settings-mobile-320-dark.png") });
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnSettings");
    expect(await page.locator("#btnSettings").getAttribute("aria-expanded")).toBe("false");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function expectMobileDialog(page: any) {
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>("#chatSettings")!, nav = dialog.querySelector<HTMLElement>(".settings-nav")!, close = document.querySelector<HTMLElement>("#btnCloseSettings")!, content = dialog.querySelector<HTMLElement>(".settings-content")!;
    const rect = dialog.getBoundingClientRect(), closeRect = close.getBoundingClientRect();
    const tabs = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) => ({ top: Math.round(tab.getBoundingClientRect().top), width: tab.getBoundingClientRect().width, visible: tab.getClientRects().length > 0 }));
    return {
      tabs, navDisplay: getComputedStyle(nav).display, selected: document.querySelector('#chatSettings [role="tab"][aria-selected="true"]')?.getAttribute("data-settings-tab"),
      closeInside: closeRect.left >= rect.left - 1 && closeRect.right <= rect.right + 1 && closeRect.top >= rect.top - 1 && closeRect.bottom <= rect.bottom + 1,
      clamped: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
      pageX: document.documentElement.scrollWidth - innerWidth, dialogX: dialog.scrollWidth - dialog.clientWidth,
      contentOverflow: getComputedStyle(content).overflowY,
    };
  });
  expect(metrics.tabs).toHaveLength(3);
  expect(metrics.tabs.every((tab: { visible: boolean; width: number }) => tab.visible && tab.width > 40)).toBe(true);
  expect(new Set(metrics.tabs.map((tab: { top: number }) => tab.top)).size).toBe(1);
  expect(metrics.navDisplay).toBe("grid");
  expect(metrics.selected).toBe("general");
  expect(metrics.closeInside).toBe(true);
  expect(metrics.clamped).toBe(true);
  expect(metrics.pageX).toBeLessThanOrEqual(1);
  expect(metrics.dialogX).toBeLessThanOrEqual(1);
  expect(metrics.contentOverflow).toBe("auto");
}

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