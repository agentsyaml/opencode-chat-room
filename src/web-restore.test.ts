/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Request as BrowserRequest, Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
test.skipIf(!browserModule)("restore blocks login, retries transient errors, and prompts login on 401", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-restore-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } }), owner = await context.newPage();
    await owner.goto(`${origin}/chat`); await owner.locator("#joinView").waitFor({ state: "visible" });
    await owner.locator("#inToken").fill("ui-test-token"); await owner.locator('[data-token-save="inToken"]').click();
    await owner.locator("#inName").fill("Restorer"); await owner.locator("#inRoomName").fill("__Test_Restore_room"); await owner.locator("#btnCreate").click();
    await owner.locator("#chatView").waitFor({ state: "visible" });
    const roomId = (await owner.evaluate(() => sessionStorage.getItem("chat.roomId")))!;
    const initialMessages = await owner.locator("#msgList [data-msg-id]").count();
    for (let index = 0; index < 20; index++) {
      await owner.locator("#msgInput").fill(`Restore anchor message ${index} ${"content ".repeat(16)}`); await owner.locator("#btnSend").click();
      await owner.waitForFunction((count: number) => document.querySelectorAll("#msgList [data-msg-id]").length >= count, initialMessages + index + 1);
    }
    await owner.locator("#msgList [data-msg-id]").nth(2).waitFor();
    await owner.evaluate(async ({ roomId, url }: { roomId: string; url: string }) => {
      const { app } = await import(url);
      app.saveDraft(roomId, "Draft retained through retry");
      const thread = document.querySelector("#thread")!; thread.scrollTop = 0;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); app.captureReadingPosition();
    }, { roomId, url: "/assets/chat/state.js" });
    const savedPosition = await owner.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.positions")!)[id], roomId);
    let release!: () => void, requested!: () => void, retryRequested!: () => void, attempt = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; }), firstRequest = new Promise<void>((resolve) => { requested = resolve; }), secondRequest = new Promise<void>((resolve) => { retryRequested = resolve; });
    await owner.route("**/rooms?sessionID=*", async (route: BrowserRoute) => {
      if (!attempt++) { requested(); await route.fulfill({ status: 503, body: "Temporary failure" }); }
      else { retryRequested(); await gate; await route.continue(); }
    });
    // Exercise the no-cache restore-failure UI: empty the local history snapshot
    // so a failing room list shows the blocking restore error instead of the cache.
    await owner.evaluate(() => new Promise<void>((resolve) => {
      const request = indexedDB.open("chat-room-history", 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("rooms", "readwrite");
        tx.objectStore("rooms").clear();
        tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
      };
      request.onerror = () => resolve();
    }));
    const reload = owner.reload(); await firstRequest;
    expect(await owner.locator("#joinView").isVisible()).toBe(false);
    expect(await owner.locator("#btnJoin").isVisible()).toBe(false);
    expect(await owner.locator("#restoreError").isVisible()).toBe(true);
    expect(JSON.parse((await owner.evaluate(() => sessionStorage.getItem("chat.drafts")))!)[roomId!]).toBe("Draft retained through retry");
    expect(JSON.parse((await owner.evaluate(() => sessionStorage.getItem("chat.positions")))!)[roomId!]).toEqual(savedPosition);
    await owner.locator("#btnRestoreRetry").click(); await secondRequest; release(); await reload;
    await owner.locator("#chatView").waitFor({ state: "visible" });
    expect(await owner.locator("#msgInput").evaluate((node: any) => node.value)).toBe("Draft retained through retry");
      await owner.waitForFunction((position: { messageId: string; offset: number }) => {
        const thread = document.querySelector("#thread")!, row = Array.from(document.querySelectorAll<HTMLElement>("#msgList [data-msg-id]")).find((item) => item.dataset.msgId === position.messageId);
      return row && Math.abs(row.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop + position.offset)) < 2;
    }, savedPosition);
    await owner.unroute("**/rooms?sessionID=*");
    const widths = [320, 375, 390, 768, 1440], anchorOffsets = new Map<string, number>();
    const appearances = [["en", "light"], ["zh-CN", "light"], ["en", "dark"], ["zh-CN", "dark"], ["en", "light"]];
    for (const [round, [locale, scheme]] of appearances.entries()) for (const width of widths) {
      await owner.setViewportSize({ width, height: 850 });
      await owner.evaluate(async ({ locale, url }: { locale: string; url: string }) => (await import(url)).app.setLocale(locale), { locale, url: "/assets/chat/state.js" });
      await owner.emulateMedia({ colorScheme: scheme }); await owner.waitForTimeout(60);
      const geometry = await owner.evaluate((position: { messageId: string; offset: number }) => {
        const thread = document.querySelector<HTMLElement>("#thread")!, row = Array.from(document.querySelectorAll<HTMLElement>("#msgList [data-msg-id]")).find((item) => item.dataset.msgId === position.messageId);
        const buttons = Array.from(document.querySelectorAll<HTMLElement>(".chat-head .chip")).filter((button) => button.getClientRects().length);
        return { pageX: document.documentElement.scrollWidth - innerWidth, threadX: thread.scrollWidth - thread.clientWidth, anchorOffset: row!.getBoundingClientRect().top - (thread.getBoundingClientRect().top + thread.clientTop), buttons: buttons.map((button) => { const style = getComputedStyle(button); return { width: button.offsetWidth, height: button.offsetHeight, display: style.display, align: style.alignItems, justify: style.justifyItems }; }) };
      }, savedPosition);
      expect(geometry.pageX).toBeLessThanOrEqual(1); expect(geometry.threadX).toBeLessThanOrEqual(1);
      const key = `${width}-${locale}-${scheme}`, prior = anchorOffsets.get(key);
      if (prior === undefined) anchorOffsets.set(key, geometry.anchorOffset); else expect(Math.abs(geometry.anchorOffset - prior)).toBeLessThan(2);
      if (width <= 760) for (const button of geometry.buttons) { expect(button.display).toBe("grid"); expect(button.width).toBe(button.height); expect(button.align).toBe("center"); expect(button.justify).toBe("center"); }
      if (width <= 760) await owner.locator("#btnRoomsDrawer").click();
      const profile = await owner.evaluate(() => {
        const trigger = document.querySelector<HTMLElement>("#btnSettings")!, avatar = document.querySelector<HTMLElement>("#profileAvatar")!, name = document.querySelector<HTMLElement>("#railIdentity")!, caret = document.querySelector<HTMLElement>(".user-menu-caret")!;
        const center = (node: HTMLElement) => node.getBoundingClientRect().top + node.offsetHeight / 2;
        const style = getComputedStyle(avatar);
        return { centered: Math.abs(center(trigger) - center(avatar)) < 1 && Math.abs(center(trigger) - center(name)) < 1 && Math.abs(center(trigger) - center(caret)) < 1, frameSquare: avatar.offsetWidth === avatar.offsetHeight, display: style.display, align: style.alignItems, justify: style.justifyItems };
      });
      expect(profile.centered).toBe(true); expect(profile.frameSquare).toBe(true); expect(profile.display).toBe("grid"); expect(profile.align).toBe("center"); expect(profile.justify).toBe("center");
      if (width <= 760) {
        await owner.locator("#btnSettings").click(); expect(await owner.locator("#localeSelectSettings").isVisible()).toBe(true); expect(await owner.locator(".chat-head .locale-select").count()).toBe(0);
        await owner.locator("#btnSettings").click(); await owner.keyboard.press("Escape");
      }
      if (process.env.CHAT_UI_SCREENSHOT_DIR && round < 4) await owner.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, `restore-${width}-${locale}-${scheme}.png`), fullPage: true });
    }
    const fresh = await context.newPage(); let releaseFresh!: () => void, freshRequested!: () => void, initialHtml = "";
    const freshGate = new Promise<void>((resolve) => { releaseFresh = resolve; }), freshSeen = new Promise<void>((resolve) => { freshRequested = resolve; });
    await fresh.route("**/chat", async (route: BrowserRoute) => { const response = await route.fetch(); initialHtml = await response.text(); await route.fulfill({ response, body: initialHtml }); });
    await fresh.route("**/rooms?sessionID=*", async (route: BrowserRoute) => { freshRequested(); await freshGate; await route.continue(); });
    let joins = 0; fresh.on("request", (request: BrowserRequest) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/join")) joins++; });
    const freshLoad = fresh.goto(`${origin}/chat`); await freshSeen;
    expect(initialHtml).toContain('<html lang="en" class="session-restore">');
    expect(await fresh.locator("#joinView").isVisible()).toBe(false);
    expect(await fresh.evaluate(() => localStorage.getItem("chat.browserIdentity"))).not.toBeNull();
    expect(await fresh.evaluate(() => [sessionStorage.getItem("chat.roomId"), sessionStorage.getItem("chat.joinedRoomIds")])).toEqual([null, null]);
    releaseFresh(); await freshLoad; await fresh.locator("#chatView").waitFor({ state: "visible" });
    expect(await fresh.evaluate(() => sessionStorage.getItem("chat.roomId"))).toBe(roomId);
    expect(joins).toBe(0); await fresh.unroute("**/rooms?sessionID=*");
    let releaseUnauthorized!: () => void, unauthorizedRequested!: () => void;
    const unauthorizedGate = new Promise<void>((resolve) => { releaseUnauthorized = resolve; }), unauthorizedSeen = new Promise<void>((resolve) => { unauthorizedRequested = resolve; });
    await fresh.route("**/rooms?sessionID=*", async (route: BrowserRoute) => { unauthorizedRequested(); await unauthorizedGate; await route.fulfill({ status: 401, body: JSON.stringify({ error: "access token expired" }) }); });
    // Empty the snapshot so the 401 prompts login instead of showing the cache.
    await fresh.evaluate(() => new Promise<void>((resolve) => {
      const request = indexedDB.open("chat-room-history", 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("rooms", "readwrite");
        tx.objectStore("rooms").clear();
        tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
      };
      request.onerror = () => resolve();
    }));
    const unauthorizedReload = fresh.reload(); await unauthorizedSeen;
    expect(await fresh.locator("#joinView").isVisible()).toBe(false); releaseUnauthorized(); await unauthorizedReload;
    await fresh.locator("#joinView").waitFor({ state: "visible" });
    expect(await fresh.locator("#tokenBox").evaluate((box: HTMLDetailsElement) => box.open)).toBe(true);
    expect(await fresh.locator("#joinError").textContent()).toContain("access token");
    await fresh.close();
    await context.close();
  } finally { await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function isolatedEnv(stateDir: string, port: number) {
  return { ...process.env, CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: "ui-test-token", HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state") };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local test server did not start");
}
