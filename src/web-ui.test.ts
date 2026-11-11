/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/assets/chat/state.js";
// The browser suite uses a temporary Playwright install passed through CHAT_UI_BROWSER_MODULE.
export const GFM_FIXTURE = [
  "| Topic | Status |", "| :-- | --: |", "| Markdown | ~~rough~~ polished |", "",
  "- [x] table", "- [ ] safety", "  - nested list", "",
  "> A useful quote with **emphasis** and an autolink: https://example.test/docs", "",
  "```js", 'const safe = "<script>not executable</script>";', 'const fake = "<at>@all</at>";', "```", "",
  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/K6kAAAAASUVORK5CYII=" onerror="window.__chatXss = true">',
  "<script>window.__chatXss = true</script>", "[unsafe](javascript:window.__chatXss=true)",
  "[encoded](%6aavascript:window.__chatXss=true)", "[entity](java&#x73;cript:window.__chatXss=true)", "<at>@all</at>",
].join("\n");

test("browser auth helper retains a token when storage is unavailable", async () => {
  const headers: string[] = [];
  const auth = createAuth({ getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem() {} } as unknown as Storage,
    (async (_input, init) => {
      headers.push(new Headers(init?.headers).get("Authorization") || "");
      return Response.json({ ok: true });
    }) as typeof fetch,
    (key: string) => key);
  expect(auth.saveToken(" secret ")).toBe("secret");
  await auth.api("/rooms");
  expect(headers).toEqual(["Bearer secret"]);
});
test("tab identity remains stable when session storage is blocked", () => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem() {} } as unknown as Storage;
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const auth = createAuth(storage, fetch, undefined, blocked as unknown as Storage);
  expect(auth.LS.sessionID).toMatch(/^[0-9a-f-]{36}$/);
  expect(auth.LS.sessionID).toBe(auth.LS.sessionID);
});
test("session fallback reuses one identity after a storage write failure", () => {
  let getCount = 0;
  const flaky = {
    getItem: () => { if (getCount++) throw new Error("temporarily blocked"); return null; },
    setItem: () => { throw new Error("read-only"); },
    removeItem() {},
  } as unknown as Storage;
  const auth = createAuth(undefined, undefined, undefined, flaky);
  const first = auth.LS.sessionID;
  expect(auth.LS.sessionID).toBe(first);
});
const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
test.skipIf(!browserModule)("local browser covers room, GFM, and moderation flows", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-ui-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await import("node:fs/promises").then(({ mkdir }) => mkdir(screenshotDir, { recursive: true }));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(),
    env: isolatedServerEnv(stateDir, port),
    stdio: "ignore",
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const alice = await context.newPage();
    const pageErrors: string[] = [], httpErrors: string[] = [], unauthorized: string[] = [], roomJoins: string[] = [], roomLeaves: string[] = [];
    const aliceRoomReads: string[] = [], bobRoomReads: string[] = [];
    watchPage(alice, pageErrors, unauthorized, httpErrors);
    watchMembershipRequests(alice, roomJoins, roomLeaves, aliceRoomReads);
    await alice.goto(`${origin}/chat`);
    expect(await alice.title()).toBe("OC Chat");
    expect(await alice.evaluate(() => [Boolean((window as any).marked), Boolean((window as any).DOMPurify)])).toEqual([true, true]);
    await alice.locator("#tokenBox[open]").waitFor();
    await alice.locator("#inName").fill("Alice");
    await alice.locator("#inRoomName").fill("Design room");
    await alice.locator("#btnCreate").click();
    await alice.locator("#joinError").waitFor({ state: "visible" });
    await alice.locator("#inToken").fill("ui-test-token");
    await alice.locator('[data-token-save="inToken"]').click();
    await alice.locator("#chatView").waitFor({ state: "visible" });
    expect(await alice.title()).toBe("Design room · OC Chat");
    expect(await alice.locator(".rail-brand").textContent()).toContain("OC Chat");
    expect(unauthorized.length).toBe(2);
    await alice.locator("#btnSettings").click();
    await alice.locator("#inTokenChat").fill("ui-test-token");
    await alice.locator("#inTokenChat").press("Enter");
    await alice.waitForFunction(() => document.querySelector('[data-token-save="inTokenChat"]')?.textContent === "Saved");
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    const zhDesktopGeometry = await localeGeometry(alice);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-desktop-zh.png"), fullPage: true });
    expect(await alice.title()).toBe("Design room · OC Chat");
    expect(await alice.locator("#btnDeleteRoom").textContent()).toBe("删除房间");
    expect(await alice.locator('[data-i18n="privacyNote"]').textContent()).toContain("持有共享令牌的人都可以读取私聊内容");
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    const enDesktopGeometry = await localeGeometry(alice);
    expectLocaleGeometry(enDesktopGeometry, zhDesktopGeometry);
    expect(await alice.locator('[data-i18n="privacyNote"]').textContent()).toContain("read direct messages");
    const sourceRoom = await currentRoomId(alice);
    const bobContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const bob = await bobContext.newPage();
    await bob.addInitScript(() => localStorage.setItem("chat.token", "ui-test-token"));
    watchPage(bob, pageErrors, unauthorized, httpErrors);
    watchMembershipRequests(bob, roomJoins, roomLeaves, bobRoomReads);
    await bob.goto(`${origin}/chat`);
    await bob.locator("#inName").fill("Bob");
    await bob.locator("#inRoomName").fill("Second room");
    await bob.locator("#btnCreate").click();
    await bob.locator("#chatView").waitFor({ state: "visible" });
    const secondRoom = await currentRoomId(bob);
    await alice.locator("#msgInput").fill("Draft for the first room");
    await alice.locator("#btnRefreshRooms").click();
    await alice.locator(`#roomListChat [data-room-id="${secondRoom}"]`).waitFor();
    await alice.locator(`#roomListChat [data-room-id="${secondRoom}"]`).click();
    await alice.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Second room");
    expect(roomJoins).toEqual([secondRoom]);
    const joinsBeforeSwitchBack = roomJoins.length;
    await alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await alice.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    expect(roomJoins.length).toBe(joinsBeforeSwitchBack);
    expect(await alice.locator("#msgInput").evaluate((node: any) => node.value)).toBe("Draft for the first room");
    let releaseRestore!: () => void, restoreRequested!: () => void, retryRequested!: () => void, attempts = 0;
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; }), restoreSeen = new Promise<void>((resolve) => { restoreRequested = resolve; }), retrySeen = new Promise<void>((resolve) => { retryRequested = resolve; });
    await alice.route("**/rooms?sessionID=*", async (route: BrowserRoute) => {
      if (!attempts++) { restoreRequested(); await route.fulfill({ status: 503, body: "Temporarily unavailable" }); }
      else { retryRequested(); await restoreGate; await route.continue(); }
    });
    const reload = alice.reload(); await restoreSeen;
    expect(await alice.locator("#joinView").isVisible()).toBe(false);
    expect(await alice.locator("#btnJoin").isVisible()).toBe(false);
    await alice.locator("#btnRestoreRetry").waitFor({ state: "visible" });
    expect(await alice.evaluate(() => sessionStorage.getItem("chat.roomId"))).toBe(sourceRoom);
    await alice.locator("#btnRestoreRetry").click(); await retrySeen;
    releaseRestore(); await reload;
    await alice.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom); await alice.unroute("**/rooms?sessionID=*");
    httpErrors.splice(0, httpErrors.length, ...httpErrors.filter((error) => !error.startsWith("503 GET") || !error.includes("/rooms?sessionID=")));
    pageErrors.splice(0, pageErrors.length, ...pageErrors.filter((error) => !error.includes("status of 503")));
    expect(await alice.locator("#msgInput").evaluate((node: any) => node.value)).toBe("Draft for the first room");
    expect(await alice.locator("#roomListChat .room-row.joined").count()).toBe(2);
    await alice.locator(`#roomListChat [data-room-id="${secondRoom}"]`).click();
    await bob.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await bob.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    expect(roomJoins.filter((id) => id === sourceRoom).length).toBe(1);
    const backgroundText = Array.from({ length: 24 }, () => "A background update").join("\n");
    await bob.locator("#msgInput").fill(backgroundText);
    await bob.locator("#btnSend").click();
    const sourceReadsBeforeOpen = aliceRoomReads.filter((id) => id === sourceRoom).length;
    const sourceCard = alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`);
    await sourceCard.locator(".r-badge").waitFor({ timeout: 12000 });
    expect(await sourceCard.locator(".r-preview").textContent()).toContain("A background update");
    expect(await sourceCard.locator(".r-meta").textContent()).toBe("2 members · 2 messages");
    expect(aliceRoomReads.filter((id) => id === sourceRoom).length).toBe(sourceReadsBeforeOpen);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-desktop-unread.png"), fullPage: true });
    await sourceCard.click();
    await alice.locator(".msg-text").getByText("A background update").waitFor();
    await alice.locator("#thread").evaluate((thread: HTMLElement) => { thread.scrollTop = 0; });
    await alice.locator("#btnJump").waitFor({ state: "visible" });
    await alice.locator("#btnJump").click();
    await sourceCard.locator(".r-badge").waitFor({ state: "detached", timeout: 5000 });
    expect(aliceRoomReads.filter((id) => id === sourceRoom).length).toBeGreaterThan(sourceReadsBeforeOpen);
    await alice.locator("#msgInput").fill("@所有人");
    await alice.locator('#mentionPicker [data-name="all"]').click();
    expect(await alice.locator("#msgInput").evaluate((node: any) => node.value)).toBe("<at>@all</at>");
    // IME composition needs a text-node caret; an element boundary next to the
    // non-editable chip drops the first typed letter.
    expect(await alice.locator("#msgInput").evaluate((node: HTMLElement) => {
      const anchor = getSelection()?.anchorNode;
      return { inside: Boolean(anchor && node.contains(anchor)), text: anchor?.nodeType === Node.TEXT_NODE };
    })).toEqual({ inside: true, text: true });
    await alice.locator("#msgInput").fill(GFM_FIXTURE);
    const filledGfm = await alice.locator("#msgInput").evaluate((node: any) => ({ value: node.value, html: node.innerHTML }));
    if (filledGfm.value !== GFM_FIXTURE) throw new Error(JSON.stringify(filledGfm));
    expect(await alice.locator("#btnSend").isDisabled()).toBe(false);
    await alice.locator("#btnSend").click();
    await alice.waitForTimeout(500);
    if (await alice.locator("#sendError").isVisible()) throw new Error(await alice.locator("#sendError").textContent() || "Send failed");
    const message = alice.locator(".msg-text").last();
    await message.locator("table").waitFor({ timeout: 3000 });
    expect(await message.locator("del").count()).toBe(1);
    expect(await message.locator('input[type="checkbox"]').count()).toBe(2);
    expect(await message.locator('input[type="checkbox"]:disabled').count()).toBe(2);
    expect(await message.locator("ul ul").count()).toBe(1);
    expect(await message.locator("a[href^='https://']").count()).toBe(1);
    expect(await message.locator(".mention-chip").textContent()).toBe("@all");
    expect(await message.locator("pre .mention-chip").count()).toBe(0);
    expect(await message.locator("script, [onerror], a[href^='javascript:']").count()).toBe(0);
    expect(await alice.evaluate(() => (window as any).__chatXss ?? false)).toBe(false);
    expect(await message.locator("[data-copy-code]").count()).toBe(0);
    expect(await message.locator("pre code").textContent()).toContain('const fake = "<at>@all</at>";');
    const copyButton = alice.locator(".msg").last().locator("[data-copy-message]");
    await copyButton.click();
    expect(await alice.evaluate(() => navigator.clipboard.readText())).toContain('const fake = "<at>@all</at>";');
    await alice.locator("#thread").evaluate((thread: HTMLElement) => { thread.scrollTop = 0; });
    await alice.locator(`#roomListChat [data-room-id="${secondRoom}"]`).click();
    await alice.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Second room");
    await alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await alice.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    expect(await alice.locator("#thread").evaluate((thread: HTMLElement) => thread.scrollTop)).toBe(0);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-desktop-light.png"), fullPage: true });
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    await alice.waitForTimeout(250);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-desktop-zh.png"), fullPage: true });
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await alice.evaluate(() => { document.body.dataset.lightBg = getComputedStyle(document.body).backgroundColor; document.body.dataset.lightSelection = getComputedStyle(document.querySelector("#roomListChat .selected")!).backgroundImage; });
    await alice.emulateMedia({ colorScheme: "dark" });
    await alice.waitForFunction(() => getComputedStyle(document.body).backgroundColor !== document.body.dataset.lightBg);
    await alice.waitForFunction(() => getComputedStyle(document.querySelector("#roomListChat .selected")!).backgroundImage !== document.body.dataset.lightSelection);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-desktop-dark.png"), fullPage: true });
    await alice.emulateMedia({ colorScheme: "light" });
    await alice.waitForFunction(() => !matchMedia("(prefers-color-scheme: dark)").matches);
    await alice.waitForFunction(() => { const button = document.querySelector<HTMLElement>("#btnMembers")!, sample = document.createElement("div"); sample.style.backgroundColor = "var(--surface)"; document.body.append(sample); const surface = getComputedStyle(sample).backgroundColor; sample.remove(); return getComputedStyle(button).backgroundColor === surface; });
    await alice.setViewportSize({ width: 768, height: 900 }); const tabletHeader = await alice.evaluate(() => { const actions = document.querySelector<HTMLElement>(".chat-head-actions")!, options = document.querySelector<HTMLElement>("#btnRoomOptions")!; return { rail: getComputedStyle(document.querySelector(".room-rail")!).display, drawerTrigger: getComputedStyle(document.querySelector("#btnRoomsDrawer")!).display, header: actions.getBoundingClientRect().top, options: options.getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }; });
    expect(tabletHeader.rail).toBe("flex"); expect(tabletHeader.drawerTrigger).toBe("none"); expect(tabletHeader.options).toBe(tabletHeader.header); expect(tabletHeader.overflow).toBe(false); await alice.screenshot({ path: path.join(screenshotDir, "chat-tablet-768.png"), fullPage: true });
    await alice.setViewportSize({ width: 375, height: 812 }); expect(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); const enMobileGeometry = await localeGeometry(alice);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-mobile.png"), fullPage: true });
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    const zhMobileGeometry = await localeGeometry(alice);
    expectLocaleGeometry(enMobileGeometry, zhMobileGeometry);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-mobile-zh.png"), fullPage: true });
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await alice.locator("#btnRoomsDrawer").click();
    await alice.locator("#btnSettings").click();
    expect(await alice.locator("#localeSelectSettings").isVisible()).toBe(true);
    expect(await alice.locator(".chat-head .locale-select").count()).toBe(0);
    await alice.waitForTimeout(200);
    await alice.screenshot({ path: path.join(screenshotDir, "chat-user-settings-mobile.png"), fullPage: true });
    const enMobileSettings = await alice.locator("#chatSettings").evaluate((node: HTMLElement) => ({ height: node.getBoundingClientRect().height, scroll: node.scrollHeight - node.clientHeight, width: node.scrollWidth - node.clientWidth }));
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    const zhMobileSettings = await alice.locator("#chatSettings").evaluate((node: HTMLElement) => ({ height: node.getBoundingClientRect().height, scroll: node.scrollHeight - node.clientHeight, width: node.scrollWidth - node.clientWidth }));
    expect(Math.abs(enMobileSettings.height - zhMobileSettings.height)).toBeLessThanOrEqual(1);
    expect(zhMobileSettings.width).toBeLessThanOrEqual(1);
    expect(zhMobileSettings.scroll).toBeLessThanOrEqual(1);
    expect(await alice.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
    await alice.keyboard.press("Escape");
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    // Smaller CSS viewports approximate zoom reflow; they are not native zoom or DPI validation.
    for (const [width, height] of [[300, 650], [250, 541], [188, 406]]) {
      await alice.setViewportSize({ width, height });
      const geometry = await localeGeometry(alice);
      expect(geometry.pageX).toBeLessThanOrEqual(1);
      expect(geometry.pageY).toBeLessThanOrEqual(1);
      if (geometry.headX > 1) throw new Error(`header overflow at ${width}px: ${JSON.stringify(geometry.headParts)}`);
      await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
      expectLocaleGeometry(geometry, await localeGeometry(alice));
      await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    }
    await alice.setViewportSize({ width: 375, height: 812 });
    const mobileInput = alice.locator("#msgInput");
    await mobileInput.fill("x".repeat(2005));
    expect(await mobileInput.evaluate((node: any) => node.value.length)).toBe(2005);
    expect(await alice.locator("#btnSend").isDisabled()).toBe(true);
    expect(await alice.locator("#draftCount").getAttribute("class")).toContain("over-limit");
    await mobileInput.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const composerGeometry = await mobileInput.evaluate((input: HTMLElement) => ({
      height: input.getBoundingClientRect().height,
      bottom: input.getBoundingClientRect().bottom,
      viewport: window.innerHeight,
    }));
    expect(composerGeometry.height).toBeGreaterThan(70);
    expect(composerGeometry.bottom).toBeLessThanOrEqual(composerGeometry.viewport);
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.locator("#btnNewRoom").click();
    await alice.locator("#inRoomNameChat").fill("Scratch room");
    await alice.locator("#btnCreateChatRoom").click();
    await alice.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Scratch room");
    const scratchRoom = await currentRoomId(alice);
    expect(await alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).count()).toBe(1);
    await alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await alice.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await bob.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await bob.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await bob.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Design room");
    await alice.locator("#btnMembers").click();
    await alice.locator("#memberList").getByText("Bob").waitFor();
    const enMembersHeight = await alice.locator("#memberPanel").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    const zhMembersHeight = await alice.locator("#memberPanel").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    expect(Math.abs(enMembersHeight - zhMembersHeight)).toBeLessThanOrEqual(1);
    expect(await alice.locator("#memberPanel").evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await alice.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await alice.getByRole("button", { name: "Message privately" }).click();
    await alice.waitForFunction((id: string) => !(document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await alice.locator("#msgInput").fill("Direct hello from Alice");
    await alice.locator("#btnSend").click();
    await alice.locator(".msg-name").filter({ hasText: "You" }).last().waitFor();
    await bob.locator("#btnRefreshRooms").click();
    const directRoom = await bob.locator("#roomListChat .room-row").filter({ has: bob.locator(".r-kind", { hasText: "Direct" }) }).first();
    await directRoom.waitFor();
    await directRoom.click();
    await bob.locator(".msg-name").filter({ hasText: "Alice" }).last().waitFor();
    const directRoomId = await currentRoomId(bob);
    await alice.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await alice.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await bob.locator(`#roomListChat [data-room-id="${sourceRoom}"]`).click();
    await bob.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await bob.locator("#btnMembers").click();
    await bob.locator("#memberList").getByRole("button", { name: "Remove" }).waitFor();
    const joinsBeforeKick = roomJoins.length;
    bob.once("dialog", (dialog: { accept(): Promise<void> }) => void dialog.accept());
    await bob.locator("#memberList li").filter({ hasText: "Alice" }).getByRole("button", { name: "Remove" }).click();
    await alice.waitForFunction((id: string) => !(document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom, { timeout: 30000 });
    const aliceFallbackRoom = await currentRoomId(alice);
    expect(aliceFallbackRoom).toBe(secondRoom);
    expect(await alice.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]"))).not.toContain(sourceRoom);
    expect(await alice.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]"))).toContain(scratchRoom);
    expect(await alice.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]"))).toContain(directRoomId);
    expect(roomJoins.length).toBe(joinsBeforeKick);
    await alice.waitForTimeout(500);
    expect(await alice.locator("#chatView").isVisible()).toBe(true);

    await bob.locator(`#roomListChat [data-room-id="${secondRoom}"]`).click();
    await bob.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "Second room");
    await bob.locator("#btnRoomOptions").click();
    await bob.locator("#roomOptions").waitFor({ state: "visible" });
    await bob.waitForTimeout(200);
    await bob.screenshot({ path: path.join(screenshotDir, "chat-room-options-desktop.png"), fullPage: true });
    bob.once("dialog", (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss());
    await bob.locator("#btnDeleteRoom").click();
    expect(await currentRoomId(bob)).toBe(secondRoom);
    bob.once("dialog", (dialog: { accept(): Promise<void> }) => void dialog.accept());
    await bob.locator("#btnDeleteRoom").click();
    await bob.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), sourceRoom);
    await bob.locator(`#roomListChat [data-room-id="${secondRoom}"]`).waitFor({ state: "detached" });
    expect(await bob.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]"))).toContain(directRoomId);
    if (pageErrors.length) {
      const [aliceState, bobState] = await Promise.all([captureAppState(alice), captureAppState(bob)]);
      throw new Error(JSON.stringify({ pageErrors, httpErrors, appState: { alice: aliceState, bob: bobState } }));
    }
    expect(unauthorized.length).toBe(2);
    expect(roomLeaves).toEqual([]);
    await context.close();
    await bobContext.close();
    const fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const fallback = await fallbackContext.newPage();
    const fallbackErrors: string[] = [], fallback401: string[] = [];
    await fallback.addInitScript(() => {
      const local = window.localStorage, session = window.sessionStorage;
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      Storage.prototype.getItem = function (key) { if (this === session) throw new Error("session storage blocked"); return get.call(this, key); };
      Storage.prototype.setItem = function (key, value) { if (this === local || this === session) throw new Error("storage is read-only"); return set.call(this, key, value); };
      Storage.prototype.removeItem = function (key) { if (this === local || this === session) throw new Error("storage is read-only"); return remove.call(this, key); };
      Object.defineProperty(Crypto.prototype, "randomUUID", { configurable: true, value: undefined });
    });
    watchPage(fallback, fallbackErrors, fallback401);
    await fallback.goto(`${origin}/chat`);
    expect(await fallback.evaluate(() => crypto.randomUUID === undefined)).toBe(true);
    await fallback.locator("#tokenBox[open]").waitFor();
    await fallback.locator("#inName").fill("Fallback");
    await fallback.locator("#inRoomName").fill("Blocked storage room");
    await fallback.locator("#btnCreate").click();
    await fallback.locator("#joinError").waitFor({ state: "visible" });
    await fallback.locator("#inToken").fill("ui-test-token");
    await fallback.locator('[data-token-save="inToken"]').click();
    await fallback.waitForFunction(() => document.querySelector('[data-token-save="inToken"]')?.textContent === "Saved for this tab only");
    await fallback.locator("#chatView").waitFor({ state: "visible" });
    expect(await fallback.evaluate(() => localStorage.getItem("chat.token"))).toBe(null);
    const fallbackRoom = await currentRoomId(fallback);
    await fallback.locator("#msgInput").fill(GFM_FIXTURE);
    await fallback.locator("#btnSend").click();
    const fallbackMessage = fallback.locator(".msg-text").last();
    await fallbackMessage.locator("table").waitFor();
    expect(await fallbackMessage.locator("script, [onerror], a[href^='javascript:']").count()).toBe(0);

    const fallbackPeerContext = await browser.newContext();
    const fallbackPeer = await fallbackPeerContext.newPage();
    await fallbackPeer.addInitScript(() => localStorage.setItem("chat.token", "ui-test-token"));
    watchPage(fallbackPeer, fallbackErrors, fallback401);
    await fallbackPeer.goto(`${origin}/chat`);
    await fallbackPeer.locator("#inName").fill("Peer");
    await fallbackPeer.locator("#inRoomId").fill(fallbackRoom);
    await fallbackPeer.locator("#btnJoin").click();
    await fallbackPeer.locator("#chatView").waitFor({ state: "visible" });
    await fallback.locator("#btnMembers").click();
    await fallback.locator("#memberList").getByText("Peer").waitFor();
    await fallback.getByRole("button", { name: "Message privately" }).click();
    await fallback.waitForFunction((id: string) => !(document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), fallbackRoom);
    await fallback.locator("#msgInput").fill("Storage fallback direct message");
    await fallback.locator("#btnSend").click();
    await fallback.locator(".msg-name").filter({ hasText: "You" }).last().waitFor();
    expect(fallbackErrors).toEqual([]);
    expect(fallback401.length).toBe(2);
    await fallbackContext.close();
    await fallbackPeerContext.close();
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: "dark" });
    const join = await mobileContext.newPage();
    await join.addInitScript(() => localStorage.setItem("chat.token", "ui-test-token"));
    await join.goto(`${origin}/chat`);
    await join.waitForLoadState("domcontentloaded");
    expect(await join.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mobileContext.close();
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

function isolatedServerEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CHAT_ROOM_SERVER_URL;
  delete env.CHAT_ROOM_SERVER_TOKEN;
  delete env.CHAT_ROOM_WAKE_SERVE_URL;
  return {
    ...env,
    CHAT_ROOM_STATE_DIR: stateDir,
    CHAT_ROOM_SERVER_HOST: "127.0.0.1",
    CHAT_ROOM_SERVER_PORT: String(port),
    CHAT_ROOM_SERVER_TOKEN: "ui-test-token",
    HOME: path.join(stateDir, "home"),
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

async function currentRoomId(page: any) {
  const title = await page.locator("#btnCopyId").getAttribute("title");
  return title!.slice(title!.lastIndexOf(": ") + 2);
}

async function captureAppState(page: any) {
  return page.evaluate(async (url: string) => {
    const { app } = await import(url);
    return {
      roomId: app.state.room?.id || null,
      questionPanelHidden: document.querySelector<HTMLElement>("#questionPanel")?.hidden,
      questionStatus: document.querySelector<HTMLElement>("#questionStatus")?.textContent,
    };
  }, "/assets/chat/state.js");
}

function watchMembershipRequests(page: any, joins: string[], leaves: string[], reads: string[]) {
  page.on("request", (request: any) => {
    const url = new URL(request.url()), method = request.method();
    const join = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
    if (method === "POST" && join) joins.push(decodeURIComponent(join[1] ?? ""));
    if (method === "POST" && /\/rooms\/[^/]+\/leave$/.test(url.pathname)) leaves.push(url.pathname);
    if (method === "POST" && url.pathname === "/read") {
      const roomId = request.postDataJSON()?.roomId;
      if (typeof roomId === "string") reads.push(roomId);
    }
  });
}

function watchPage(page: any, errors: string[], unauthorized: string[], httpErrors: string[] = []) {
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message: any) => {
    if (message.type() === "error" && !message.text().includes("status of 401")) errors.push(message.text());
  });
  page.on("response", (response: any) => {
    if (response.status() === 401) unauthorized.push(response.url());
    else if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
}

async function localeGeometry(page: any) {
  return page.evaluate(() => {
    const height = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().height;
    const thread = document.querySelector<HTMLElement>("#thread")!;
    return {
      head: height("#chatView > .chat-head"), composer: height(".composer"), composerRow: height(".composer-row"),
      input: height("#msgInput"), send: height("#btnSend"), controls: Array.from(document.querySelectorAll<HTMLElement>(".chat-head-actions .chip")).map((node) => node.getBoundingClientRect().height),
      viewportWidth: innerWidth, meta: height(".composer-meta"), questionToggle: height(".question-toggle"), draftCount: height("#draftCount"),
      inputStyle: (() => { const node = document.querySelector<HTMLElement & { value: string }>("#msgInput")!, style = getComputedStyle(node); return { height: style.height, minHeight: style.minHeight, lineHeight: style.lineHeight, scrollHeight: node.scrollHeight, placeholder: node.getAttribute("aria-placeholder"), value: node.value }; })(),
      settings: height("#chatSettings"), privacy: height('#chatSettings [data-i18n="privacyNote"]'),
      pageX: document.documentElement.scrollWidth - innerWidth, pageY: document.documentElement.scrollHeight - innerHeight,
      threadX: thread.scrollWidth - thread.clientWidth,
      headX: document.querySelector<HTMLElement>("#chatView > .chat-head")!.scrollWidth - document.querySelector<HTMLElement>("#chatView > .chat-head")!.clientWidth,
      headParts: Array.from(document.querySelector<HTMLElement>("#chatView > .chat-head")!.children).map((node) => [node.getBoundingClientRect().left, node.getBoundingClientRect().right, node.scrollWidth, node.clientWidth]),
    };
  });
}

function expectLocaleGeometry(a: Awaited<ReturnType<typeof localeGeometry>>, b: Awaited<ReturnType<typeof localeGeometry>>) {
  for (const key of ["head", "composer", "composerRow", "input", "send", "privacy", "settings"] as const) if (Math.abs(a[key] - b[key]) > 1) throw new Error(`${key}: ${a[key]} vs ${b[key]} (${JSON.stringify({ en: { width: a.viewportWidth, row: a.composerRow, input: a.input, meta: a.meta, toggle: a.questionToggle, count: a.draftCount, style: a.inputStyle }, zh: { width: b.viewportWidth, row: b.composerRow, input: b.input, meta: b.meta, toggle: b.questionToggle, count: b.draftCount, style: b.inputStyle } })})`);
  expect(a.controls).toHaveLength(b.controls.length);
  a.controls.forEach((height: number, index: number) => expect(Math.abs(height - b.controls[index]!)).toBeLessThanOrEqual(1));
  for (const metrics of [a, b]) {
    expect(metrics.pageX).toBeLessThanOrEqual(1);
    expect(metrics.pageY).toBeLessThanOrEqual(1);
    expect(metrics.threadX).toBeLessThanOrEqual(1);
    expect(metrics.headX).toBeLessThanOrEqual(1);
  }
}
