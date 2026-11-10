/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-receipts-local-token";
const duplicateName = "Mira";

test.skipIf(!browserModule)("room activity and per-message receipts stay identity-safe", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-receipts-"));
  const artifactDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifactDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    const receiptRequests: string[] = [];
    page.on("request", (request: any) => { if (new URL(request.url()).pathname.endsWith("/receipts")) receiptRequests.push(`${request.method()} ${request.postData() || ""}`); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Room host");
    await page.locator("#inRoomName").fill("__Test_ReceiptsRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    const ownerID = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(artifactDir, "chat-empty-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifactDir, "chat-empty-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 850 });
    const receiverOwnerID = "a8d6b3a5-34ad-41e7-91c6-796b40bbf815";
    const displayedAcks: Array<{ ids: string[]; visibleIDs: string[] }> = [];
    await page.evaluate(async (url: string) => { const { app } = await import(url); app.stopPolling(); clearTimeout(app.state.memberRefreshTimer); }, "/assets/chat/state.js");
    for (const [sessionID, protocol] of [["twin-a", undefined], ["twin-b", undefined], ["agent-twin", "v2"]] as const) {
      await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID, participantId: duplicateName, participantName: duplicateName, ...(protocol ? { protocol, receiverOwnerID } : {}) });
    }
    let oldMessage: any;
    for (let i = 0; i < 8; i++) {
      const result = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "agent-twin", text: `Old history ${i} ${"earlier words ".repeat(35)}` });
      oldMessage ||= result;
    }
    const target = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "agent-twin", text: "Visible receipt target" });
    const contextMessage = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "twin-b", text: `Context receipt with wide content\n\nhttps://example.com/${"unbroken-segment".repeat(12)}\n\n| Item | Status | Detail | Owner | Updated | Source |\n| --- | --- | --- | --- | --- | --- |\n| Queue | Waiting | Long text scrolls horizontally on small screens | Mira | Today | Room |\n\n\`\`\`js\nconst longIdentifier = 'selection-and-receipt-layout-regression';\nconsole.log(longIdentifier);\n\`\`\`` });
    await page.locator("#msgInput").fill("My short note");
    await page.locator("#btnSend").click();
    await page.locator("#msgList").getByText("My short note").waitFor();
    const oldMessageID = oldMessage.messages.at(-1).id, targetMessageID = target.messages.at(-1).id;
    const contextMessageID = contextMessage.messages.at(-1).id;
    const ownMessageID = await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.find((message: any) => message.text === "My short note").id, "/assets/chat/state.js");
    await api(origin, "/queued", "POST", { roomId, sessionID: ownerID, ts: oldMessage.messages.at(-1).createdAt });
    const members = await api(origin, `/rooms/${roomId}/members`);
    const owner = members.find((member: any) => member.sessionID === ownerID);
    const agent = members.find((member: any) => member.sessionID === "agent-twin");
    expect(owner.type).toBe("human");
    expect(agent.type).toBe("agent");
    await page.reload();
    await page.route(`**/rooms/${roomId}/receipts*`, async (route: any) => {
      if (route.request().method() === "POST") {
        const ids = route.request().postDataJSON().messageIDs as string[];
        displayedAcks.push({ ids, visibleIDs: await visibleMessageIDs(page) });
      }
      await route.continue();
    });
    await openRoom(page, roomId);
    const shortTextHeight = await page.locator(`[data-msg-id="${targetMessageID}"] .msg-text p`).evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    expect(shortTextHeight).toBeLessThan(26);
    expect(await page.locator(`[data-msg-id="${ownMessageID}"] .msg-text p`).evaluate((node: HTMLElement) => node.getBoundingClientRect().height)).toBeLessThan(26);
    await refreshReceiptView(page, origin, roomId, ownMessageID);
    const ownReceiptButton = page.locator(`[data-msg-id="${ownMessageID}"] .message-readers`);
    expect(await ownReceiptButton.isVisible()).toBe(true);
    expect(await ownReceiptButton.textContent()).toBe("0");
    expect(await ownReceiptButton.getAttribute("aria-label")).toBe("No readers yet");
    await ownReceiptButton.click();
    expect(await page.locator("#readerCount").textContent()).toBe("No readers yet");
    expect(await page.locator("#readerList li").count()).toBe(0);
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(artifactDir, "chat-own-readers-empty.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.locator("#readerPanel").waitFor({ state: "hidden" });
    const twinA = members.find((member: any) => member.sessionID === "twin-a");
    const ownReceiptWrite = await api(origin, `/rooms/${roomId}/receipts`, "POST", { sessionID: "twin-a", membershipID: twinA.membershipID, messageIDs: [ownMessageID], evidence: "displayed" });
    expect(ownReceiptWrite.acceptedIDs).toContain(ownMessageID);
    const ownReceiptRead = await refreshReceiptView(page, origin, roomId, ownMessageID);
    expect(ownReceiptRead.receipts[0].readers.some((reader: any) => reader.sessionID === "twin-a")).toBe(true);
    await page.waitForFunction((id: string) => document.querySelector(`[data-msg-id="${id}"] .message-readers`)?.textContent === "1", ownMessageID);
    await refreshReceiptView(page, origin, roomId, ownMessageID);
    expect(await ownReceiptButton.textContent()).toBe("1");
    await ownReceiptButton.click();
    await page.locator('#readerList [data-reader-session-id="twin-a"]').waitFor();
    await page.screenshot({ path: path.join(artifactDir, "chat-own-readers-confirmed.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.locator("#btnMembers").click();
    await page.locator('#memberList [data-member-session-id="agent-twin"] .member-activity').waitFor();
    expect(await page.locator('#memberList [data-member-session-id="agent-twin"] .member-activity').textContent()).toBe("Status unknown");
    expect(await page.locator('#memberList [data-member-session-id="twin-a"] .member-activity').count()).toBe(0);
    await api(origin, "/presence", "POST", { ownerID: receiverOwnerID, sequence: 1, sessions: [{ sessionID: "agent-twin", receiverOwnerID, state: "working" }] });
    await page.waitForFunction(() => document.querySelector('#memberList [data-member-session-id="agent-twin"] .member-activity')?.textContent === "Working", null, { timeout: 7000 });
    await page.locator("#btnMembers").click();
    let roomReceipts: any;
    try { roomReceipts = await waitForReader(origin, roomId, targetMessageID, ownerID); }
    catch (error) {
      const state = await page.evaluate(async (url: string) => {
        const { app } = await import(url), room = app.state.room, thread = document.querySelector<HTMLElement>("#thread")!;
        return { room: room?.id, generation: app.state.pollGeneration, members: app.state.memberSessions.get(room?.id), focus: document.hasFocus(), hidden: document.hidden, scroll: [thread.scrollTop, thread.clientHeight, thread.scrollHeight], ids: Array.from(thread.querySelectorAll("[data-msg-id]")).map((node) => (node as HTMLElement).dataset.msgId) };
      }, "/assets/chat/state.js");
      throw new Error(`${error}; client=${JSON.stringify(state)}; requests=${receiptRequests.join(" | ")}`);
    }
    expect(roomReceipts.readers.some((reader: any) => reader.sessionID === ownerID)).toBe(true);
    const visibleIDs = await visibleMessageIDs(page), allReceipts = await api(origin, `/rooms/${roomId}/receipts`);
    const ownerReceiptIDs = allReceipts.receipts.filter((item: any) => item.readers.some((reader: any) => reader.sessionID === ownerID)).map((item: any) => item.messageID).sort();
    for (const ack of displayedAcks) if (!ack.ids.every((id) => ack.visibleIDs.includes(id))) throw new Error(JSON.stringify(ack));
    const hiddenReceipts = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${oldMessageID}`);
    expect(hiddenReceipts.receipts[0].readers.some((reader: any) => reader.sessionID === ownerID)).toBe(false);
    const sameNameReaderIDs = await sameNameReaders(page, origin, roomId, targetMessageID, contextMessageID, members, receiverOwnerID);
    const idleStatus = await refreshesWithoutMessage(page, origin, receiverOwnerID);
    const staleStatus = await staleStatusIsNamedHonestly(page, origin, roomId);
    if (await page.locator("#btnMembers").getAttribute("aria-expanded") !== "true") await page.locator("#btnMembers").click();
    expect(await page.locator("#memberPanel").isVisible()).toBe(true);
    expect(await page.locator(".message-readers:not([hidden])").count()).toBeGreaterThan(0);
    const receiptLayout = await page.locator(`[data-msg-id="${targetMessageID}"]`).evaluate((row: Element) => {
      const bubble = row.querySelector<HTMLElement>(".msg-text")!.getBoundingClientRect();
      const button = row.querySelector<HTMLElement>(".message-readers")!;
      const badge = button.getBoundingClientRect();
      return { size: [badge.width, badge.height], gap: badge.left - bubble.right, overlap: Math.min(badge.bottom, bubble.bottom) - Math.max(badge.top, bubble.top), label: button.getAttribute("aria-label") };
    });
    expect(receiptLayout.size[0]).toBe(24);
    expect(receiptLayout.size[1]).toBe(24);
    expect(receiptLayout.gap).toBeGreaterThanOrEqual(0);
    expect(receiptLayout.gap).toBeLessThan(12);
    expect(receiptLayout.overlap).toBeGreaterThan(0);
    expect(receiptLayout.label).toContain("Read by");
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    const copyButton = page.locator(`[data-msg-id="${targetMessageID}"] .message-copy`);
    expect(await copyButton.locator(".message-copy-icon").count()).toBe(1);
    expect(await copyButton.getAttribute("aria-label")).toBe("复制");
    expect(await page.locator(`[data-msg-id="${targetMessageID}"] .message-readers`).getAttribute("aria-label")).toContain("已读");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
      document.execCommand = (() => false) as typeof document.execCommand;
    });
    await page.locator(`[data-msg-id="${targetMessageID}"] .message-copy`).click();
    await page.waitForFunction((id: string) => document.querySelector(`[data-msg-id="${id}"] .message-copy`)?.textContent === "复制失败，请手动选择并复制消息。", targetMessageID);
    expect(await copyButton.locator(".message-copy-icon").count()).toBe(1);
    expect(await copyButton.getAttribute("aria-label")).toBe("复制失败，请手动选择并复制消息。");
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    const receiptButton = page.locator(`[data-msg-id="${targetMessageID}"] .message-readers`);
    await receiptButton.scrollIntoViewIfNeeded();
    const targetTop = (await page.locator(`[data-msg-id="${targetMessageID}"]`).boundingBox())!.y;
    await receiptButton.click();
    await page.locator("#readerPanel").waitFor({ state: "visible" });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(Math.abs((await page.locator(`[data-msg-id="${targetMessageID}"]`).boundingBox())!.y - targetTop)).toBeLessThan(3);
    expect(await page.locator("#readerList li").count()).toBeGreaterThan(0);
    expect(await page.locator("#readerExcerpt").count()).toBe(0);
    const readerGeometry = () => page.locator("#readerPanel").evaluate((node: HTMLElement) => ({
      height: node.getBoundingClientRect().height,
      children: Array.from(node.children).map((child) => ({ text: child.textContent, height: (child as HTMLElement).getBoundingClientRect().height })),
      rows: Array.from(node.querySelectorAll("#readerList li")).map((row) => ({ text: row.textContent, height: row.getBoundingClientRect().height, spans: Array.from(row.children).map((child) => ({ text: child.textContent, height: (child as HTMLElement).getBoundingClientRect().height })) })),
    }));
    const enReaderGeometry = await readerGeometry();
    await page.keyboard.press("Escape");
    await page.locator("#readerPanel").waitFor({ state: "hidden" });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await receiptButton.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    await receiptButton.click();
    await page.locator("#readerPanel").waitFor({ state: "visible" });
    const zhReaderGeometry = await readerGeometry();
    if (Math.abs(enReaderGeometry.height - zhReaderGeometry.height) > 1) throw new Error(`Reader panel locale geometry differs: ${JSON.stringify({ en: enReaderGeometry, zh: zhReaderGeometry })}`);
    await page.keyboard.press("Escape");
    await page.locator("#readerPanel").waitFor({ state: "hidden" });
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await receiptButton.click();
    await page.locator("#readerPanel").waitFor({ state: "visible" });
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(artifactDir, "chat-receipts-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("#memberPanel").evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator(`[data-msg-id="${targetMessageID}"] .msg-text p`).evaluate((node: HTMLElement) => node.getBoundingClientRect().height)).toBeLessThan(26);
    expect(await page.locator(`[data-msg-id="${ownMessageID}"] .msg-text p`).evaluate((node: HTMLElement) => node.getBoundingClientRect().height)).toBeLessThan(26);
    expect(await page.locator(`[data-msg-id="${contextMessageID}"] .msg-text`).evaluate((node: HTMLElement) => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const mobileReaderButton = page.locator(`[data-msg-id="${targetMessageID}"] .message-readers`);
    await mobileReaderButton.scrollIntoViewIfNeeded();
    if (!await page.locator("#readerPanel").isVisible()) await mobileReaderButton.click();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const mobilePanel = await page.locator("#readerPanel").boundingBox();
    const mobileTrigger = await page.locator(`[data-msg-id="${targetMessageID}"] .message-readers`).boundingBox();
    expect(mobilePanel).not.toBeNull();
    expect(mobileTrigger).not.toBeNull();
    const verticalGap = Math.min(Math.abs(mobilePanel!.y - (mobileTrigger!.y + mobileTrigger!.height)), Math.abs(mobileTrigger!.y - (mobilePanel!.y + mobilePanel!.height)));
    if (verticalGap > 10) throw new Error(JSON.stringify({ mobilePanel, mobileTrigger, verticalGap }));
    expect(mobilePanel!.x).toBeGreaterThanOrEqual(0);
    expect(mobilePanel!.x + mobilePanel!.width).toBeLessThanOrEqual(390);
    expect(mobilePanel!.y + mobilePanel!.height).toBeLessThanOrEqual(844);
    expect(await page.locator("#readerList li").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.screenshot({ path: path.join(artifactDir, "chat-receipts-mobile.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(artifactDir, "chat-receipts-mobile-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.screenshot({ path: path.join(artifactDir, "chat-receipts-desktop-dark.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    const raceRoomId = await staleReceiptFetchCannotWrite(page, roomId, targetMessageID);
    await oldServer404IsQuiet(page, raceRoomId);
    await writeFile(path.join(artifactDir, "chat-receipts-metrics.json"), JSON.stringify({ roomId, visibleIDs, ownerReceiptIDs, displayedAcks, visibleMessageId: targetMessageID, hiddenMessageId: oldMessageID, ownerReceipt: roomReceipts.readers.find((reader: any) => reader.sessionID === ownerID), sameNameReaderIDs, idleStatus, staleStatus }, null, 2));
    await context.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function openRoom(page: any, roomId: string) {
  await page.locator(`#roomListChat [data-room-id="${roomId}"]`).waitFor();
  await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), roomId);
}

async function refreshReceiptView(page: any, origin: string, roomId: string, messageID: string) {
  const result = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${messageID}`);
  await page.evaluate(async ({ url, id, receipts }: { url: string; id: string; receipts: any[] }) => {
    const { app } = await import(url); app.renderReceiptData(id, receipts);
  }, { url: "/assets/chat/state.js", id: roomId, receipts: result.receipts });
  return result;
}

async function sameNameReaders(page: any, origin: string, roomId: string, messageID: string, contextMessageID: string, members: any[], receiverOwnerID: string) {
  for (const [sessionID, evidence] of [["twin-a", "tool"], ["twin-b", "displayed"]]) {
    const member = members.find((item) => item.sessionID === sessionID);
    await api(origin, `/rooms/${roomId}/receipts`, "POST", { sessionID, membershipID: member.membershipID, messageIDs: [messageID], evidence });
  }
  const agent = members.find((item) => item.sessionID === "agent-twin");
  await api(origin, `/rooms/${roomId}/receipts`, "POST", { sessionID: agent.sessionID, membershipID: agent.membershipID, messageIDs: [contextMessageID], evidence: "context", receiverOwnerID });
  await page.locator(`#msgList [data-msg-id="${messageID}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); await app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  const row = page.locator(`#msgList [data-msg-id="${messageID}"]`), trigger = row.locator(".message-readers");
  await trigger.click();
  const readers = page.locator("#readerList");
  await readers.locator('[data-reader-session-id="twin-b"]').waitFor({ state: "attached" });
  expect(await readers.locator("li").count()).toBeGreaterThanOrEqual(2);
  expect(await readers.locator('[data-reader-session-id="agent-twin"]').count()).toBe(0);
  for (const sessionID of ["twin-a", "twin-b"]) {
    expect(await readers.locator(`[data-reader-session-id="${sessionID}"]`).textContent()).toContain(sessionID);
  }
  expect(await readers.locator('[data-reader-session-id="twin-a"]').textContent()).toContain("Fetched with room tool");
  expect(await readers.locator('[data-reader-session-id="twin-b"]').textContent()).toContain("Shown on screen");
  const contextDetails = page.locator(`#msgList [data-msg-id="${contextMessageID}"] .message-readers`);
  await page.locator(`#msgList [data-msg-id="${contextMessageID}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); await app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  await contextDetails.click();
  await readers.locator("li").first().waitFor({ state: "attached" });
  expect(await readers.locator('[data-reader-session-id="agent-twin"]').textContent()).toContain("In agent context");
  await api(origin, `/rooms/${roomId}/leave`, "POST", { sessionID: "twin-a" });
  await page.locator(`#msgList [data-msg-id="${messageID}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); await app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  await trigger.click();
  expect(await readers.locator('[data-reader-session-id="twin-a"]').textContent()).toContain("left");
  return ["twin-a", "twin-b"];
}

async function refreshesWithoutMessage(page: any, origin: string, receiverOwnerID: string) {
  await api(origin, "/presence", "POST", { ownerID: receiverOwnerID, sequence: 2, sessions: [{ sessionID: "agent-twin", receiverOwnerID, state: "waiting" }] });
  await page.waitForFunction(() => document.querySelector('#memberList [data-member-session-id="agent-twin"] .member-activity')?.textContent === "Waiting", null, { timeout: 8000 });
  await api(origin, "/presence", "POST", { ownerID: receiverOwnerID, sequence: 3, sessions: [{ sessionID: "agent-twin", receiverOwnerID, state: "idle" }] });
  await page.waitForFunction(() => document.querySelector('#memberList [data-member-session-id="agent-twin"] .member-activity')?.textContent === "Foreground idle", null, { timeout: 8000 });
  return { waiting: "Waiting", idle: await page.locator('#memberList [data-member-session-id="agent-twin"] .member-activity').textContent() };
}

async function staleStatusIsNamedHonestly(page: any, origin: string, roomId: string) {
  const pattern = `**/rooms/${roomId}/members`;
  await page.route(pattern, async (route: any) => {
    const response = await route.fetch(), members = await response.json();
    const agent = members.find((member: any) => member.sessionID === "agent-twin");
    agent.activity = { state: "offline", observedAt: 0 };
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(members) });
  });
  await page.evaluate(async (url: string) => (await import(url)).app.loadManageableMembers(), "/assets/chat/state.js");
  await page.waitForFunction(() => document.querySelector('#memberList [data-member-session-id="agent-twin"] .member-activity')?.textContent === "Status stale");
  const hint = await page.locator('#memberList [data-member-session-id="agent-twin"] .member-activity').getAttribute("title");
  expect(hint).toContain("does not prove the agent is offline");
  await page.unroute(pattern);
  await page.evaluate(async (url: string) => (await import(url)).app.loadManageableMembers(), "/assets/chat/state.js");
  return { label: "Status stale", hint };
}

