/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-icons-token";

test.skipIf(!browserModule)("Fluent icons render consistently across the web UI", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-icons-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);

    // Source audit: the only SVG markup lives in the sprite and its JavaScript helper.
    const html = await readFile(path.join(process.cwd(), "server/chat.html"), "utf8");
    const tags = html.match(/<svg\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(30);
    expect(tags.every((tag) => tag.includes('class="fluent-icon'))).toBe(true);
    for (const shape of ["<path", "<circle", "<rect", "<polyline", "<polygon"]) expect(html.includes(shape)).toBe(false);
    const chatDir = path.join(process.cwd(), "server/assets/chat");
    for (const file of (await readdir(chatDir)).filter((name) => name.endsWith(".js") && name !== "icons.js")) {
      const source = await readFile(path.join(chatDir, file), "utf8");
      expect(source.includes("<svg")).toBe(false);
      expect(source.includes("createElementNS")).toBe(false);
    }
    const sprite = await (await fetch(`${origin}/assets/fluent-icons.svg`)).text();
    const symbolIds = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));
    expect(symbolIds.size).toBeGreaterThanOrEqual(30);

    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_IconOwner");
    await page.locator("#inRoomName").fill("__Test_Icons");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(() => (document.querySelector<SVGGraphicsElement>("#btnRefreshRooms svg.fluent-icon")?.getBBox().width || 0) > 0);
    await page.locator("#msgInput").fill("```js\nconst answer = 42;\n```");
    await page.locator("#btnSend").click();
    await page.locator("#msgList .code-block").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const codeBox = await page.locator("#msgList .code-block").boundingBox();
    const textBox = await page.locator("#msgList .msg-text").boundingBox();
    expect(codeBox?.width || 0).toBeGreaterThan(100);
    expect(codeBox?.height || 0).toBeGreaterThan(20);
    expect(textBox?.width || 0).toBeGreaterThan(100);

    const allIconsAudit = () => page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll<SVGElement>("svg.fluent-icon"));
      const visible = icons.filter((node) => getComputedStyle(node).display !== "none" && node.getClientRects().length > 0);
      return {
        stray: document.querySelectorAll("svg:not(.fluent-icon)").length,
        unlabeled: icons.filter((node) => node.getAttribute("aria-hidden") !== "true").length,
        missingFill: visible.filter((node) => getComputedStyle(node).fill === "none").length,
        stroked: visible.filter((node) => getComputedStyle(node).stroke !== "none").length,
        empty: visible.filter((node) => { const box = node.getBoundingClientRect(); return box.width < 1 || box.height < 1; }).length,
      };
    });

    const assertIcons = async () => {
      const audit = await allIconsAudit();
      expect(audit.stray).toBe(0);
      expect(audit.unlabeled).toBe(0);
      expect(audit.missingFill).toBe(0);
      expect(audit.stroked).toBe(0);
      expect(audit.empty).toBe(0);
    };

    // Header chips, message actions, and the code toolbar use the shared helper.
    expect(await page.locator("#msgList .message-copy svg.fluent-icon").count()).toBeGreaterThan(0);
    expect(await page.locator("#msgList .message-reply svg.fluent-icon").count()).toBeGreaterThan(0);
    expect(await page.locator("#msgList .message-recall svg.fluent-icon").count()).toBeGreaterThan(0);
    expect(await page.locator(".code-toolbar .code-tool-icon").count()).toBe(3);
    expect(await page.locator(".code-toolbar svg:not(.fluent-icon)").count()).toBe(0);
    await assertIcons();

    // The Options menu has exactly six icons, each painted beside its label.
    await page.locator("#btnRoomOptions").click();
    await page.locator("#roomOptions").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    expect(await page.locator("#roomOptions .menu-action svg.fluent-icon").count()).toBe(6);
    const desktopMenu = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>("#roomOptions .menu-action"));
      return items.map((item) => {
        const icon = item.querySelector<SVGGraphicsElement>("svg.fluent-icon")!;
        const label = item.querySelector<HTMLElement>("span:last-child")!;
        const iconBox = icon.getBoundingClientRect(), labelBox = label.getBoundingClientRect();
        return {
          iconWidth: iconBox.width, iconHeight: iconBox.height, iconRight: iconBox.right, labelLeft: labelBox.left,
          fill: getComputedStyle(icon).fill, color: getComputedStyle(icon).color,
          bboxWidth: icon.getBBox().width, bboxHeight: icon.getBBox().height,
        };
      });
    });
    expect(desktopMenu).toHaveLength(6);
    for (const item of desktopMenu) {
      expect(item.iconWidth).toBeGreaterThanOrEqual(12);
      expect(item.iconHeight).toBeGreaterThanOrEqual(12);
      expect(item.iconRight).toBeLessThanOrEqual(item.labelLeft + 1);
      expect(item.fill).toBe(item.color);
      expect(item.bboxWidth).toBeGreaterThan(0);
      expect(item.bboxHeight).toBeGreaterThan(0);
    }
    await page.screenshot({ path: path.join(screenshotDir, "web-icons-desktop-1280.png") });
    await page.keyboard.press("Escape");

    // Settings tabs expose the dialog close, three tab icons, and the language mark.
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    expect(await page.locator("#chatSettings .settings-tab svg.fluent-icon").count()).toBe(3);
    expect(await page.locator("#chatSettings .locale-icon").isVisible()).toBe(true);
    expect(await page.locator("#btnCloseSettings svg.fluent-icon").isVisible()).toBe(true);
    await assertIcons();
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    // Palette commands carry one icon each, including the command fallback.
    // The palette opens search-first, so type the command prefix first.
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.keyboard.type("/");
    await page.locator("#paletteList .palette-icon svg.fluent-icon").first().waitFor();
    expect(await page.locator("#paletteList .palette-icon svg.fluent-icon").count()).toBe(10);
    await assertIcons();
    const paletteIcons = await page.locator("#paletteList .palette-icon svg.fluent-icon").evaluateAll((icons: Element[]) => icons.map((icon) => {
      const box = icon.getBoundingClientRect();
      return { width: box.width, height: box.height, fill: getComputedStyle(icon).fill };
    }));
    expect(paletteIcons.every((icon: { width: number; height: number; fill: string }) => icon.width > 0 && icon.height > 0 && icon.fill !== "none")).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });

    // Every icon-only control keeps an accessible name.
    for (const selector of [
      "#btnNewRoom", "#btnRefreshRooms", "#btnRefreshFiles", "#btnAddAttachments",
      "#btnCloseSettings", "#btnCloseCreateRoom", "#btnCloseEditRoom", "#btnCloseFiles",
      "#btnCloseTasks", "#btnRefreshTasks",
      "#btnCloseReminder", "#btnCloseAnnouncement", "#btnCloseReaders", "#btnCloseImage",
      "#btnCloseOwnerOnly", "#btnClosePalette", "#btnCloseShortcuts", "#btnZoomIn", "#btnZoomOut",
    ]) {
      const button = page.locator(selector);
      expect(await button.count()).toBe(1);
      expect((await button.getAttribute("aria-label"))?.trim().length || 0).toBeGreaterThan(0);
      expect((await button.textContent())?.trim()).toBe("");
      expect(await button.locator("svg.fluent-icon").count()).toBe(1);
    }

    // A phone screenshot and geometry check catch missing or overlapping icons.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    await page.locator("#btnRoomOptions").click();
    await page.locator("#roomOptions").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    const mobile = await page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>("#roomOptions")!.getBoundingClientRect();
      const items = Array.from(document.querySelectorAll<HTMLElement>("#roomOptions .menu-action")).map((item) => {
        const icon = item.querySelector<SVGGraphicsElement>("svg.fluent-icon")!;
        const label = item.querySelector<HTMLElement>("span:last-child")!;
        const iconBox = icon.getBoundingClientRect(), labelBox = label.getBoundingClientRect();
        return { iconWidth: iconBox.width, iconHeight: iconBox.height, iconRight: iconBox.right, labelLeft: labelBox.left, top: item.getBoundingClientRect().top };
      });
      const chips = Array.from(document.querySelectorAll<HTMLElement>(".chat-head-actions .chip")).map((chip) => {
        const icon = chip.querySelector<SVGElement>("svg.fluent-icon");
        return { missing: !icon, width: icon?.getBoundingClientRect().width || 0, height: icon?.getBoundingClientRect().height || 0 };
      });
      return { menu: { x: menu.x, right: menu.right }, items, chips };
    });
    expect(mobile.menu.x).toBeGreaterThanOrEqual(0);
    expect(mobile.menu.right).toBeLessThanOrEqual(390);
    expect(mobile.items).toHaveLength(6);
    for (const item of mobile.items) {
      expect(item.iconWidth).toBeGreaterThanOrEqual(12);
      expect(item.iconHeight).toBeGreaterThanOrEqual(12);
      expect(item.iconRight).toBeLessThanOrEqual(item.labelLeft + 1);
    }
    expect(mobile.chips).toHaveLength(4);
    expect(mobile.chips.every((chip: { missing: boolean; width: number; height: number }) => !chip.missing && chip.width > 0 && chip.height > 0)).toBe(true);
    await assertIcons();
    await page.screenshot({ path: path.join(screenshotDir, "web-icons-mobile-390.png") });

    // Every referenced sprite fragment exists.
    const fragments = await page.evaluate(() => Array.from(document.querySelectorAll("use")).map((use) => use.getAttribute("href")?.split("#")[1] || ""));
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.every((fragment: string) => symbolIds.has(fragment))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
});

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