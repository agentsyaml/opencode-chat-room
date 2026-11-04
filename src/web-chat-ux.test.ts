/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-ux-local-token";

test.skipIf(!browserModule)("chat messages remain selectable and keep reading position", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-ux-"));
  const artifactDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifactDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("UX tester");
    await page.locator("#inRoomName").fill("UX history");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.state.room.id, "/assets/chat/state.js");
    const sessionID = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.LS.sessionID, "/assets/chat/state.js");
    await page.evaluate(async (modulePath: string) => { const { app } = await import(modulePath); app.stopPolling(); clearTimeout(app.state.memberRefreshTimer); }, "/assets/chat/state.js");
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: "ux-peer", participantId: "Peer", participantName: "Peer" });
    let unloadedHistoryID = "";
    for (let index = 0; index < 510; index++) {
      const room = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID, text: `History ${index} ${"word ".repeat(18)}` });
      if (index === 0) unloadedHistoryID = room.messages.at(-1).id;
    }
    expect((await api(origin, `/rooms/${roomId}`)).messages).toHaveLength(500);
    await page.reload();
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).waitFor();
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
    await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), roomId);
    await page.waitForFunction(() => document.querySelectorAll("#msgList .msg").length >= 200);
    const unloadedReceipts = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${unloadedHistoryID}`);
    expect(unloadedReceipts.receipts[0].readers.some((reader: any) => reader.sessionID === sessionID)).toBe(false);
    await dragSelect(page, ".msg.own .msg-text");
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID, text: "| Left | Right |\n| --- | --- |\n| One | Two |\n\n```js\nconst value = 42;\n```" });
    await page.locator(".msg-text table").waitFor();
    await page.locator(".msg-text pre code").waitFor();
    expect(await page.locator("#msgList [data-msg-id]:not(.day-sep)").evaluateAll((rows: Element[]) => rows.every((row) => row.querySelector("[data-copy-message]")))).toBe(true);
    await page.evaluate(() => {
      let copied = "";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
      (window as any).__copiedMessage = () => copied;
    });
    await page.locator(".msg-text table").locator("xpath=ancestor::li[@data-msg-id]").locator("[data-copy-message]").click();
    expect(await page.evaluate(() => (window as any).__copiedMessage())).toBe("| Left | Right |\n| --- | --- |\n| One | Two |\n\n```js\nconst value = 42;\n```");
    expect(await page.locator(".msg-text table").locator("xpath=ancestor::li[@data-msg-id]").locator("[data-copy-message]").textContent()).toBe("Copied");
    const fallback = await page.evaluate(async (url: string) => {
      const { copyTextToClipboard } = await import(url), button = document.querySelector<HTMLElement>(".msg-text table")!.closest("li")!.querySelector<HTMLElement>("[data-copy-message]")!;
      const selection = getSelection()!, range = document.createRange();
      range.selectNodeContents(document.querySelector(".msg-text table")!.closest("li")!.querySelector(".msg-text")!);
      selection.removeAllRanges(); selection.addRange(range); button.focus();
      const selectionBefore = selection.toString(), raw = (button as any)._copyText as string;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
      let legacyText = "";
      document.execCommand = ((command: string) => { if (command === "copy") legacyText = (document.activeElement as HTMLTextAreaElement).value; return true; }) as typeof document.execCommand;
      const copied = await copyTextToClipboard(raw);
      return { copied, legacyText, raw, selectionBefore, selectionAfter: selection.toString(), focused: document.activeElement === button };
    }, "/assets/chat/markdown.js");
    expect(fallback.copied).toBe(true);
    expect(fallback.legacyText).toBe(fallback.raw);
    expect(fallback.selectionAfter).toBe(fallback.selectionBefore);
    expect(fallback.focused).toBe(true);
    await page.evaluate(() => { document.execCommand = (() => false) as typeof document.execCommand; });
    await page.locator(".msg-text table").locator("xpath=ancestor::li[@data-msg-id]").locator("[data-copy-message]").click();
    await page.waitForFunction(() => document.querySelector(".msg-text table")?.closest("li")?.querySelector("[data-copy-message]")?.textContent === "Could not copy. Select and copy the message manually.");
    const systemLayout = await page.evaluate(async (url: string) => {
      const { app } = await import(url), row = app.renderMessage({ id: "copy-system-fixture", senderId: "system", text: "UX system copy fixture", createdAt: Date.now() }, false);
      document.querySelector("#msgList")!.append(row);
      const text = row.querySelector("span")!.getBoundingClientRect(), copy = row.querySelector("[data-copy-message]")!.getBoundingClientRect();
      row.remove();
      return { textBottom: text.bottom, copyTop: copy.top };
    }, "/assets/chat/state.js");
    expect(systemLayout.copyTop).toBeGreaterThanOrEqual(systemLayout.textBottom);
    await checkSelection(page, ".msg-text table");
    await checkSelection(page, ".msg-text pre code");
    await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = 12000; });
    await page.waitForTimeout(250);
    const before = await visibleAnchor(page);
    await page.screenshot({ path: path.join(artifactDir, "chat-ux-history-before-incoming.png") });
    const incoming = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "ux-peer", text: "Peer incoming" });
    const incomingID = incoming.messages.at(-1).id;
    await page.locator("#msgList").getByText("Peer incoming").waitFor({ timeout: 10000 });
    const after = await visibleAnchor(page);
    expect(after.id).toBe(before.id);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(12);
    const historySelectionAfterPoll = await dragSelect(page, `#msgList [data-msg-id="${after.id}"] .msg-text`);
    expect(historySelectionAfterPoll).toContain("word");
    await waitForReader(origin, roomId, before.id, sessionID);
    const incomingReceipts = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${incomingID}`);
    expect(incomingReceipts.receipts[0].readers.some((reader: any) => reader.sessionID === sessionID)).toBe(false);
    await page.screenshot({ path: path.join(artifactDir, "chat-ux-history-after-incoming.png") });
    await page.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
    const metadataTail = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "ux-peer", text: "Metadata rerender tail" });
    const metadataTailID = metadataTail.messages.at(-1).id, metadataBefore = await visibleAnchor(page);
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url), updated = await app.api(`/rooms/${encodeURIComponent(id)}`);
      app.state.room.messages = updated.messages;
      app.rerenderMessages();
    }, { url: "/assets/chat/state.js", id: roomId });
    await page.waitForTimeout(50);
    const metadataAfter = await visibleAnchor(page), metadataReceipts = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${metadataTailID}`);
    expect(metadataAfter.id).toBe(metadataBefore.id);
    expect(Math.abs(metadataAfter.top - metadataBefore.top)).toBeLessThanOrEqual(2);
    expect(metadataReceipts.receipts[0].readers.some((reader: any) => reader.sessionID === sessionID)).toBe(false);
    const transientReplay = await replaySynchronousAck(page);
    expect(transientReplay.transientIDs).toContain(metadataTailID);
    expect(transientReplay.finalVisibleIDs).not.toContain(metadataTailID);
    await page.evaluate(async (url: string) => (await import(url)).app.startPolling(), "/assets/chat/state.js");
    await dragSelect(page, ".msg:not(.own) .msg-text");
    await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = thread.scrollHeight; });
    await page.waitForFunction(() => { const n = document.querySelector<HTMLElement>("#thread")!; return n.scrollHeight - n.scrollTop - n.clientHeight <= 2; });
    const beforeTallGap = await page.evaluate(() => { const n = document.querySelector<HTMLElement>("#thread")!; return n.scrollHeight - n.scrollTop - n.clientHeight; });
    await page.evaluate(async (url: string) => {
      const { app } = await import(url), render = app.renderMessages;
      app.renderMessages = (live = false) => {
        const isTall = app.state.room.messages.some((message: any) => message.text.startsWith("Tall incoming"));
        const thread = document.querySelector<HTMLElement>("#thread")!, before = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
        const result = render(live);
        if (isTall) {
          const firstId = (app.state.room.messages[0] || {}).id;
          (window as any).__chatScrollMetrics = { before, immediate: thread.scrollHeight - thread.scrollTop - thread.clientHeight, firstId };
          requestAnimationFrame(() => { (window as any).__chatScrollMetrics.final = thread.scrollHeight - thread.scrollTop - thread.clientHeight; });
        }
        return result;
      };
    }, "/assets/chat/state.js");
    const tallText = `Tall incoming ${"\nLine of new content".repeat(24)}`;
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: "ux-peer", text: tallText });
    await page.locator("#msgList .msg-text").filter({ hasText: "Tall incoming" }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(100);
    const scrollMetrics = await page.evaluate(() => (window as any).__chatScrollMetrics), bottomGap = await page.evaluate(() => { const n = document.querySelector<HTMLElement>("#thread")!; return n.scrollHeight - n.scrollTop - n.clientHeight; });
    const newestVisible = await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!, row = Array.from(document.querySelectorAll<HTMLElement>("#msgList .msg")).at(-1)!, edge = thread.getBoundingClientRect(), rect = row.getBoundingClientRect(); return rect.bottom <= edge.bottom + 1 && rect.bottom > edge.top; });
    if (bottomGap > 2) throw new Error(`New incoming message did not stay at bottom: ${JSON.stringify({ beforeTallGap, bottomGap, scrollMetrics })}`);
    expect(newestVisible).toBe(true);
    await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!, row = document.querySelectorAll<HTMLElement>("#msgList .msg")[200]!;
      thread.scrollTop += row.getBoundingClientRect().top - thread.getBoundingClientRect().top - 8;
    });
    const trimBefore = await visibleAnchor(page);
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath), messages = app.state.room.messages;
      const time = messages.at(-1).createdAt;
      for (let i = 0; i < 110; i++) messages.push({ id: `ux-trim-${i}`, roomId: app.state.room.id, senderId: app.state.myName, senderSessionID: app.LS.sessionID, createdAt: time + i + 1, text: `Trim ${i}` });
      app.renderMessages(true);
    }, "/assets/chat/state.js");
    const trimAfter = await visibleAnchor(page);
    expect(trimAfter.id).toBe(trimBefore.id);
    expect(Math.abs(trimAfter.top - trimBefore.top)).toBeLessThanOrEqual(2);
    await page.evaluate(() => { document.querySelector<HTMLElement>("#thread")!.scrollTop = 2500; });
    const savedTop = await page.locator("#thread").evaluate((n: HTMLElement) => n.scrollTop);
    await page.locator("#btnNewRoom").click();
    await page.locator("#inRoomNameChat").fill("UX second");
    await page.locator("#btnCreateChatRoom").click();
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "UX second");
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
    await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), roomId);
    expect(Math.abs(await page.locator("#thread").evaluate((n: HTMLElement) => n.scrollTop) - savedTop)).toBeLessThan(5);
    const alignment = await page.evaluate(() => {
      const messages = document.querySelector("#msgList")!.getBoundingClientRect();
      const composer = document.querySelector(".composer-row")!.getBoundingClientRect();
      return { x: Math.abs(messages.left - composer.left), width: Math.abs(messages.width - composer.width) };
    });
    expect(alignment.x).toBeLessThan(2);
    expect(alignment.width).toBeLessThan(2);
    await page.screenshot({ path: path.join(artifactDir, "chat-ux-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("#thread").evaluate((n: HTMLElement) => n.scrollWidth <= n.clientWidth)).toBe(true);
    await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = 0; });
    await page.screenshot({ path: path.join(artifactDir, "chat-ux-mobile.png"), fullPage: true });
    await writeFile(path.join(artifactDir, "chat-ux-metrics.json"), JSON.stringify({ beforeTallGap, bottomGap, newestVisible, scrollMetrics, historySelectionAfterPoll, historyAnchorBefore: before, historyAnchorAfter: after, metadataAnchorBefore: metadataBefore, metadataAnchorAfter: metadataAfter, metadataTailID, transientAckWouldReadTail: transientReplay.transientIDs.includes(metadataTailID), tailVisibleAfterReplay: transientReplay.finalVisibleIDs.includes(metadataTailID), transientReplay, trimAnchorBefore: trimBefore, trimAnchorAfter: trimAfter, anchoredReaderReceipt: before.id, incomingTailReceiptCount: incomingReceipts.receipts[0].readers.length, metadataTailReceiptCount: metadataReceipts.receipts[0].readers.length, unloadedHistoryID, unloadedReceiptCount: unloadedReceipts.receipts[0].readers.length }, null, 2));
    await context.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function checkSelection(page: any, selector: string) {
  const result = await page.locator(selector).first().evaluate((node: HTMLElement) => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    return { text: selection.toString(), userSelect: getComputedStyle(node).userSelect };
  });
  expect(result.text.length).toBeGreaterThan(10);
  expect(result.userSelect).not.toBe("none");
}

