/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-background-token";
const GLOBAL_KEY = "chat.background";
const ROOM_PREFIX = "chat.background.room.";
// A 1x1 transparent PNG is enough to prove the data URL path without a fixture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.skipIf(!browserModule)("chat background is global, browser-local, and previewed before applying", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-background-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#joinView").waitFor({ state: "visible" });

    // The join page has no room yet; the image still covers the whole client window.
    await page.locator("#btnJoinSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabAppearance").click();
    expect(await page.locator(".chat-background-block").isVisible()).toBe(true);
    expect(await page.locator("#inChatBackgroundMode").inputValue()).toBe("default");
    expect(await page.locator("#inChatBackgroundOpacity").inputValue()).toBe("35");
    expect(await page.locator("#chatBackgroundOpacityField").isHidden()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    expect(await page.locator("#inChatBackgroundColor").count()).toBe(0);
    expect(await page.locator("#inChatBackgroundScope").count()).toBe(0);
    const modes = await page.locator("#inChatBackgroundMode option").evaluateAll((nodes: HTMLOptionElement[]) => nodes.map((node) => node.value));
    expect(modes).toEqual(["default", "image"]);
    await page.locator("#inChatBackgroundMode").selectOption("image");
    expect(await page.locator("#inChatBackgroundImage").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundOpacityField").isVisible()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    await page.locator("#inChatBackgroundImage").setInputFiles({ name: "window.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction((key: string) => Boolean(localStorage.getItem(key)?.includes("data:image/png")), GLOBAL_KEY);
    expect(await page.locator("#chatBackgroundStatus").textContent()).toBe("window.png applied.");
    expect(await page.locator("#chatBackgroundPreview").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundPreview").getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(await page.locator("#chatBackgroundFileName").textContent()).toBe("window.png");
    let layer = await layerState(page);
    expect(layer.hasClass).toBe(true);
    expect(layer.kind).toBe("image");
    expect(layer.position).toBe("fixed");
    expect(layer.backgroundImage).toContain("data:image/png");
    expect(layer.backgroundSize).toBe("cover");
    expect(layer.backgroundPosition).toBe("50% 50%");
    expect(layer.pointerEvents).toBe("none");
    expect(layer.opacity).toBe("0.35");
    expect(layer.width).toBeGreaterThanOrEqual(1920);
    expect(layer.height).toBeGreaterThanOrEqual(1080);
    expect((await stored(page, GLOBAL_KEY))?.kind).toBe("image");
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "chat-background-settings-join.png") });

    // Reset hides the preview, revokes the object state, and clears storage.
    await page.locator("#inChatBackgroundMode").selectOption("default");
    expect(await stored(page, GLOBAL_KEY)).toBe(null);
    expect(await page.locator("#chatBackgroundPreview").isHidden()).toBe(true);
    expect(await page.locator("#chatBackgroundPreview").getAttribute("src")).toBe(null);
    expect(await page.locator("#chatBackgroundFileName").isHidden()).toBe(true);
    expect(await page.locator("#chatBackgroundStatus").isHidden()).toBe(true);
    expect(await page.locator("#inChatBackgroundMode").inputValue()).toBe("default");
    expect(await page.locator("#chatBackgroundOpacityField").isHidden()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    expect((await layerState(page)).hasClass).toBe(false);
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    await page.locator("#inName").fill("Background tester");
    await page.locator("#inRoomName").fill("__Test_ChatBackground");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "background-peer", participantId: "Peer", participantName: "Peer" });
    for (let index = 0; index < 5; index++) {
      await api(origin, `/rooms/${room.id}/messages`, "POST", {
        sessionID: index % 2 ? room.sessionID : "background-peer",
        text: `Background message ${index} stays readable above the layer and wraps normally on a phone.`,
      });
    }
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgList .msg.own").first().waitFor();
    await page.evaluate(async (url: string) => { (await import(url)).app.stopPolling(); }, "/assets/chat/state.js");
    await page.waitForTimeout(300);

    const defaults = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      return {
        threadBackground: getComputedStyle(thread).backgroundColor,
        composerBackground: getComputedStyle(document.querySelector<HTMLElement>(".composer")!).backgroundImage,
      };
    });

    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabAppearance").click();
    await page.locator("#inChatBackgroundMode").waitFor({ state: "visible" });
    const blockPosition = await page.evaluate(() => {
      const grid = document.querySelector("#settingsPanelAppearance .theme-grid")!;
      const block = document.querySelector("#settingsPanelAppearance .chat-background-block")!;
      return (grid.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(blockPosition).toBe(true);
    const blockGap = await page.evaluate(() => {
      const grid = document.querySelector("#settingsPanelAppearance .theme-grid")!.getBoundingClientRect();
      const block = document.querySelector("#settingsPanelAppearance .chat-background-block")!.getBoundingClientRect();
      return block.top - grid.bottom;
    });
    expect(blockGap).toBeGreaterThanOrEqual(20);
    expect(await page.locator("#inChatBackgroundMode").inputValue()).toBe("default");
    expect(await page.locator("#chatBackgroundOpacityField").isHidden()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);

    // Picking an image previews it immediately; invalid and oversized files keep it.
    await page.locator("#inChatBackgroundMode").selectOption("image");
    expect(await page.locator("#inChatBackgroundImage").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundOpacityField").isVisible()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    const backgroundLayout = await page.evaluate(() => {
      const modeField = document.querySelector<HTMLElement>("#inChatBackgroundMode")!.closest(".chat-background-field")!;
      const opacityField = document.querySelector<HTMLElement>("#chatBackgroundOpacityField")!;
      const modeLabel = modeField.querySelector<HTMLElement>(".field-label")!;
      const modeSelect = modeField.querySelector<HTMLElement>("select")!;
      const opacityLabel = opacityField.querySelector<HTMLElement>(".field-label")!;
      const opacityRange = opacityField.querySelector<HTMLElement>(".chat-background-opacity")!;
      const mode = modeField.getBoundingClientRect();
      const opacity = opacityField.getBoundingClientRect();
      const label = modeLabel.getBoundingClientRect();
      const select = modeSelect.getBoundingClientRect();
      const opacityLabelBox = opacityLabel.getBoundingClientRect();
      const range = opacityRange.getBoundingClientRect();
      const selectStyle = getComputedStyle(modeSelect);
      return {
        sameLeft: Math.abs(mode.left - opacity.left) <= 1,
        below: opacity.top >= mode.bottom - 1,
        compact: mode.height <= 52 && opacity.height <= 52,
        modeLabelLeft: select.left >= label.right,
        modeSelectRight: Math.abs(select.right - mode.right) <= 1,
        opacityLabelLeft: range.left >= opacityLabelBox.right,
        opacityRangeRight: Math.abs(range.right - opacity.right) <= 1,
        selectWidth: select.width,
        selectHeight: select.height,
        selectRadius: parseFloat(selectStyle.borderTopLeftRadius),
        selectFont: parseFloat(selectStyle.fontSize),
        rangeWidth: range.width,
      };
    });
    expect(backgroundLayout.sameLeft).toBe(true);
    expect(backgroundLayout.below).toBe(true);
    expect(backgroundLayout.compact).toBe(true);
    expect(backgroundLayout.modeLabelLeft).toBe(true);
    expect(backgroundLayout.modeSelectRight).toBe(true);
    expect(backgroundLayout.opacityLabelLeft).toBe(true);
    expect(backgroundLayout.opacityRangeRight).toBe(true);

    // Settings controls share the General tab's select size: 168x38, 8px radius.
    const appearanceSelects = await page.locator("#settingsPanelAppearance select").evaluateAll((nodes: Element[]) =>
      nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { width: box.width, height: box.height, radius: parseFloat(style.borderTopLeftRadius), font: parseFloat(style.fontSize) };
      }));
    expect(appearanceSelects.length).toBeGreaterThanOrEqual(6);
    expect(appearanceSelects.every((item: { width: number; height: number; radius: number; font: number }) =>
      Math.abs(item.width - 168) <= 0.5
      && Math.abs(item.height - 38) <= 0.5
      && Math.abs(item.radius - 8) <= 0.5
      && Math.abs(item.font - 13.5) <= 0.1)).toBe(true);
    expect(Math.abs(backgroundLayout.selectWidth - 168)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(backgroundLayout.selectHeight - 38)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(backgroundLayout.selectRadius - 8)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(backgroundLayout.selectFont - 13.5)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(backgroundLayout.rangeWidth - backgroundLayout.selectWidth)).toBeLessThanOrEqual(0.5);
    await page.locator("#settingsTabGeneral").click();
    const generalSelect = await page.locator("#localeSelectSettings").evaluate((node: Element) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { width: box.width, height: box.height, radius: parseFloat(style.borderTopLeftRadius), font: parseFloat(style.fontSize) };
    });
    expect(generalSelect).toEqual({ width: 168, height: 38, radius: 8, font: 13.5 });
    await page.locator("#settingsTabAppearance").click();
    await page.locator("#inChatBackgroundImage").setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
    await page.locator("#chatBackgroundStatus").waitFor({ state: "visible" });
    expect(await page.locator("#chatBackgroundStatus").textContent()).toBe("Choose an image of 2 MiB or less.");
    expect(await page.locator("#chatBackgroundPreview").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundPreview").getAttribute("src")).toStartWith("blob:");
    expect(await page.locator("#chatBackgroundFileName").textContent()).toBe("large.png");
    expect(await stored(page, GLOBAL_KEY)).toBe(null);
    await page.locator("#inChatBackgroundImage").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
    await page.waitForFunction(() => document.querySelector("#chatBackgroundStatus")?.textContent === "Choose an image file.");
    expect(await page.locator("#chatBackgroundPreview").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundFileName").textContent()).toBe("notes.txt");
    expect(await stored(page, GLOBAL_KEY)).toBe(null);

    await page.locator("#inChatBackgroundImage").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction((key: string) => Boolean(localStorage.getItem(key)?.includes("data:image/png")), GLOBAL_KEY);
    layer = await layerState(page);
    expect(layer.hasClass).toBe(true);
    expect(layer.backgroundImage).toContain("data:image/png");
    expect(layer.opacity).toBe("0.35");
    expect(layer.threadBackground).toBe("rgba(0, 0, 0, 0)");
    const storedImage = await stored(page, GLOBAL_KEY);
    expect(storedImage?.kind).toBe("image");
    expect(storedImage?.name).toBe("pixel.png");
    expect(storedImage?.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(await stored(page, `${ROOM_PREFIX}${room.id}`)).toBe(null);
    expect(await page.locator("#chatBackgroundStatus").textContent()).toBe("pixel.png applied.");
    expect(await page.locator("#chatBackgroundPreview").isVisible()).toBe(true);
    expect(await page.locator("#chatBackgroundPreview").getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(await page.locator("#chatBackgroundFileName").textContent()).toBe("pixel.png");
    expect(await page.locator("#inChatBackgroundImage").evaluate((node: HTMLInputElement) => node.files?.[0]?.name)).toBe("pixel.png");
    const composer = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>(".composer")!).backgroundImage);
    expect(composer).toBe(defaults.composerBackground);
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "chat-background-1920.png") });

    // The image survives a reload and applies before the room finishes restoring.
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgList .msg").first().waitFor();
    await page.waitForFunction(() => document.documentElement.classList.contains("has-chat-background"));
    await page.evaluate(async (url: string) => { (await import(url)).app.stopPolling(); }, "/assets/chat/state.js");
    expect((await layerState(page)).backgroundImage).toContain("data:image/png");

    // The same image follows the browser into every room; no per-room value exists.
    const roomB = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const created = await app.api("/rooms", { method: "POST", body: JSON.stringify({ name: "__Test_ChatBackgroundB", ownerId: app.state.myName, sessionID: app.LS.sessionID }) });
      await app.joinRoom(created.id, app.state.myName);
      return created.id;
    }, "/assets/chat/state.js");
    await page.waitForFunction((id: string) => document.querySelector("#roomName")?.textContent === "__Test_ChatBackgroundB", roomB);
    layer = await layerState(page);
    expect(layer.hasClass).toBe(true);
    expect(layer.backgroundImage).toContain("data:image/png");
    expect(await stored(page, `${ROOM_PREFIX}${roomB}`)).toBe(null);

    await page.evaluate(async ({ url, id }: any) => { const { app } = await import(url); app.activateRoom(id); }, { url: "/assets/chat/state.js", id: room.id });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_ChatBackground");
    layer = await layerState(page);
    expect(layer.hasClass).toBe(true);
    expect(layer.backgroundImage).toContain("data:image/png");

    // Reset clears the global value and any legacy per-room keys.
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabAppearance").click();
    await page.evaluate(() => localStorage.setItem("chat.background.room.legacy", JSON.stringify({ kind: "image", image: "data:image/png;base64,AA==", opacity: 35 })));
    await page.locator("#inChatBackgroundMode").selectOption("default");
    expect(await stored(page, GLOBAL_KEY)).toBe(null);
    expect(await stored(page, `${ROOM_PREFIX}${room.id}`)).toBe(null);
    expect(await stored(page, `${ROOM_PREFIX}${roomB}`)).toBe(null);
    expect(await stored(page, "chat.background.room.legacy")).toBe(null);
    expect(await page.locator("#inChatBackgroundImage").evaluate((node: HTMLInputElement) => node.files?.length ?? 0)).toBe(0);
    expect(await page.locator("#chatBackgroundPreview").isHidden()).toBe(true);
    expect(await page.locator("#chatBackgroundOpacityField").isHidden()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    expect(await page.locator("#chatBackgroundStatus").isHidden()).toBe(true);
    layer = await layerState(page);
    expect(layer.hasClass).toBe(false);
    expect(layer.backgroundImage).toBe("none");
    expect(layer.threadBackground).toBe(defaults.threadBackground);
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    // A phone keeps the conversation, messages, receipts, and actions usable.
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabAppearance").click();
    await page.locator("#inChatBackgroundMode").selectOption("image");
    expect(await page.locator("#chatBackgroundOpacityField").isVisible()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    await page.locator("#inChatBackgroundImage").setInputFiles({ name: "phone.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction((key: string) => Boolean(localStorage.getItem(key)?.includes("data:image/png")), GLOBAL_KEY);
    await setInput(page, "#inChatBackgroundOpacity", "60");
    expect((await stored(page, GLOBAL_KEY))?.opacity).toBe(60);
    await page.locator("#settingsHeading").focus();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "chat-background-settings-1920.png") });
    await page.keyboard.press("Escape");
    await page.locator("#chatSettings").waitFor({ state: "hidden" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    await page.waitForTimeout(200);
    const phone = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      const threadRect = thread.getBoundingClientRect();
      const messages = Array.from(document.querySelectorAll<HTMLElement>("#msgList .msg"));
      const visible = messages.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > threadRect.top && rect.top < threadRect.bottom;
      });
      const own = document.querySelector<HTMLElement>("#msgList .msg.own")!;
      const hit = (button: HTMLElement) => {
        button.scrollIntoView({ block: "center" });
        const rect = button.getBoundingClientRect();
        const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { covered: !(node === button || button.contains(node)), visible: rect.width > 0 && rect.height > 0 };
      };
      return {
        pageOverflowX: document.documentElement.scrollWidth - innerWidth,
        scrollOverflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        hasClass: document.documentElement.classList.contains("has-chat-background"),
        threadBackground: getComputedStyle(thread).backgroundColor,
        visibleMessages: visible.length,
        receipt: hit(own.querySelector<HTMLElement>(".message-readers")!),
        action: hit(own.querySelector<HTMLElement>(".message-copy")!),
        threadBottom: threadRect.bottom,
      };
    });
    expect(phone.pageOverflowX).toBeLessThanOrEqual(0);
    expect(phone.scrollOverflowX).toBeLessThanOrEqual(0);
    expect(phone.hasClass).toBe(true);
    expect(phone.threadBackground).toBe("rgba(0, 0, 0, 0)");
    expect(phone.visibleMessages).toBeGreaterThan(0);
    expect(phone.receipt.visible).toBe(true);
    expect(phone.receipt.covered).toBe(false);
    expect(phone.action.visible).toBe(true);
    expect(phone.action.covered).toBe(false);
    layer = await layerState(page);
    expect(layer.position).toBe("fixed");
    expect(layer.width).toBeGreaterThanOrEqual(390);
    expect(layer.height).toBeGreaterThanOrEqual(844);
    expect(layer.opacity).toBe("0.6");
    await page.locator("#msgList .msg.own").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, "chat-background-390.png") });

    await page.evaluate(async (url: string) => { (await import(url)).app.openSettings(); }, "/assets/chat/state.js");
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabAppearance").click();
    await page.locator("#inChatBackgroundMode").selectOption("default");
    expect((await layerState(page)).hasClass).toBe(false);
    expect(await page.locator("#chatBackgroundOpacityField").isHidden()).toBe(true);
    expect(await page.locator("#btnResetChatBackground").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function setInput(page: any, selector: string, value: string) {
  await page.locator(selector).evaluate((node: HTMLInputElement, next: string) => {
    node.value = next;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function stored(page: any, key: string) {
  return page.evaluate((name: string) => {
    const raw = localStorage.getItem(name);
    return raw ? JSON.parse(raw) : null;
  }, key);
}

async function layerState(page: any) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const pseudo = getComputedStyle(document.body, "::before");
    return {
      hasClass: root.classList.contains("has-chat-background"),
      kind: root.dataset.chatBackground,
      position: pseudo.position,
      backgroundImage: pseudo.backgroundImage,
      backgroundSize: pseudo.backgroundSize,
      backgroundPosition: pseudo.backgroundPosition,
      opacity: pseudo.opacity,
      pointerEvents: pseudo.pointerEvents,
      width: parseFloat(pseudo.width),
      height: parseFloat(pseudo.height),
      threadBackground: getComputedStyle(document.querySelector<HTMLElement>("#thread")!).backgroundColor,
    };
  });
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
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

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}