async function staleReceiptFetchCannotWrite(page: any, roomId: string, messageID: string) {
  let release!: () => void, memberSeen!: () => void, receiptSeen!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const memberRequest = new Promise<void>((resolve) => { memberSeen = resolve; });
  const receiptRequest = new Promise<void>((resolve) => { receiptSeen = resolve; });
  await page.route(`**/rooms/${roomId}/members`, async (route: any) => {
    const response = await route.fetch(); memberSeen(); await held; await route.fulfill({ response });
  });
  await page.route(`**/rooms/${roomId}/receipts*`, async (route: any) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); receiptSeen(); await held; await route.fulfill({ response });
  });
  await page.locator(`#msgList [data-msg-id="${messageID}"]`).scrollIntoViewIfNeeded();
  await page.locator("#msgInput").focus();
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); void app.loadManageableMembers(); void app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  await Promise.race([Promise.all([memberRequest, receiptRequest]), new Promise((_, reject) => setTimeout(() => reject(new Error("Room member/receipt requests did not start")), 5000))]);
  await page.locator("#btnNewRoom").click();
  await page.locator("#inRoomNameChat").fill("__Test_ReceiptRace");
  await page.locator("#btnCreateChatRoom").click();
  await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_ReceiptRace");
  await page.waitForFunction(() => document.querySelectorAll("#memberList li[data-member-session-id]").length === 1);
  release(); await page.waitForTimeout(100);
  expect(await page.locator(`#msgList [data-msg-id="${messageID}"]`).count()).toBe(0);
  expect(await page.locator('#memberList [data-member-session-id="agent-twin"]').count()).toBe(0);
  expect(await page.locator("#memberList li[data-member-session-id]").count()).toBe(1);
  await page.unroute(`**/rooms/${roomId}/members`);
  await page.unroute(`**/rooms/${roomId}/receipts*`);
  return await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
}