async function dragSelect(page: any, selector: string) {
  const bubble = page.locator(selector).first();
  await bubble.scrollIntoViewIfNeeded();
  const points = await bubble.evaluate((element: HTMLElement) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const text = nodes.map((node) => node.data).join(""), start = Math.min(8, Math.floor(text.length / 4)), end = Math.min(text.length - 1, start + 80);
    const at = (offset: number, trailing: boolean) => {
      let base = 0;
      for (const node of nodes) {
        if (offset < base + node.length) {
          const range = document.createRange(), index = offset - base;
          range.setStart(node, index); range.setEnd(node, Math.min(index + 1, node.length));
          const rect = range.getBoundingClientRect();
          return { x: trailing ? rect.right - .5 : rect.left + .5, y: rect.top + rect.height / 2 };
        }
        base += node.length;
      }
      throw new Error("Message text is too short to select");
    };
    return { start: at(start, false), end: at(end, true) };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 18 });
  await page.mouse.up();
  const text = await page.evaluate(() => getSelection()?.toString() || "");
  expect(text.length).toBeGreaterThan(2);
  return text;
}

async function visibleAnchor(page: any) {
  return page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>("#thread")!, edge = thread.getBoundingClientRect();
    const row = Array.from(document.querySelectorAll<HTMLElement>("#msgList .msg")).find((node) => node.getBoundingClientRect().bottom > edge.top)!;
    return { id: row.dataset.msgId, top: Math.round(row.getBoundingClientRect().top - edge.top) };
  });
}

