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
const duplicateName = "Mira-Celeste Fontaine-Worthington";

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
    await page.locator("#inRoomName").fill("Receipts room");
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
    const contextMessage = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "twin-b", text: "Context receipt with wide content\n\n| Item | Status | Detail | Owner | Updated | Source |\n| --- | --- | --- | --- | --- | --- |\n| Queue | Waiting | Long text scrolls horizontally on small screens | Mira | Today | Room |\n\n```js\nconst longIdentifier = 'selection-and-receipt-layout-regression';\nconsole.log(longIdentifier);\n```" });
    const oldMessageID = oldMessage.messages.at(-1).id, targetMessageID = target.messages.at(-1).id;
    const contextMessageID = contextMessage.messages.at(-1).id;
    await api(origin, "/queued", "POST", { roomId, sessionID: ownerID, ts: oldMessage.messages.at(-1).createdAt });
    await page.route(`**/rooms/${roomId}/receipts*`, async (route: any) => {
      if (route.request().method() === "POST") {
        const ids = route.request().postDataJSON().messageIDs as string[];
        displayedAcks.push({ ids, visibleIDs: await visibleMessageIDs(page) });
      }
      await route.continue();
    });
    const members = await api(origin, `/rooms/${roomId}/members`);
    const owner = members.find((member: any) => member.sessionID === ownerID);
    const agent = members.find((member: any) => member.sessionID === "agent-twin");
    expect(owner.type).toBe("human");
    expect(agent.type).toBe("agent");
    await page.reload();
    await openRoom(page, roomId);
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
    for (const ack of displayedAcks) expect(ack.ids.every((id) => ack.visibleIDs.includes(id))).toBe(true);
    const hiddenReceipts = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${oldMessageID}`);
    expect(hiddenReceipts.receipts[0].readers.some((reader: any) => reader.sessionID === ownerID)).toBe(false);
    const sameNameReaderIDs = await sameNameReaders(page, origin, roomId, targetMessageID, contextMessageID, members, receiverOwnerID);
    const idleStatus = await refreshesWithoutMessage(page, origin, receiverOwnerID);
    const staleStatus = await staleStatusIsNamedHonestly(page, origin, roomId);
    if (await page.locator("#btnMembers").getAttribute("aria-expanded") !== "true") await page.locator("#btnMembers").click();
    expect(await page.locator("#memberPanel").isVisible()).toBe(true);
    expect(await page.locator(".message-readers[open]").count()).toBeGreaterThan(0);
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(artifactDir, "chat-receipts-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("#memberPanel").evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.evaluate((id: string) => {
      const thread = document.querySelector<HTMLElement>("#thread")!, row = document.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!;
      thread.scrollTop += row.getBoundingClientRect().top - 440;
    }, targetMessageID);
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
  const row = page.locator(`#msgList [data-msg-id="${messageID}"]`), details = row.locator(".message-readers");
  await details.locator('[data-reader-session-id="twin-b"]').waitFor({ state: "attached" });
  expect(await details.locator(".receipt-reader-list li").count()).toBeGreaterThanOrEqual(2);
  expect(await details.locator('[data-reader-session-id="agent-twin"]').count()).toBe(0);
  await details.locator("summary").click();
  for (const sessionID of ["twin-a", "twin-b"]) {
    expect(await details.locator(`[data-reader-session-id="${sessionID}"]`).textContent()).toContain(sessionID);
  }
  expect(await details.locator('[data-reader-session-id="twin-a"]').textContent()).toContain("Fetched with room tool");
  expect(await details.locator('[data-reader-session-id="twin-b"]').textContent()).toContain("Shown on screen");
  const contextDetails = page.locator(`#msgList [data-msg-id="${contextMessageID}"] .message-readers`);
  await page.locator(`#msgList [data-msg-id="${contextMessageID}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); await app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  await contextDetails.locator(".receipt-reader-list li").first().waitFor({ state: "attached" });
  await contextDetails.locator("summary").click();
  expect(await contextDetails.locator('[data-reader-session-id="agent-twin"]').textContent()).toContain("not proof of understanding");
  await api(origin, `/rooms/${roomId}/leave`, "POST", { sessionID: "twin-a" });
  await page.evaluate(async ({ modulePath, id }: { modulePath: string; id: string }) => {
    const { app } = await import(modulePath); await app.loadVisibleReceipts(id, app.state.pollGeneration);
  }, { modulePath: "/assets/chat/state.js", id: roomId });
  expect(await details.locator('[data-reader-session-id="twin-a"]').textContent()).toContain("left");
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
  await page.locator("#inRoomNameChat").fill("Race room");
  await page.locator("#btnCreateChatRoom").click();
  await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Race room");
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