async function oldServer404IsQuiet(page: any, roomId: string) {
  let memberCalls = 0, receiptCalls = 0;
  await page.route(`**/rooms/${roomId}/members`, (route: any) => { memberCalls++; return route.fulfill({ status: 404, contentType: "application/json", body: "{}" }); });
  await page.route(`**/rooms/${roomId}/receipts*`, (route: any) => { receiptCalls++; return route.fulfill({ status: 404, contentType: "application/json", body: "{}" }); });
  await page.evaluate(async (url: string) => {
    const { app } = await import(url); app.state.memberApiUnavailable.delete(app.state.room.id);
    await app.loadManageableMembers();
  }, "/assets/chat/state.js");
  await page.locator("#msgInput").fill("Legacy endpoint probe");
  await page.locator("#btnSend").click();
  await page.locator("#msgList").getByText("Legacy endpoint probe").waitFor();
  await page.waitForFunction(async (url: string) => {
    const { app } = await import(url); return app.state.receiptApiUnavailable.has(app.state.room.id);
  }, "/assets/chat/state.js", { timeout: 5000 });
  await page.waitForTimeout(200);
  const receiptCallsAfter404 = receiptCalls;
  await page.evaluate(async (url: string) => {
    const { app } = await import(url); app.renderMembers(); app.queueReceiptRefresh(); void app.ackVisibleMessages();
  }, "/assets/chat/state.js");
  await page.waitForTimeout(5200);
  expect(memberCalls).toBe(1);
  expect(receiptCallsAfter404).toBeGreaterThan(0);
  expect(receiptCalls).toBe(receiptCallsAfter404);
  await page.unroute(`**/rooms/${roomId}/members`);
  await page.unroute(`**/rooms/${roomId}/receipts*`);
}

async function waitForReader(origin: string, roomId: string, messageID: string, sessionID: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${encodeURIComponent(messageID)}`);
    if (result.receipts[0]?.readers.some((reader: any) => reader.sessionID === sessionID)) return result.receipts[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Visible message did not receive its human display receipt");
}

async function visibleMessageIDs(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>("#thread")!, top = thread.getBoundingClientRect().top + thread.clientTop, bottom = top + thread.clientHeight;
    const overlays = Array.from(document.querySelectorAll<HTMLElement>(".panel:not([hidden]), #mentionPicker:not([hidden]), #railRoomForm:not([hidden])")).map((node) => node.getBoundingClientRect());
    return Array.from(thread.querySelectorAll<HTMLElement>("[data-msg-id]")).filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom && !overlays.some((overlay) => rect.left < overlay.right && rect.right > overlay.left && rect.top < overlay.bottom && rect.bottom > overlay.top);
    }).map((row) => row.dataset.msgId!).sort();
  });
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port");
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
