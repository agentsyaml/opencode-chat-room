/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-selection-local-token";

test.skipIf(!browserModule)("browser selects own and peer message text", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-selection-"));
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
    await useAssetFixture(page, process.env.CHAT_UI_ASSET_FIXTURE_DIR);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Selection tester");
    await page.locator("#inRoomName").fill("Selection room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    const sessionID = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");
    const shortText = "Own message with ordinary selectable text.";
    await send(page, shortText);
    const longText = Array.from({ length: 14 }, (_, index) => `OWN-LINE-${index} ${"select these words ".repeat(6)}`).join(" ");
    await send(page, longText);
    await send(page, "```js\nconst selectableCode = 'own message';\nconsole.log(selectableCode);\n```", "selectableCode");
    const shortSelection = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("Own message with ordinary")) .msg-text`, 6, 32);
    const longSelection = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("OWN-LINE-0")) .msg-text`, 24, 250);
    const leftEdgeSelection = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("OWN-LINE-0")) .msg-text`, 0, 60);
    const rightEdgeSelection = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("OWN-LINE-0")) .msg-text`, 64, 124);
    const reverseSelection = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("OWN-LINE-0")) .msg-text`, 300, 60);
    const codeSelection = await dragSelect(page, ".msg.own .msg-text pre code", 3, 35);
    const selectedBeforePoll = await dragSelect(page, `[data-msg-id]:has(.msg-text:has-text("OWN-LINE-0")) .msg-text`, 90, 220);
    const peerSession = `selection-peer-${Date.now()}`;
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: peerSession, participantId: "Selection peer", participantName: "Selection peer" });
    await page.locator("#msgList").getByText("Selection peer joined the room").waitFor({ timeout: 10000 });
    expect(await page.evaluate(() => getSelection()?.toString() || "")).toBe(selectedBeforePoll.text);
    const peerText = `PEER-LINE ${"peer words remain selectable ".repeat(36)}`;
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerSession, text: peerText });
    await page.locator("#msgList").getByText("PEER-LINE").waitFor({ timeout: 10000 });
    const afterPollSelection = await page.evaluate(() => getSelection()?.toString() || "");
    expect(afterPollSelection).toBe(selectedBeforePoll.text);
    const peerSelection = await dragSelect(page, ".msg:not(.own) .msg-text", 12, 190);
    expect(shortSelection.text).toContain("ordinary");
    expect(longSelection.text).toContain("OWN-LINE");
    expect(leftEdgeSelection.text).toContain("OWN-LINE");
    expect(rightEdgeSelection.text.length).toBeGreaterThan(40);
    expect(reverseSelection.text).toContain("OWN-LINE");
    expect(codeSelection.text).toContain("selectableCode");
    expect(peerSelection.text).toContain("peer words");
    await page.screenshot({ path: path.join(artifactDir, "edge-own-message-selection.png") });
    await writeFile(path.join(artifactDir, "edge-own-message-selection.json"), JSON.stringify({ shortSelection, longSelection, leftEdgeSelection, rightEdgeSelection, reverseSelection, codeSelection, selectedBeforePoll, peerSelection, afterPollSelection, edgeExecutable: process.env.CHAT_UI_BROWSER_EXECUTABLE, assetFixture: process.env.CHAT_UI_ASSET_FIXTURE_DIR || "working tree" }, null, 2));
    await page.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
    let retainedID = "";
    for (let index = 0; index < 510; index++) {
      const text = index === 250 ? `LIVE-OWN-KEEP-250 ${"selection survives window updates ".repeat(4)}` : `Live history ${index} ${"retained words ".repeat(8)}`;
      const room = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID, text });
      if (index === 250) retainedID = room.messages.at(-1).id;
    }
    await page.reload();
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).waitFor();
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
    await page.locator(`#msgList [data-msg-id="${retainedID}"] .msg-text`).waitFor();
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.polling, "/assets/chat/state.js");
    const shiftEvidence = await selectionWindowShifts(page, origin, roomId, sessionID, peerSession, retainedID, artifactDir);
    await writeFile(path.join(artifactDir, "edge-live-selection-window-shifts.json"), JSON.stringify(shiftEvidence, null, 2));
    await context.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function useAssetFixture(page: any, fixture?: string) {
  if (!fixture) return;
  await page.route("**/chat", (route: any) => route.fulfill({ path: path.join(fixture, "chat.html") }));
  await page.route("**/assets/**", (route: any) => {
    const file = path.resolve(fixture, new URL(route.request().url()).pathname.slice(1));
    return file.startsWith(`${path.resolve(fixture)}${path.sep}`) && existsSync(file)
      ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "Missing mirrored asset" });
  });
}

