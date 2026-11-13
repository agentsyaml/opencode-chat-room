import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-composer-sizing-local-token";

test.skipIf(!browserModule)("message composer grows to five wrapped lines before scrolling", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-composer-sizing-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const browserErrors: string[] = [];
    page.on("pageerror", (error: Error) => browserErrors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error" && !message.location().url.includes("/announcements/__Test_FailedDraft")) browserErrors.push(`${message.text()} ${message.location().url}`); });
    page.on("response", (response: any) => { if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith("/announcements/__Test_FailedDraft")) browserErrors.push(`${response.status()} ${response.url()}`); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Composer tester");
    await page.locator("#inRoomName").fill("__Test_ComposerSizing");
    await page.locator("#btnCreate").click();
    const input = page.locator("#msgInput"); await input.waitFor({ state: "visible" });
    await profileMenuWorks(page);
    await announcementBoardWorks(page, artifacts);
    expect(await page.locator("#roomRail").evaluate((node: HTMLElement) => getComputedStyle(node).position !== "fixed" && !(node as any).inert)).toBe(true);
    expect(await page.locator("#btnRoomsDrawer").isVisible()).toBe(false);
    expect(await metaRow(page)).toBe(true);
    expect(await measure(input)).toMatchObject({ overflow: "hidden", fits: true });
    await input.fill("one line");
    expect(await measure(input)).toMatchObject({ overflow: "hidden", fits: true });
    await input.fill("1\n2\n3\n4\n5");
    expect(await measure(input)).toMatchObject({ overflow: "hidden", fits: true });
    await input.fill("1\n2\n3\n4\n5\n6");
    expect(await measure(input)).toMatchObject({ overflow: "auto", fits: false });
    await input.fill("1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
    await input.evaluate((node: any) => node.setCaret(node.value.length));
    await page.keyboard.insertText("last-visible-line");
    const composerScroll = await input.evaluate((node: HTMLElement) => {
      const range = getSelection()!.getRangeAt(0).cloneRange(); range.collapse(true);
      const caret = range.getBoundingClientRect(), box = node.getBoundingClientRect();
      return { scrollTop: node.scrollTop, caretTop: caret.top, boxTop: box.top, caretBottom: caret.bottom, boxBottom: box.bottom };
    });
    expect(composerScroll.scrollTop).toBeGreaterThan(0);
    expect(composerScroll.caretTop).toBeGreaterThanOrEqual(composerScroll.boxTop);
    expect(composerScroll.caretBottom).toBeLessThanOrEqual(composerScroll.boxBottom + 1);
    await input.fill("");
    await seedMessages(page);
    expect(await selectionContrast(page)).toBe(true);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-own-selection-light.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await selectionContrast(page)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-own-selection-dark.png"), fullPage: true });
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.emulateMedia({ colorScheme: "light" });
    const resourceCalls = await mermaidAndResourceWorks(page, token, artifacts);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-desktop-light.png"), fullPage: true });
    await page.locator("#thread").hover(); await page.mouse.wheel(0, -1000);
    await frame(page); const before = await readingAnchor(page);
    const storedAnchor = await page.evaluate(async (url: string) => {
      const { app } = await import(url); return app.state.positions.get(app.state.room.id);
    }, "/assets/chat/state.js");
    expect(storedAnchor.messageId).toBe(before.id);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url); app.stopPolling(); clearTimeout(app.state.memberRefreshTimer);
      if (app.state.receiptObservationFrame) cancelAnimationFrame(app.state.receiptObservationFrame);
      app.state.receiptObservationFrame = 0; app.state.receiptObservation = null;
      const calls = { reads: 0, receipts: [] as string[] }, mark = app.markActiveRoomRead, observe = app.queueReceiptObservation;
      app.markActiveRoomRead = () => { calls.reads++; }; app.queueReceiptObservation = () => { calls.receipts.push(new Error().stack || "unknown"); };
      (window as any).__resizeProbe = { calls, mark, observe };
    }, "/assets/chat/state.js");
    await page.setViewportSize({ width: 320, height: 640 }); await frame(page);
    const narrow = await readingAnchor(page);
    if (narrow.id !== before.id) throw new Error(JSON.stringify({ before, narrow }));
    expect(Math.abs(narrow.offset - before.offset)).toBeLessThan(3);
    await page.setViewportSize({ width: 1280, height: 800 }); await frame(page);
    const wide = await readingAnchor(page);
    if (wide.id !== before.id) throw new Error(JSON.stringify({ before, narrow, wide }));
    expect(Math.abs(wide.offset - before.offset)).toBeLessThan(3);
    const resizeCalls = await page.evaluate(() => (window as any).__resizeProbe.calls);
    if (resizeCalls.reads || resizeCalls.receipts.length) throw new Error(JSON.stringify(resizeCalls));
    await page.evaluate(async (url: string) => {
      const { app } = await import(url), probe = (window as any).__resizeProbe;
      app.markActiveRoomRead = probe.mark; app.queueReceiptObservation = probe.observe; app.startPolling();
    }, "/assets/chat/state.js");
    await page.locator("#thread").hover(); await page.mouse.wheel(0, 5000);
    await frame(page); await page.setViewportSize({ width: 320, height: 640 }); await frame(page);
    expect(await page.locator("#thread").evaluate((node: HTMLElement) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(4);
    await page.setViewportSize({ width: 1280, height: 800 }); await frame(page);
    expect(await page.locator("#thread").evaluate((node: HTMLElement) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(4);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await metaRow(page)).toBe(true);
    await profileMenuWorks(page);
    const drawerButton = page.locator("#btnRoomsDrawer"), rail = page.locator("#roomRail");
    const beforeDrawer = await page.locator("#msgScroll").boundingBox();
    await drawerButton.click(); await rail.waitFor({ state: "visible" });
    expect(await rail.evaluate((node: HTMLElement) => getComputedStyle(node).position)).toBe("fixed");
    expect((await page.locator("#msgScroll").boundingBox())!.height).toBe(beforeDrawer!.height);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-room-drawer-320.png"), fullPage: true });
    await page.keyboard.press("Escape"); await rail.waitFor({ state: "hidden" });
    expect(await drawerButton.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
    await drawerButton.click(); await page.locator("#roomDrawerBackdrop").click({ position: { x: 315, y: 635 } });
    await rail.waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-mobile-320.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, "chat-ui-mobile-375.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(artifacts, "chat-ui-mobile-dark.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    await drawerButton.click(); await rail.waitFor({ state: "visible" });
    await page.keyboard.press("Escape"); await rail.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 320, height: 640 });
    await input.fill("word ".repeat(100));
    expect(await measure(input)).toMatchObject({ overflow: "auto", fits: false, horizontal: true });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = thread.scrollHeight / 2; });
    await frame(page); const reentryAnchor = await readingAnchor(page);
    const otherRoomId = await switchRoom(page, "__Test_ComposerOther", roomId);
    expect(await input.evaluate((node: any) => node.value)).toBe("word ".repeat(100));
    expect(await readingAnchor(page)).toMatchObject({ id: reentryAnchor.id });
    expect(Math.abs((await readingAnchor(page)).offset - reentryAnchor.offset)).toBeLessThan(3);
    await selectRoom(page, otherRoomId);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      clearTimeout(app.state.watcherTimer); app.state.watcherTimer = 0;
      (window as any).__startRoomWatcher = app.startRoomWatcher; app.startRoomWatcher = () => {};
    }, "/assets/chat/state.js");
    await page.evaluate(async ({ url, id, anchor }: { url: string; id: string; anchor: string }) => {
      const { app } = await import(url), entry = app.state.rooms.get(id);
      entry.room.messages = entry.room.messages.filter((message: any) => message.id !== anchor);
    }, { url: "/assets/chat/state.js", id: roomId, anchor: reentryAnchor.id });
    const awayMessage = await page.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/join`, { method: "POST", body: JSON.stringify({ sessionID: "resize-reader", participantId: "Resize reader", participantName: "Resize reader" }) });
      const result = await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID: "resize-reader", text: "Unread while away" }) });
      return result.messages.at(-1);
    }, { url: "/assets/chat/state.js", id: roomId });
    const inboxPattern = "**/inbox**";
    let releaseInbox!: () => void, startInbox!: () => void, finishInbox!: () => void;
    const inboxGate = new Promise<void>((resolve) => { releaseInbox = resolve; });
    const inboxStarted = new Promise<void>((resolve) => { startInbox = resolve; });
    const inboxDone = new Promise<void>((resolve) => { finishInbox = resolve; });
    await page.route(inboxPattern, async (route: any) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("roomId") !== roomId || query.get("timeout") !== "25000") return route.continue();
      startInbox(); await inboxGate;
      const response = await route.fetch(); await route.fulfill({ response }); finishInbox();
    });
    await selectRoom(page, roomId);
    await inboxStarted;
    const preInbox = await page.evaluate(async ({ url, id, messageId }: any) => {
      const entry = (await import(url)).app.state.rooms.get(id);
      return { knownFromHistory: entry.room.messages.some((message: any) => message.id === messageId), unreadBeforePoll: entry.unreadIds.has(messageId) };
    }, { url: "/assets/chat/state.js", id: roomId, messageId: awayMessage.id });
    expect(preInbox).toEqual({ knownFromHistory: true, unreadBeforePoll: false });
    releaseInbox(); await inboxDone; await page.unroute(inboxPattern);
    await page.waitForFunction(async ({ url, id, messageId }: any) => (await import(url)).app.state.rooms.get(id)?.unreadIds.has(messageId), { url: "/assets/chat/state.js", id: roomId, messageId: awayMessage.id }, { timeout: 10000 });
    await page.locator("#msgList").getByText("Unread while away").waitFor();
    expect(await readingAnchor(page)).toMatchObject({ id: reentryAnchor.id });
    expect(Math.abs((await readingAnchor(page)).offset - reentryAnchor.offset)).toBeLessThan(3);
    const unreadState = await page.evaluate(async ({ url, id }: any) => {
      const { app } = await import(url), registry = await app.api(`/rooms/${encodeURIComponent(id)}/registry`);
      return { unread: app.state.unread, readTs: registry[app.LS.sessionID]?.lastReadTs || 0 };
    }, { url: "/assets/chat/state.js", id: roomId });
    expect(unreadState.unread).toBeGreaterThan(0);
    expect(unreadState.readTs).toBeLessThan(awayMessage.createdAt);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url); app.startRoomWatcher = (window as any).__startRoomWatcher; delete (window as any).__startRoomWatcher;
    }, "/assets/chat/state.js");
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "__Test_ComposerSizing");
    await frame(page);
    expect(await readingAnchor(page)).toMatchObject({ id: reentryAnchor.id });
    expect(Math.abs((await readingAnchor(page)).offset - reentryAnchor.offset)).toBeLessThan(3);
    expect(await measure(input)).toMatchObject({ overflow: "auto", fits: false });
    const otherPosition = await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.state.positions.get(id), { url: "/assets/chat/state.js", id: otherRoomId });
    await page.setViewportSize({ width: 375, height: 700 }); await frame(page);
    expect(await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.state.positions.get(id), { url: "/assets/chat/state.js", id: otherRoomId })).toEqual(otherPosition);
    await page.setViewportSize({ width: 320, height: 640 }); await frame(page);
    await input.fill("");
    expect(await measure(input)).toMatchObject({ overflow: "hidden", fits: true });
    await input.fill("send reset"); await page.locator("#btnSend").click();
    await page.waitForFunction(() => (document.querySelector<HTMLElement & { value: string }>("#msgInput")?.value ?? null) === "");
    expect(await measure(input)).toMatchObject({ overflow: "hidden", fits: true });
    if (browserErrors.length) throw new Error(JSON.stringify({ browserErrors, resourceCalls }));
    await page.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
async function announcementBoardWorks(page: any, artifacts: string) {
  const name = "__Test_AnnouncementBoard", content = "Plain text only: <img src=x onerror=alert(1)>";
  await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementPanel").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "No announcements yet.");
  await page.locator("#announcementName").fill(name);
  await page.locator("#announcementContent").fill(content);
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.", null, { timeout: 5000 }).catch(async () => {
    throw new Error(`Announcement save status: ${await page.locator("#announcementStatus").textContent()}`);
  });
  await page.locator("#btnNewAnnouncement").click();
  await page.locator("#announcementName").fill(name);
  await page.locator("#announcementContent").fill("Should not overwrite");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent?.includes("already exists"));
  await page.locator("#announcementList button").click();
  if (!await page.locator("#announcementPanel").isVisible()) throw new Error(`Announcement panel closed: ${await page.locator("#announcementStatus").textContent()}`);
  expect(await page.locator("#announcementContent").inputValue()).toBe(content);
  await page.locator("#announcementContent").fill("Edited safely");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.screenshot({ path: path.join(artifacts, "chat-announcement-board.png"), fullPage: true });
  await announcementRaces(page, name);
  await announcementRoomActivation(page);
  await page.locator("#btnAnnouncements").click();
}
async function announcementRaces(page: any, first: string) {
  const second = "__Test_AnnouncementOther", name = "#announcementName", content = "#announcementContent";
  const row = (value: string) => page.locator("#announcementList button").filter({ hasText: value });
  await page.locator("#btnNewAnnouncement").click();
  await page.locator(name).fill(second); await page.locator(content).fill("Second announcement");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  page.on("dialog", (dialog: any) => dialog.accept());
  await row(first).click();
  const roomId = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  const update = async (value: string) => page.evaluate(async ({ url, id, name, content }: any) => {
    const { app } = await import(url);
    await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ sessionID: app.LS.sessionID, content }) });
  }, { url: "/assets/chat/state.js", id: roomId, name: first, content: value });
  await update("Updated by agent"); await page.locator("#btnRefreshAnnouncements").click();
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#announcementContent")?.value === "Updated by agent");
  await page.locator("#announcementContent").fill("Unsaved local edit");
  await update("Updated again externally"); await page.locator("#btnRefreshAnnouncements").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "");
  expect(await page.locator("#announcementContent").inputValue()).toBe("Unsaved local edit");
  await row(first).click(); await page.locator(content).fill("Saved A snapshot");
  const put = await holdMutation(page, first, "PUT");
  await page.locator("#btnSaveAnnouncement").click(); await put.started;
  await row(second).click(); await page.locator(content).fill("B remains selected");
  put.release(); await put.done;
  expect(await row(second).getAttribute("aria-current")).toBe("true");
  expect(await page.locator(content).inputValue()).toBe("B remains selected");
  expect(await page.locator(content).evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
  await page.unroute(put.pattern);
  await page.locator(content).fill("B submitted snapshot");
  const putB = await holdMutation(page, second, "PUT");
  await page.locator("#btnSaveAnnouncement").click(); await putB.started;
  await page.locator(content).fill("Typed after save click");
  putB.release(); await putB.done;
  expect(await page.locator(content).inputValue()).toBe("Typed after save click");
  await page.unroute(putB.pattern);
  const del = await holdMutation(page, first, "DELETE");
  await row(first).click(); await page.locator("#btnDeleteAnnouncement").click(); await del.started;
  await row(second).click(); await page.locator(content).fill("B survives delete");
  del.release(); await del.done;
  expect(await row(second).getAttribute("aria-current")).toBe("true");
  expect(await page.locator(content).inputValue()).toBe("B survives delete");
  await page.unroute(del.pattern);
  await page.locator("#btnNewAnnouncement").click();
  await page.locator(name).fill("__Test_FailedDraft"); await page.locator(content).fill("Keep failed draft");
  await page.route(`**/rooms/*/announcements/__Test_FailedDraft`, (route: any) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Mock save failure" }) }));
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent?.includes("Your draft is still here"));
  expect(await page.locator(name).inputValue()).toBe("__Test_FailedDraft");
  expect(await page.locator(content).inputValue()).toBe("Keep failed draft");
  await page.locator("#btnAnnouncements").click(); await page.locator("#btnAnnouncements").click();
  await page.waitForFunction(() => document.querySelectorAll("#announcementList button").length === 1);
  expect(await page.locator(name).inputValue()).toBe("__Test_FailedDraft");
  expect(await page.locator(content).inputValue()).toBe("Keep failed draft");
  await page.unroute(`**/rooms/*/announcements/__Test_FailedDraft`);
  await row(second).click(); await page.locator("#btnDeleteAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement deleted.");
  expect(await page.locator("#announcementList button").count()).toBe(0);
}
async function holdMutation(page: any, name: string, method: string) {
  const pattern = `**/rooms/*/announcements/${encodeURIComponent(name)}`;
  let release!: () => void, start!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { start = resolve; });
  const done = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(pattern, async (route: any) => {
    if (route.request().method() !== method) return route.continue();
    start(); await gate;
    const response = await route.fetch(); await route.fulfill({ response }); finish();
  });
  return { pattern, started, done, release };
}
async function announcementRoomActivation(page: any) {
  const sourceID = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#btnAnnouncements").click();
  const targetName = "__Test_AnnouncementDelayed";
  await page.locator("#btnNewRoom").click(); await page.locator("#inRoomNameChat").fill(targetName);
  await page.locator("#btnCreateChatRoom").click();
  await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, targetName);
  const targetID = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  await page.locator("#msgInput").fill("Announcement history anchor"); await page.locator("#btnSend").click();
  await page.locator("#msgList").getByText("Announcement history anchor").waitFor();
  await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementName").fill("__Test_TargetAnnouncement");
  await page.locator("#announcementContent").fill("Target room content");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#btnAnnouncements").click();
  await page.locator(`#roomListChat [data-room-id="${sourceID}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), sourceID);
  await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementList").getByText("__Test_FailedDraft").click();
  const anchor = await page.evaluate(async ({ url, id }: any) => {
    const { app } = await import(url), entry = app.state.rooms.get(id), message = entry.room.messages.at(-1);
    app.state.positions.set(id, { messageId: message.id, offset: 0 }); entry.room.messages = [];
    return message.id;
  }, { url: "/assets/chat/state.js", id: targetID });
  const pattern = `**/rooms/${targetID}/history*`;
  let release!: () => void, start!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { start = resolve; });
  const done = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(pattern, async (route: any) => {
    start(); await gate;
    const response = await route.fetch(); await route.fulfill({ response }); finish();
  });
  await page.locator(`#roomListChat [data-room-id="${targetID}"]`).click(); await started;
  expect(await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js")).toBe(sourceID);
  expect(await page.locator("#announcementName").inputValue()).toBe("__Test_FailedDraft");
  expect(await page.locator("#announcementContent").inputValue()).toBe("Keep failed draft");
  release(); await done; await page.unroute(pattern);
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), targetID);
  if (!await page.locator("#announcementPanel").isVisible()) await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementList").getByText("__Test_TargetAnnouncement").waitFor();
  await page.locator("#announcementList").getByText("__Test_TargetAnnouncement").click();
  expect(await page.locator("#announcementContent").inputValue()).toBe("Target room content");
  expect(await page.locator("#msgList").getByText("Announcement history anchor").count()).toBe(1);
  await page.locator(`#roomListChat [data-room-id="${sourceID}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), sourceID);
  if (!await page.locator("#announcementPanel").isVisible()) await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementList").getByText("__Test_FailedDraft").waitFor();
}
async function seedMessages(page: any) {
  for (let i = 0; i < 12; i++) {
    const text = `Resize anchor ${i} ${"reflow content wraps across the conversation ".repeat(12)}`;
    await page.locator("#msgInput").fill(text); await page.locator("#btnSend").click();
    await page.waitForFunction((prefix: string) => Array.from(document.querySelectorAll(".msg-text")).some((node) => node.textContent?.startsWith(prefix)), `Resize anchor ${i}`);
  }
}
async function mermaidAndResourceWorks(page: any, token: string, artifacts: string) {
  const input = page.locator("#msgInput");
  await input.fill("```mermaid\nflowchart TD\nA[Start] --> B[Finish]\n```");
  await page.locator("#btnSend").click();
  const diagram = page.locator(".mermaid-diagram").last();
  await diagram.locator("svg").waitFor();
  expect(await diagram.locator("foreignObject, a, script").count()).toBe(0);
  await diagram.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(artifacts, "chat-ui-valid-mermaid.png"), fullPage: true });
  let remoteRequests = 0;
  await page.route("https://attacker.invalid/**", async (route: any) => {
    remoteRequests++; return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=", "base64") });
  });
  await page.evaluate(() => (window as any).mermaid.render("image-probe", 'flowchart TD\nA@{ img: "https://attacker.invalid/pixel" } --> B'));
  expect(remoteRequests).toBeGreaterThan(0);
  const rawRequestCount = remoteRequests;
  for (const [index, source] of [
    '%%{init: {"securityLevel":"loose","flowchart":{"htmlLabels":true}}}%%\nflowchart TD\nA --> B',
    '---\nconfig:\n  themeCSS: "body { background: url(https://example.invalid) }"\n---\nflowchart TD\nA --> B',
    "flowchart TD\nA[Start] --> B[Finish]\nstyle A fill:url(https://example.invalid)",
    'flowchart TD\nA@{ img: "https://attacker.invalid/pixel" } --> B',
  ].entries()) {
    const count = await page.locator(".mermaid-diagram").count();
    await input.fill(`\`\`\`mermaid\n${source}\n\`\`\``); await page.locator("#btnSend").click();
    await page.waitForFunction((previous: number) => document.querySelectorAll(".mermaid-diagram").length > previous, count);
    await page.locator(".mermaid-diagram").last().locator("pre code").waitFor({ timeout: 3000 }).catch(async () => {
      const context = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.at(-1).text, "/assets/chat/state.js");
      throw new Error(`Mermaid config case ${index} rendered unexpectedly: ${context} / ${await page.locator(".mermaid-diagram").last().innerText()}`);
    });
  }
  expect(remoteRequests).toBe(rawRequestCount);
  await page.unroute("https://attacker.invalid/**");
  const diagramCount = await page.locator(".mermaid-diagram").count();
  await input.fill("```mermaid\nflowchart TD\nA -->\n```"); await page.locator("#btnSend").click();
  await page.waitForFunction((previous: number) => document.querySelectorAll(".mermaid-diagram").length > previous, diagramCount);
  const fallback = page.locator(".mermaid-diagram").last();
  await fallback.locator("pre code").waitFor();
  expect(await fallback.locator("pre code").textContent()).toContain("A -->");
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  const id = "11111111-1111-4111-8111-111111111111", roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
  let authorized = false; const resourceCalls: string[] = [];
  const resourceRoute = "**/*";
  await page.route(resourceRoute, async (route: any) => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.includes(`/resources/${id}`)) return route.continue();
    resourceCalls.push(url.pathname);
    authorized ||= request.headers().authorization === `Bearer ${token}`;
    expect(url.search).toBe("");
    if (url.pathname.endsWith("/content")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=", "base64") });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ resource: { id, roomID: roomId, name: "preview.png", mimeType: "image/png", size: 68, createdAt: Date.now() } }) });
  });
  await input.fill(`See this [[resource:${id}]]`); await page.locator("#btnSend").click();
  const file = page.locator(".chat-resource").last(); await file.getByText("preview.png").waitFor();
  // Media in your own message previews automatically; collapse it to test the click path.
  await file.locator("img").waitFor();
  await file.getByRole("button", { name: /Hide/ }).click();
  await file.locator("img").waitFor({ state: "detached" });
  const loadsBefore = resourceCalls.filter((path) => path.endsWith("/content")).length;
  const preview = file.getByRole("button", { name: /Preview/ });
  await preview.evaluate(async (button: HTMLButtonElement, url: string) => {
    const state = await import(url), current = state.app.state.room;
    state.app.state.room = { ...current, id: "wrong-room-if-read-late" };
    button.click(); button.click(); state.app.state.room = current;
  }, "/assets/chat/state.js");
  await file.locator("img").waitFor();
  expect(await file.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1)).toBe(true);
  expect(resourceCalls.filter((path) => path.endsWith("/content"))).toHaveLength(loadsBefore + 1);
  expect(resourceCalls).toContain(`/rooms/${roomId}/resources/${id}/content`);
  expect(authorized).toBe(true);
  return resourceCalls;
}
async function readingAnchor(page: any) {
  return page.locator("#thread").evaluate((thread: HTMLElement) => {
    const top = thread.getBoundingClientRect().top + thread.clientTop;
    const row = Array.from(thread.querySelectorAll<HTMLElement>("[data-msg-id]")).find((item) => item.getBoundingClientRect().bottom > top)!;
    return { id: row.dataset.msgId, offset: row.getBoundingClientRect().top - top, scrollTop: thread.scrollTop, height: thread.scrollHeight, viewport: thread.clientHeight };
  });
}
async function selectionContrast(page: any) {
  return page.evaluate(() => {
    const bubble = Array.from(document.querySelectorAll<HTMLElement>(".msg.own .msg-text")).at(-1)!;
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT), text = walker.nextNode()!;
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const style = getComputedStyle(text.parentElement!, "::selection");
    const visible = style.backgroundColor !== getComputedStyle(bubble).backgroundColor
      && style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.color !== getComputedStyle(bubble).color;
    return visible;
  });
}
async function frame(page: any) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function measure(input: any) {
  return input.evaluate((node: HTMLTextAreaElement) => ({
    overflow: getComputedStyle(node).overflowY,
    fits: node.scrollHeight <= node.clientHeight,
    horizontal: node.scrollWidth <= node.clientWidth,
  }));
}
async function profileMenuWorks(page: any) {
  const trigger = page.locator("#btnSettings"), drawer = page.locator("#btnRoomsDrawer"), rail = page.locator("#roomRail");
  expect(await trigger.getAttribute("aria-label")).toBe("Your profile and settings"); const narrow = !(await trigger.isVisible());
  if (narrow) { await drawer.click(); await rail.waitFor({ state: "visible" }); expect(await drawer.getAttribute("aria-expanded")).toBe("true"); }
  await trigger.click(); await page.locator("#chatSettings").waitFor({ state: "visible" }); await page.waitForTimeout(220); expect(await trigger.getAttribute("aria-expanded")).toBe("true");
  const geometry = await page.evaluate(() => { const trigger = document.querySelector<HTMLElement>("#btnSettings")!, avatar = document.querySelector<HTMLElement>("#profileAvatar")!, name = document.querySelector<HTMLElement>("#railIdentity")!, panel = document.querySelector<HTMLElement>("#chatSettings")!; const anchor = trigger.getBoundingClientRect(), box = panel.getBoundingClientRect(); return { above: box.bottom <= anchor.top && anchor.top - box.bottom < 20, bottomLeft: Math.abs(box.left - anchor.left) < 1, clamped: box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, identityVisible: !!avatar.getClientRects().length && !!name.getClientRects().length && !!name.textContent?.trim() }; });
  expect(geometry).toEqual({ above: true, bottomLeft: true, clamped: true, identityVisible: true });
  if (narrow) {
    expect(await trigger.getAttribute("aria-expanded")).toBe("true"); await trigger.click(); await page.locator("#chatSettings").waitFor({ state: "hidden" });
    expect(await trigger.getAttribute("aria-expanded")).toBe("false"); await page.keyboard.press("Escape"); await rail.waitFor({ state: "hidden" });
    expect(await drawer.getAttribute("aria-expanded")).toBe("false"); expect(await drawer.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
  } else {
    await page.keyboard.press("Escape"); await page.locator("#chatSettings").waitFor({ state: "hidden" }); expect(await trigger.getAttribute("aria-expanded")).toBe("false"); expect(await trigger.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
  }
}
async function metaRow(page: any) {
  return page.locator(".composer-meta").evaluate((row: HTMLElement) => {
    const count = row.querySelector("#draftCount")!.getBoundingClientRect();
    return count.width > 0 && row.scrollWidth <= row.clientWidth;
  });
}
async function switchRoom(page: any, roomName: string, previousRoom: string) {
  await page.locator("#btnRoomsDrawer").click();
  await page.locator("#btnNewRoom").click();
  await page.locator("#inRoomNameChat").fill(roomName);
  await page.locator("#btnCreateChatRoom").click();
  await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, roomName);
  const otherRoomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
  await page.locator("#msgInput").fill("Other room anchor"); await page.locator("#btnSend").click();
  await page.locator("#msgList").getByText("Other room anchor").waitFor();
  await page.locator("#btnRoomsDrawer").click();
  await page.locator(`#roomListChat [data-room-id="${previousRoom}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), previousRoom);
  return otherRoomId;
}
async function selectRoom(page: any, roomId: string) {
  await page.locator("#btnRoomsDrawer").click();
  await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), roomId);
}
async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local isolated chat server did not start");
}
