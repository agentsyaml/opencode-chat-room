/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-shortcuts-token";

test.skipIf(!browserModule)("Alt+/ opens the shortcut sheet and no control tags remain", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-shortcuts-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 600 }, reducedMotion: "no-preference" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#joinView").waitFor({ state: "visible" });

    // No overlay, badges, legend, or rail hint. The only visible entry appears in chat.
    expect(await page.locator("#keyboardHints, [data-hint-target], .keys-badge, .keys-legend, #keyboardHintMarks").count()).toBe(0);
    expect(await page.locator("#railKeyHint, #btnKeysJoin, #btnKeysChat, [data-shortcuts]").count()).toBe(0);

    // Alt+/ opens a sheet of real shortcuts only.
    await page.keyboard.press("Alt+/");
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Option" : "Alt");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    expect(await page.locator("#shortcutsHeading").textContent()).toBe("Keyboard shortcuts");
    const rows: string[][] = await page.locator("#shortcutsDialog .keys-list li").evaluateAll((items: Element[]) =>
      items.map((item) => Array.from(item.querySelectorAll("kbd")).map((key) => key.textContent ?? "")));
    expect(rows.length).toBe(8);
    expect(rows).toContainEqual(["Enter"]);
    expect(rows).toContainEqual(["Shift", "Enter"]);
    expect(rows).toContainEqual(["↑", "↓", "Enter"]);
    expect(rows).toContainEqual([modifier, "↑", "↓"]);
    expect(rows).toContainEqual([modifier, "1–9"]);
    expect(rows).toContainEqual([modifier, "Home", "End"]);
    expect(rows).toContainEqual(["PageUp", "PageDown"]);
    expect(rows).toContainEqual(["Esc"]);
    const sheet = await page.locator("#shortcutsDialog").textContent();
    expect(sheet).toContain("Switch to the previous or next room");
    expect(sheet).toContain("Scroll messages while typing");
    expect(sheet).not.toContain("Tab");
    expect(sheet).not.toContain("Space");
    expect(sheet).not.toContain("?");
    expect(await page.locator("#btnToggleHints").count()).toBe(0);

    // Escape and the close button both dismiss it.
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Alt+/");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.mouse.click(4, 4);
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Alt+/");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.locator("#btnCloseShortcuts").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });

    // '?' is plain text now and never opens the sheet.
    await page.locator("#inName").click();
    await page.keyboard.press("?");
    expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    expect(await page.locator("#inName").inputValue()).toBe("?");

    await page.locator("#inName").fill("Shortcut tester");
    await page.locator("#inRoomName").fill("__Test_Shortcuts");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    // The compact entry sits under the composer, never in the header, and never keeps focus.
    const entry = await page.locator("#btnShortcuts").evaluate((node: Element) => {
      const style = getComputedStyle(node as HTMLElement);
      return { inComposer: Boolean(node.closest(".composer-meta")), inHeader: Boolean(node.closest(".chat-head-actions")), height: (node as HTMLElement).getBoundingClientRect().height, fontSize: parseFloat(style.fontSize), label: getComputedStyle(node.querySelector(".action-label")!).display };
    });
    expect(entry.inComposer).toBe(true);
    expect(entry.inHeader).toBe(false);
    expect(entry.height).toBeLessThanOrEqual(24);
    expect(entry.fontSize).toBeLessThanOrEqual(11);
    expect(entry.label).toBe("none");
    expect(await page.locator("#btnShortcuts").getAttribute("tabindex")).toBe("-1");
    await page.locator("#msgInput").click();
    await page.locator("#btnShortcuts").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.mouse.click(4, 4);
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");
    await page.locator("#btnShortcuts").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");

    // Alt+Arrow keeps the motion in the room list and never animates the thread.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      await app.createRoom({ name: "Shortcut tester", roomName: "__Test_Second", joinPolicy: "open", fromChat: true });
    }, "/assets/chat/state.js");
    await page.waitForFunction(() => document.querySelectorAll("#roomListChat .room-row").length >= 2 && document.querySelector("#roomListChat .room-row.selected"));
    const beforeSwitch = await page.locator("#roomListChat .room-row.selected").getAttribute("data-room-id");
    await page.evaluate(() => {
      const list = document.querySelector("#roomListChat");
      (window as any).__roomSwitchMotion = null;
      const observer = new MutationObserver(() => {
        const row = list?.querySelector(".room-row.room-switch-enter") as HTMLElement | null;
        if (!row) return;
        (window as any).__roomSwitchMotion = {
          className: row.className,
          animation: getComputedStyle(row).animationName,
        };
        observer.disconnect();
      });
      if (list) observer.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    });
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForFunction((previous: string) => {
      const row = document.querySelector("#roomListChat .room-row.selected") as HTMLElement | null;
      return Boolean(row && row.dataset.roomId !== previous);
    }, beforeSwitch);
    await page.waitForFunction(() => Boolean((window as any).__roomSwitchMotion));
    const switchMotion = await page.evaluate(() => (window as any).__roomSwitchMotion as { className: string; animation: string });
    expect(switchMotion.className).toContain("room-switch-enter");
    expect(switchMotion.animation).toBe("room-switch-row");
    expect(await page.locator("#msgList").evaluate((list: Element) => ({
      className: (list as HTMLElement).className,
      animation: getComputedStyle(list).animationName,
    }))).toEqual({ className: "", animation: "none" });

    // Alt+1…9 selects joined rooms in the same order as the rail.
    const joinedIds = await page.locator("#roomListChat .room-row.joined").evaluateAll((rows: Element[]) =>
      rows.map((row) => (row as HTMLElement).dataset.roomId ?? ""));
    expect(joinedIds.length).toBe(2);
    const selectedId = () => page.locator("#roomListChat .room-row.selected").getAttribute("data-room-id");
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Digit1");
    await page.waitForFunction((id: string) => (document.querySelector("#roomListChat .room-row.selected") as HTMLElement | null)?.dataset.roomId === id, joinedIds[0]);
    expect(await selectedId()).toBe(joinedIds[0]);
    await page.keyboard.press("Alt+Digit2");
    await page.waitForFunction((id: string) => (document.querySelector("#roomListChat .room-row.selected") as HTMLElement | null)?.dataset.roomId === id, joinedIds[1]);
    expect(await selectedId()).toBe(joinedIds[1]);
    await page.keyboard.press("Control+Alt+Digit1");
    await page.waitForTimeout(100);
    expect(await selectedId()).toBe(joinedIds[1]);

    // The content transition is opt-in and follows the same direction.
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.LS.contentTransition = true;
    }, "/assets/chat/state.js");
    const seen = page.evaluate(() => new Promise<string[]>((resolve) => {
      const list = document.querySelector("#msgList");
      if (!list) return resolve([]);
      const classes: string[] = [];
      const observer = new MutationObserver(() => {
        if (list.classList.contains("room-content-out-next") && !classes.includes("out")) classes.push("out");
        if (list.classList.contains("room-content-in-next") && !classes.includes("in")) classes.push("in");
        if (classes.length === 2) { observer.disconnect(); resolve(classes); }
      });
      observer.observe(list, { attributes: true, attributeFilter: ["class"] });
      setTimeout(() => { observer.disconnect(); resolve(classes); }, 2000);
    }));
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+ArrowDown");
    expect(await seen).toEqual(["out", "in"]);
    await page.waitForFunction(() => !document.querySelector("#msgList")?.classList.contains("room-content-in-next"));
    expect(await page.locator("#msgList").evaluate((list: Element) => getComputedStyle(list).animationName)).toBe("none");

    // A direct browser copy of rendered text keeps mention chips as source tokens.
    await page.locator("#msgInput").fill("ping <at>@Shortcut tester</at> now");
    await page.locator("#btnSend").click();
    await page.locator("#msgList .msg-text").filter({ hasText: "ping @Shortcut tester now" }).waitFor();
    const copiedMention = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#msgList .msg-text")).find((node) => node.textContent?.includes("ping @Shortcut tester now"));
      if (!row) throw new Error("mention row not found");
      const range = document.createRange(); range.selectNodeContents(row);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer();
      document.querySelector("#msgList")!.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return { text: data.getData("text/plain"), html: data.getData("text/html") };
    });
    expect(copiedMention.text).toContain("<at>@Shortcut tester</at>");
    expect(copiedMention.html).toContain("data-chatroom-mentions");

    // In the composer, Alt+/ works, Escape closes, and '?' stays a draft character.
    // Alt+Home and Alt+End jump the thread from either end while typing, with no dialog.
    for (const index of [0, 1, 2, 3, 4]) {
      await page.locator("#msgInput").fill(`scroll probe ${index} ${"the thread needs height ".repeat(8)}`);
      await page.locator("#btnSend").click();
      await page.locator("#msgList .msg-text").filter({ hasText: `scroll probe ${index}` }).waitFor();
    }
    const maxScroll = () => page.locator("#thread").evaluate((node: HTMLElement) => node.scrollHeight - node.clientHeight);
    expect(await maxScroll()).toBeGreaterThan(200);
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Home");
    await page.waitForFunction(() => (document.querySelector("#thread")?.scrollTop ?? 1) < 2);
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.className.includes("thread-jump"))).toBe(false);
    expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    await page.keyboard.press("Alt+End");
    await page.waitForFunction(() => {
      const thread = document.querySelector("#thread")!;
      return Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) < 2;
    });
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.className.includes("thread-jump"))).toBe(false);
    expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    // Ctrl, Meta and Shift keep the browser's own Home/End meaning.
    for (const combo of ["Control+Home", "Meta+Home", "Alt+Shift+Home", "Control+Alt+Home", "Meta+Alt+Home"]) {
      await page.keyboard.press(combo);
      await page.waitForTimeout(80);
      expect(Math.abs((await maxScroll()) - await page.locator("#thread").evaluate((node: HTMLElement) => node.scrollTop))).toBeLessThan(2);
      expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    }

    await page.keyboard.type("draft");
    await page.keyboard.press("Alt+/");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.keyboard.type("?");
    expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    expect(await page.locator("#msgInput").textContent()).toBe("draft?");
    expect(await page.locator("#keyboardHints").count()).toBe(0);

    // Both locales describe the same sheet.
    await page.evaluate(async (modulePath: string) => { const { app } = await import(modulePath); app.setLocale("zh-CN"); }, "/assets/chat/state.js");
    await page.keyboard.press("Alt+/");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    expect(await page.locator("#shortcutsHeading").textContent()).toBe("键盘快捷键");
    expect(await page.locator("#shortcutsDialog").textContent()).toContain("发送消息");
    expect(await page.locator("#shortcutsDialog").textContent()).toContain("滚动消息");
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

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