async function send(page: any, text: string, renderedText = text.slice(0, 24)) {
  await page.locator("#msgInput").fill(text);
  await page.locator("#btnSend").click();
  await page.locator("#msgList .msg-text").filter({ hasText: renderedText }).waitFor();
}

async function selectionWindowShifts(page: any, origin: string, roomId: string, sessionID: string, peerID: string, targetID: string, artifactDir: string) {
  const selector = `#msgList [data-msg-id="${targetID}"] .msg-text`, target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const textLength = await target.evaluate((node: HTMLElement) => node.textContent!.trimEnd().length);
  const full = await dragSelect(page, selector, 0, textLength - 1);
  expect(full.text).toContain("LIVE-OWN-KEEP-250");
  await page.evaluate((id: string) => { (window as any).__retainedRow = document.querySelector(`#msgList [data-msg-id="${id}"]`); }, targetID);
  await page.screenshot({ path: path.join(artifactDir, "edge-live-own-before-poll.png") });
  const fullPollText = "LIVE-POLL-FULL-1";
  const fullPoll = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerID, text: fullPollText });
  await page.locator("#msgList").getByText(fullPollText).waitFor({ timeout: 15000 });
  const fullAfter = await selectionText(page), fullSameNode = await sameRetainedRow(page, targetID);
  await writeFile(path.join(artifactDir, "edge-live-full-poll-metrics.json"), JSON.stringify({ fullBefore: full.text, fullAfter, fullSameNode }, null, 2));
  await page.screenshot({ path: path.join(artifactDir, "edge-live-own-after-poll.png") });
  expect(fullAfter).toBe(full.text);
  expect(fullSameNode).toBe(true);
  return heldAndTrimSelection(page, origin, roomId, sessionID, peerID, targetID, selector, textLength, fullPollText, fullPoll.messages.at(-1).id, fullAfter, artifactDir);
}

async function selectionText(page: any) {
  return page.evaluate(() => getSelection()?.toString() || "");
}

async function sameRetainedRow(page: any, id: string) {
  return page.evaluate((target: string) => (window as any).__retainedRow === document.querySelector(`#msgList [data-msg-id="${target}"]`), id);
}

async function heldAndTrimSelection(page: any, origin: string, roomId: string, sessionID: string, peerID: string, targetID: string, selector: string, textLength: number, fullPollText: string, fullPollID: string, fullAfter: string, artifactDir: string) {
  const start = await textPoint(page, selector, 0), firstEnd = await textPoint(page, selector, 70, true);
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(firstEnd.x, firstEnd.y, { steps: 18 });
  const heldBefore = await selectionText(page);
  expect(heldBefore).toContain("LIVE-OWN-KEEP-250");
  await page.evaluate((id: string) => { (window as any).__retainedRow = document.querySelector(`#msgList [data-msg-id="${id}"]`); }, targetID);
  await page.screenshot({ path: path.join(artifactDir, "edge-live-held-before-poll.png") });
  const heldPollText = "LIVE-POLL-HELD-2";
  const heldPoll = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerID, text: heldPollText });
  await page.locator("#msgList").getByText(heldPollText).waitFor({ timeout: 15000 });
  const heldAfterPoll = await selectionText(page), heldSameNode = await sameRetainedRow(page, targetID);
  expect(heldAfterPoll).toBe(heldBefore);
  expect(heldSameNode).toBe(true);
  const continued = await textPoint(page, selector, Math.min(125, textLength - 1), true);
  await page.mouse.move(continued.x, continued.y, { steps: 12 }); await page.mouse.up();
  const heldAfterMouseUp = await selectionText(page);
  expect(heldAfterMouseUp).toContain("LIVE-OWN-KEEP-250");
  expect(heldAfterMouseUp).not.toContain("Live history 251");
  await page.screenshot({ path: path.join(artifactDir, "edge-live-held-after-poll-mouseup.png") });
  const peerIDSelector = `#msgList [data-msg-id="${fullPollID}"] .msg-text`;
  const peerLength = await page.locator(peerIDSelector).evaluate((node: HTMLElement) => node.textContent!.trimEnd().length);
  const peer = await dragSelect(page, peerIDSelector, 0, Math.min(8, peerLength - 1));
  expect(peer.text).toContain("LIVE-POLL");
  await page.evaluate((id: string) => { (window as any).__retainedRow = document.querySelector(`#msgList [data-msg-id="${id}"]`); }, fullPollID);
  await page.screenshot({ path: path.join(artifactDir, "edge-live-peer-before-poll.png") });
  const nextPeerText = "LIVE-POLL-PEER-3";
  await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerID, text: nextPeerText });
  await page.locator("#msgList").getByText(nextPeerText).waitFor({ timeout: 15000 });
  const peerAfter = await selectionText(page), peerSameNode = await sameRetainedRow(page, fullPollID);
  expect(peerAfter).toBe(peer.text);
  expect(peerSameNode).toBe(true);
  await page.screenshot({ path: path.join(artifactDir, "edge-live-peer-after-poll.png") });
  return repeatedShifts(page, origin, roomId, sessionID, peerID, targetID, selector, fullAfter, heldBefore, heldAfterPoll, heldSameNode, heldAfterMouseUp, fullPollText, peer.text, peerAfter, peerSameNode, artifactDir);
}

