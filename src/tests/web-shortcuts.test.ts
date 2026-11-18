/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-shortcuts-token";

test.skipIf(!browserModule)("tags are automatic, omit Alt, and stay off once disabled", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-shortcuts-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 360 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);

    // Tags are on with no interaction, and controls below the fold wait for their tag.
    await page.locator("#keyboardHints").waitFor({ state: "visible" });
    await page.locator("#joinView").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-hint-target="inName"]'));
    expect(await page.locator("#keyboardHints .keys-legend-text").textContent()).toContain("Tab reaches");
    expect(await page.locator('[data-hint-target="inName"]').count()).toBe(1);
    const below = page.locator('[data-hint-target="btnCreate"]');
    expect(await below.count()).toBe(1);
    expect(await below.evaluate((node: Element) => (node as HTMLElement).hidden)).toBe(true);
    await page.locator("#btnCreate").evaluate((node: Element) => node.scrollIntoView({ block: "center" }));
    await page.waitForFunction(() => {
      const badge = document.querySelector<HTMLElement>('[data-hint-target="btnCreate"]');
      return Boolean(badge && !badge.hidden);
    });
    expect(await below.isVisible()).toBe(true);
    expect(await page.locator("#keyboardHintMarks").textContent()).not.toContain("Alt");

    await page.setViewportSize({ width: 1280, height: 860 });
    await page.locator("#joinView").evaluate((node: Element) => { (node as HTMLElement).scrollTop = 0; });
    await page.waitForTimeout(120);

    // The trigger opens the full sheet; the sheet's toggle turns tags off and on.
    await page.locator("#btnKeysJoin").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    expect(await page.locator("#btnToggleHints").textContent()).toBe("Hide tags on controls");
    await page.locator("#btnToggleHints").click();
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    expect(await page.locator("#btnToggleHints").textContent()).toBe("Show tags on controls");
    await page.locator("#btnToggleHints").click();
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.locator("#keyboardHints").waitFor({ state: "visible" });
    await page.keyboard.press("?");
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });

    // Turning tags off survives a reload; the sheet can turn them back on.
    await page.locator("#btnCloseHints").click();
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    await page.reload();
    await page.locator("#joinView").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    expect(await page.locator("#keyboardHints").isVisible()).toBe(false);
    expect(await page.locator("#btnKeysJoin").isVisible()).toBe(true);
    await page.locator("#btnKeysJoin").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    expect(await page.locator("#btnToggleHints").textContent()).toBe("Show tags on controls");
    await page.locator("#btnToggleHints").click();
    await page.locator("#keyboardHints").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator("#shortcutsDialog").waitFor({ state: "hidden" });
    await page.locator("#keyboardHints").waitFor({ state: "visible" });
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(artifacts, "hints-default-join.png") });

    // Tags never sit on label text, starting with the approval switch.
    expect(await coveredBy(page, "label[for='inApprovalRequired']")).toEqual([]);
    expect(await textCoverage(page)).toEqual([]);

    // Real tags stay short; generic tags say how to reach and use the control.
    await page.locator("#inName").fill("Shortcut tester");
    await page.locator("#inRoomName").fill("__Test_Shortcuts");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForTimeout(350);
    await page.waitForFunction(() => document.querySelector('[data-hint-target="msgInput"]'));
    const editorHint = page.locator('[data-hint-target="msgInput"]');
    expect(await editorHint.textContent()).toBe("Enter");
    expect(await editorHint.evaluate((node: Element) => node.className)).toContain("is-real");
    const membersHint = page.locator('[data-hint-target="btnMembers"]');
    expect(await membersHint.textContent()).toContain("Tab");
    expect(await membersHint.textContent()).toContain("↵");
    expect(await membersHint.evaluate((node: Element) => node.className)).not.toContain("is-real");
    expect(await coveredBy(page, "#roomName")).toEqual([]);
    expect(await coveredBy(page, "label[for='inApprovalRequiredChat']")).toEqual([]);
    await page.waitForTimeout(150);
    expect(await textCoverage(page)).toEqual([]);
    await page.screenshot({ path: path.join(artifacts, "hints-default-chat.png") });

    // Typing '?' stays text and does not open the sheet.
    await page.locator("#msgInput").click();
    await page.keyboard.type("?");
    expect(await page.locator("#shortcutsDialog").isVisible()).toBe(false);
    expect(await page.locator("#keyboardHints").isVisible()).toBe(true);
    expect(await page.locator("#msgInput").evaluate((node: HTMLElement) => node.textContent)).toContain("?");
    await page.locator("#msgInput").evaluate((node: HTMLElement) => {
      node.textContent = "";
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    // Escape still closes the panel underneath, not the tag layer.
    await page.locator("#btnMembers").click();
    await page.locator("#memberPanel").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#memberPanel").waitFor({ state: "hidden" });
    expect(await page.locator("#keyboardHints").isVisible()).toBe(true);

    // A second room makes the real room-switch tag available; Alt is not drawn.
    await page.locator("#btnNewRoom").click();
    await page.locator("#inRoomNameChat").fill("__Test_Shortcuts_Two");
    await page.locator("#btnCreateChatRoom").click();
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent?.includes("Two"));
    expect(await page.locator("#railKeyHint").isVisible()).toBe(true);
    const railHint = await page.locator("#railKeyHint").textContent();
    expect(railHint).not.toContain("Alt");
    expect(railHint).toContain("↑");
    expect(railHint).toContain("↓");
    const marks = await page.locator("#keyboardHintMarks").textContent();
    expect(marks).not.toContain("Alt");
    expect(marks).toContain("↑");
    expect(marks).toContain("↓");
    expect(await page.locator("#keyboardHints .keys-legend-text").textContent()).not.toContain("Alt");

    // Phones keep the keycap trigger and skip Alt-only tags, but tags still show.
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(150);
    expect(await page.locator("#keyboardHints").isVisible()).toBe(true);
    expect(await page.locator("#btnKeysChat .keys-label").evaluate((node: Element) => getComputedStyle(node).display)).toBe("none");
    await page.locator("#btnRoomsDrawer").click();
    await page.waitForFunction(() => document.querySelector("#roomRail")?.classList.contains("drawer-open"));
    await page.waitForFunction(() => document.querySelector('[data-hint-target="btnRefreshRooms"]'));
    expect(await page.locator('[data-hint-target="btnRefreshRooms"]').isVisible()).toBe(true);
    expect(await page.locator(".keys-legend").isVisible()).toBe(false);
    await page.waitForFunction(() => {
      const badge = document.querySelector<HTMLElement>('[data-hint-target="btnMembers"]');
      return !badge || badge.hidden;
    });
    expect(await page.evaluate(() => {
      const rail = document.querySelector("#roomRail");
      return Array.from(document.querySelectorAll<HTMLElement>("#keyboardHintMarks .keys-badge"))
        .filter((badge) => !badge.hidden && badge.getClientRects().length)
        .filter((badge) => {
          const target = badge.dataset.hintTarget ? document.getElementById(badge.dataset.hintTarget) : null;
          return Boolean(target && rail && !rail.contains(target));
        })
        .map((badge) => badge.dataset.hintTarget);
    })).toEqual([]);
    expect(await page.locator("#keyboardHintMarks").textContent()).not.toContain("Alt");
    await page.screenshot({ path: path.join(artifacts, "hints-default-mobile.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(artifacts, "hints-default-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#roomRail")?.classList.contains("drawer-open"));
    await page.waitForTimeout(200);
    expect(await page.locator("#keyboardHints").isVisible()).toBe(true);
    expect(await page.locator(".keys-legend").isVisible()).toBe(true);
    const legend = await page.locator(".keys-legend").boundingBox();
    const composer = await page.locator("#chatView .composer").boundingBox();
    expect(legend!.x).toBeGreaterThanOrEqual(0);
    expect(legend!.x + legend!.width).toBeLessThanOrEqual(390);
    expect(legend!.y + legend!.height).toBeLessThanOrEqual(composer!.y);
    expect(await textCoverage(page)).toEqual([]);

    // Both locales stay in sync; no page errors.
    await page.evaluate(async (modulePath: string) => { const { app } = await import(modulePath); app.setLocale("zh-CN"); }, "/assets/chat/state.js");
    expect(await page.locator("#btnKeysChat").getAttribute("aria-label")).toBe("键盘提示");
    expect(await page.locator("#keyboardHints .keys-legend-text").textContent()).toContain("Tab 定位");
    expect(await page.locator("#keyboardHints .keys-legend-text").textContent()).not.toContain("Alt");
    await page.locator("#btnKeysChat").click();
    await page.locator("#shortcutsDialog").waitFor({ state: "visible" });
    expect(await page.locator("#shortcutsHeading").textContent()).toBe("键盘快捷键");
    expect(await page.locator("#shortcutsDialog").textContent()).toContain("发送消息");
    expect(await page.locator("#btnToggleHints").textContent()).toBe("隐藏控件提示");
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

function coveredBy(page: any, selector: string) {
  return page.evaluate((target: string) => {
    const node = document.querySelector(target);
    if (!node) return [`missing ${target}`];
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>("#keyboardHintMarks .keys-badge"))
      .filter((badge) => !badge.hidden && badge.getClientRects().length)
      .filter((badge) => {
        const box = badge.getBoundingClientRect();
        return box.left < text.right && box.right > text.left && box.top < text.bottom && box.bottom > text.top;
      })
      .map((badge) => badge.textContent ?? "");
  }, selector);
}

function textCoverage(page: any) {
  return page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll<HTMLElement>("#keyboardHintMarks .keys-badge"))
      .filter((badge) => !badge.hidden && badge.getClientRects().length)
      .map((badge) => ({ text: badge.textContent ?? "", rect: badge.getBoundingClientRect() }));
    const skip = new Set(["SCRIPT", "STYLE", "SVG", "TEXTAREA", "SELECT"]);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || skip.has(parent.tagName) || parent.closest("#keyboardHints")) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility({ checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const hits: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const text of Array.from(range.getClientRects())) {
        if (text.width < 1 || text.height < 1) continue;
        for (const badge of badges) {
          const box = badge.rect;
          if (box.left < text.right && box.right > text.left && box.top < text.bottom && box.bottom > text.top) {
            hits.push(`${badge.text} over "${node.nodeValue?.trim().slice(0, 24)}"`);
          }
        }
      }
    }
    return hits;
  });
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