async function replaySynchronousAck(page: any) {
  return page.evaluate(async (url: string) => {
    const { app } = await import(url), originalApi = app.api, originalRender = app.renderMessages;
    let transientIDs: string[] = [];
    app.api = async (route: string, options: any = {}) => {
      if (route.endsWith("/receipts") && options.method === "POST") {
        transientIDs = JSON.parse(options.body).messageIDs;
        return { acceptedIDs: [] };
      }
      return originalApi(route, options);
    };
    app.renderMessages = (live = false) => {
      const result = originalRender(live);
      void app.ackVisibleMessages();
      return result;
    };
    const thread = document.querySelector<HTMLElement>("#thread")!;
    thread.scrollTop = thread.scrollHeight / 2;
    const edge = thread.getBoundingClientRect();
    const anchor = Array.from(thread.querySelectorAll<HTMLElement>("#msgList .msg")).find((node) => node.getBoundingClientRect().bottom > edge.top)!;
    const anchorID = anchor.dataset.msgId;
    try {
      app.rerenderMessages();
      const finalAnchor = thread.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(anchorID!)}"]`);
      return { transientIDs, anchorID, anchorTop: Math.round(finalAnchor!.getBoundingClientRect().top - edge.top), finalVisibleIDs: Array.from(thread.querySelectorAll<HTMLElement>("[data-msg-id]")).filter((node) => node.getBoundingClientRect().bottom > edge.top && node.getBoundingClientRect().top < edge.bottom).map((node) => node.dataset.msgId) };
    } finally { app.api = originalApi; app.renderMessages = originalRender; }
  }, "/assets/chat/state.js");
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

async function waitForReader(origin: string, roomId: string, messageID: string, sessionID: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await api(origin, `/rooms/${roomId}/receipts?messageIDs=${encodeURIComponent(messageID)}`);
    if (result.receipts[0]?.readers.some((reader: any) => reader.sessionID === sessionID)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("A visible history message did not receive its display receipt");
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