async function repeatedShifts(page: any, origin: string, roomId: string, sessionID: string, peerID: string, targetID: string, selector: string, fullAfter: string, heldBefore: string, heldAfterPoll: string, heldSameNode: boolean, heldAfterMouseUp: string, fullPollText: string, peerBefore: string, peerAfter: string, peerSameNode: boolean, artifactDir: string) {
  const full = await dragSelect(page, selector, 0, (await page.locator(selector).textContent())!.trimEnd().length - 1);
  await page.evaluate((id: string) => { (window as any).__retainedRow = document.querySelector(`#msgList [data-msg-id="${id}"]`); }, targetID);
  const before = await snapshotWindow(page, targetID);
  await page.evaluate(async (url: string) => { const { app } = await import(url); app.stopPolling(); clearTimeout(app.state.memberRefreshTimer); }, "/assets/chat/state.js");
  for (let index = 0; index < 100; index++) {
    const text = `LIVE-TRIM-${index}`;
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerID, text: `${text} ${"batch window shift ".repeat(3)}` });
  }
  await page.evaluate(async (url: string) => (await import(url)).app.startPolling(), "/assets/chat/state.js");
  await page.locator("#msgList").getByText("LIVE-TRIM-99").waitFor({ timeout: 30000 });
  const firstBurst = await snapshotWindow(page, targetID);
  expect(firstBurst.domChildCount).toBeGreaterThan(400);
  const after = firstBurst;
  expect(full.text).toContain("LIVE-OWN-KEEP-250");
  expect(after.firstMessageId).not.toBe(before.firstMessageId);
  expect(after.roomMessageCount).toBe(500);
  expect(after.domChildCount).toBeGreaterThan(400);
  expect(after.targetExists).toBe(true);
  expect(after.sameTargetNode).toBe(true);
  expect(Math.abs(after.targetTop! - before.targetTop!)).toBeLessThan(3);
  expect(after.selection).toBe(full.text);
  expect(peerBefore).toContain("LIVE-POLL");
  expect(peerAfter).toBe(peerBefore);
  expect(heldSameNode).toBe(true);
  expect(peerSameNode).toBe(true);
  await page.screenshot({ path: path.join(artifactDir, "edge-live-held-across-400-row-trim.png") });
  return { ownerSessionID: sessionID, fullAfterFirstPoll: fullAfter, heldBefore, heldDuringPoll: heldAfterPoll, heldSameNode, heldAfterMouseUp, peerBefore, peerAfter, peerSameNode, fullBeforeBurst: full.text, burstBefore: before, burstAt400: firstBurst, burstAfter: after, fullPollText };
}

async function textPoint(page: any, selector: string, offset: number, trailing = false) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element: HTMLElement, args: { offset: number; trailing: boolean }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let base = 0;
    for (const node of nodes) {
      if (args.offset < base + node.length) {
        const range = document.createRange(), index = args.offset - base;
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        return { x: args.trailing ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2 };
      }
      base += node.length;
    }
    throw new Error(`Cannot locate text offset ${args.offset}`);
  }, { offset, trailing });
}

async function snapshotWindow(page: any, id: string) {
  return page.evaluate(async ({ targetID, url }: { targetID: string; url: string }) => {
    const { app } = await import(url), row = document.querySelector(`#msgList [data-msg-id="${targetID}"]`);
    return { selection: getSelection()?.toString() || "", firstMessageId: app.state.room.messages[0]?.id, roomMessageCount: app.state.room.messages.length, domChildCount: document.querySelector("#msgList")!.children.length, targetExists: Boolean(row), targetTop: row?.getBoundingClientRect().top, sameTargetNode: (window as any).__retainedRow === row };
  }, { targetID: id, url: "/assets/chat/state.js" });
}

async function dragSelect(page: any, selector: string, start: number, end: number) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const points = await target.evaluate((element: HTMLElement, bounds: { start: number; end: number }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const text = nodes.map((node) => node.data).join("");
    function point(offset: number, trailing: boolean) {
      let base = 0;
      for (const node of nodes) {
        if (offset < base + node.length) {
          const range = document.createRange(), index = offset - base;
          range.setStart(node, index); range.setEnd(node, Math.min(index + 1, node.length));
          const rect = range.getBoundingClientRect();
          const x = trailing ? rect.right - 0.5 : rect.left + 0.5, y = rect.top + rect.height / 2;
          return { x, y };
        }
        base += node.length;
      }
      throw new Error(`Text offset ${offset} is outside the message`);
    }
    const styles = [];
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const pseudo = (selector: string) => { const value = getComputedStyle(node!, selector); return { content: value.content, pointerEvents: value.pointerEvents, userSelect: value.userSelect }; };
      styles.push({ tag: node.tagName, className: node.className, userSelect: style.userSelect, webkitUserSelect: style.webkitUserSelect, pointerEvents: style.pointerEvents, touchAction: style.touchAction, transform: style.transform, animationName: style.animationName, animationFillMode: style.animationFillMode, before: pseudo("::before"), after: pseudo("::after") });
      if (node.tagName === "BODY") break;
    }
    const thread = element.closest<HTMLElement>("#thread")!, edge = thread.getBoundingClientRect();
    const top = edge.top + thread.clientTop + 4, bottom = edge.bottom - thread.clientTop - 4;
    let first = point(bounds.start, false), last = point(bounds.end, true);
    if (Math.min(first.y, last.y) < top) thread.scrollTop += Math.min(first.y, last.y) - top;
    first = point(bounds.start, false); last = point(bounds.end, true);
    if (Math.max(first.y, last.y) > bottom) thread.scrollTop += Math.max(first.y, last.y) - bottom;
    first = point(bounds.start, false); last = point(bounds.end, true);
    for (const [offset, point] of [[bounds.start, first], [bounds.end, last]] as const) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !element.contains(hit)) throw new Error(`Selection offset ${offset} hit outside message text: ${hit?.tagName}.${(hit as HTMLElement | null)?.className}`);
    }
    return { start: first, end: last, expected: text.slice(Math.min(bounds.start, bounds.end), Math.max(bounds.start, bounds.end)), text, styles };
  }, { start, end });
  await page.evaluate(() => {
    (window as any).__selectionTrace = [];
    for (const type of ["pointerdown", "pointerup", "mouseup"]) document.addEventListener(type, (event) => {
      const pointer = event as MouseEvent;
      (window as any).__selectionTrace.push({ type, targetTag: (event.target as HTMLElement)?.tagName, targetClass: (event.target as HTMLElement)?.className, x: pointer.clientX, y: pointer.clientY, selectionLength: getSelection()?.toString().length || 0 });
    }, { once: true });
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.evaluate(() => {
    for (const type of ["pointermove", "mousemove"]) document.addEventListener(type, (event) => {
      const pointer = event as MouseEvent;
      (window as any).__selectionTrace.push({ type, targetTag: (event.target as HTMLElement)?.tagName, targetClass: (event.target as HTMLElement)?.className, x: pointer.clientX, y: pointer.clientY, selectionLength: getSelection()?.toString().length || 0 });
    }, { once: true });
  });
  await page.mouse.move(points.end.x, points.end.y, { steps: 18 });
  await page.mouse.up();
  const result = await page.evaluate(() => ({ text: getSelection()?.toString() || "", trace: (window as any).__selectionTrace }));
  expect(result.text.length).toBeGreaterThan(8);
  const withinTarget = await target.evaluate((element: HTMLElement) => {
    const selection = getSelection();
    return Boolean(selection?.anchorNode && selection.focusNode && element.contains(selection.anchorNode) && element.contains(selection.focusNode));
  });
  expect(withinTarget).toBe(true);
  return { text: result.text, expected: points.expected, textLength: points.text.length, styles: points.styles, start: points.start, end: points.end, trace: result.trace, withinTarget };
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
