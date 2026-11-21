/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-image-zoom-test-token";
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#22695c"/></svg>');
const smallSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7c4dff"/></svg>');

test.skipIf(!browserModule)("clicking a message image opens the overlay, zooms with the wheel, and closes without moving the thread", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-zoom-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.route(`${origin}/zoom.svg`, (route: any) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }));
    await page.route(`${origin}/small.svg`, (route: any) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: smallSvg }));
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_ZoomOwner");
    await page.locator("#inRoomName").fill("__Test_ZoomRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    for (let index = 0; index < 10; index++) await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: room.sessionID, text: `__Test_zoom_filler ${index}\n${"Filler line for height.\n".repeat(3)}` });
    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: room.sessionID, text: `__Test_zoom_image\n\n![zoom](${origin}/zoom.svg)` });
    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: room.sessionID, text: `__Test_zoom_small\n\n![small](${origin}/small.svg)` });
    await page.locator("#msgList img").first().waitFor();
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>("#msgList img"); return Boolean(img?.complete && img.naturalWidth); });
    const scrollTop = () => page.evaluate(() => document.querySelector<HTMLElement>("#thread")!.scrollTop);
    // One click anywhere in the thread can make the app re-anchor its read receipts;
    // take that first hit, then measure whether the overlay itself moves anything.
    await page.locator("#msgList img").first().click();
    await page.locator("#imageDialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(400);
    const before = { scrollTop: await scrollTop(), src: await page.locator("#msgList img").first().evaluate((img: HTMLImageElement) => img.currentSrc) };
    expect(before.scrollTop).toBeGreaterThan(0);
    await page.locator("#msgList img").first().click();
    await page.locator("#imageDialog[open]").waitFor();
    const opened = await page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>("#imageDialogImage")!;
      return { src: image.currentSrc, scrollTop: document.querySelector<HTMLElement>("#thread")!.scrollTop, closeLabel: document.querySelector("#btnCloseImage")!.getAttribute("aria-label"), focus: document.activeElement?.id };
    });
    // The overlay reuses the URL the list already fetched instead of loading it twice.
    expect(opened.src).toBe(before.src);
    expect(opened.scrollTop).toBe(before.scrollTop);
    expect(opened.closeLabel).toBe("Close");
    expect(opened.focus).toBe("btnCloseImage");
    const zoomLevel = () => page.locator("#zoomLevel").textContent();
    const fit = "51%";
    expect(await zoomLevel()).toBe(fit);
    await page.locator("#imageDialogImage").hover();
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
    expect(Number((await zoomLevel())!.replace("%", ""))).toBeGreaterThan(51);
    expect(await scrollTop()).toBe(before.scrollTop);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btnCloseImage");
    for (let index = 0; index < 12; index++) await page.mouse.wheel(0, -500);
    expect(await zoomLevel()).toBe("400%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight && scrollY === 0)).toBe(true);
    const imageBox = () => page.locator("#imageDialogImage").evaluate((element: HTMLImageElement) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
    for (let index = 0; index < 40; index++) await page.keyboard.press("Shift+ArrowLeft");
    const leftBox = await imageBox();
    expect(Math.abs(leftBox.left - 20)).toBeLessThanOrEqual(2);
    for (let index = 0; index < 80; index++) await page.keyboard.press("Shift+ArrowRight");
    const rightBox = await imageBox();
    expect(Math.abs(rightBox.right - 1260)).toBeLessThanOrEqual(2);
    await page.locator("#btnZoomReset").click();
    expect(await zoomLevel()).toBe(fit);
    await page.keyboard.press("+");
    expect(Number((await zoomLevel())!.replace("%", ""))).toBeGreaterThan(51);
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
    const closed = await page.evaluate(() => ({ scrollTop: document.querySelector<HTMLElement>("#thread")!.scrollTop, focusTag: document.activeElement?.tagName }));
    expect(closed.scrollTop).toBe(before.scrollTop);
    expect(closed.focusTag).toBe("IMG");
    await page.locator("#msgList img").first().click();
    await page.locator("#imageDialog[open]").waitFor();
    expect(await page.locator("#zoomLevel").textContent()).toBe(fit);
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
    // A small image is never upscaled: its natural pixels are already 100%.
    const small = page.locator("#msgList img").last();
    await small.scrollIntoViewIfNeeded();
    await small.click();
    await page.locator("#imageDialog[open]").waitFor();
    expect(await page.locator("#zoomLevel").textContent()).toBe("100%");
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!browserModule)("a non-owner still finds the settings entry and learns who owns the room", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-owner-note-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_NoteOwner");
    await page.locator("#inRoomName").fill("__Test_NoteRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    const peerContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const peer = await peerContext.newPage();
    peer.setDefaultTimeout(15000);
    await peer.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await peer.goto(`${origin}/chat`);
    await peer.evaluate(async ({ url, id }: any) => { const { app } = await import(url); await app.joinRoom(id, "__Test_NotePeer"); }, { url: "/assets/chat/state.js", id: roomId });
    await peer.locator("#chatView").waitFor({ state: "visible" });
    await peer.locator("#btnRoomOptions").click();
    expect(await peer.locator("#btnEditRoom").isVisible()).toBe(true);
    expect(await peer.locator("#btnEditRoom").evaluate((node: HTMLElement) => node.classList.contains("menu-secondary"))).toBe(true);
    expect(await peer.locator("#btnDeleteRoom").isHidden()).toBe(true);
    await peer.locator("#btnEditRoom").click();
    await peer.locator("#ownerOnlyDialog[open]").waitFor();
    expect(await peer.locator("#ownerOnlyNote").textContent()).toContain("__Test_NoteOwner");
    await peer.locator("#btnCloseOwnerOnly").click();
    await peer.locator("#ownerOnlyDialog").waitFor({ state: "hidden" });
    await peerContext.close();
    await context.close();
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!browserModule)("the owner hands the room to a person and never to an agent", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-owner-transfer-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_TransferOwner");
    await page.locator("#inRoomName").fill("__Test_TransferRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: "__Test_TransferPeer", participantId: "__Test_TransferPeer", participantName: "__Test_TransferPeer" });
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: randomUUID(), participantId: "__Test_TransferAgent", participantName: "__Test_TransferAgent", protocol: "v2", receiverOwnerID: randomUUID() });
    await page.locator("#btnRoomOptions").click();
    expect(await page.locator("#btnDeleteRoom").isVisible()).toBe(true);
    await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    await page.locator("#editRoomTabOwnership").click();
    await page.waitForFunction(() => Array.from((document.querySelector("#editRoomOwner") as HTMLSelectElement).options).some((option) => option.value === "__Test_TransferPeer"), undefined, { timeout: 15000 });
    const options = await page.locator("#editRoomOwner option").evaluateAll((nodes: HTMLOptionElement[]) => nodes.map((node) => node.value));
    expect(options).toContain("__Test_TransferPeer");
    // The agent is in the room, but a room can only belong to a person.
    expect(options).not.toContain("__Test_TransferAgent");
    expect(options).toContain("__Test_TransferOwner");
    await page.locator("#editRoomOwner").selectOption("__Test_TransferPeer");
    await page.locator("#editRoomForm button[type=submit]").click();
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    const afterTransfer = await page.evaluate(async ({ url, id }: any) => {
      const { app } = await import(url);
      return { owner: app.state.room.ownerId, stored: app.state.rooms.get(id)?.room.ownerId, deleteHidden: (document.querySelector<HTMLElement>("#btnDeleteRoom")!).hidden };
    }, { url: "/assets/chat/state.js", id: roomId });
    expect(afterTransfer.owner).toBe("__Test_TransferPeer");
    expect(afterTransfer.stored).toBe("__Test_TransferPeer");
    expect(afterTransfer.deleteHidden).toBe(true);
    const payload = await (await fetch(`${origin}/rooms/${roomId}`, { headers: { Authorization: `Bearer ${token}` } })).json() as { ownerId: string };
    expect(payload.ownerId).toBe("__Test_TransferPeer");
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("the rail footer stays compact and bottom anchored as the composer grows", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-divider-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_DividerOwner");
    await page.locator("#inRoomName").fill("__Test_DividerRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const layout = async () => {
      await page.waitForTimeout(120);
      return page.evaluate(() => {
        const box = (selector: string) => { const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect(); return { top: Math.round(rect.top * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10, height: Math.round(rect.height * 10) / 10 }; };
        return { composer: box("#chatView > .composer"), foot: box("#roomRail .rail-foot"), trigger: box("#btnSettings"), rail: box("#roomRail") };
      });
    };
    const sameFooter = (a: any, b: any) => Math.abs(a.foot.top - b.foot.top) <= 1 && Math.abs(a.foot.height - b.foot.height) <= 1
      && Math.abs(a.trigger.top - b.trigger.top) <= 1 && Math.abs(a.trigger.height - b.trigger.height) <= 1;
    const lines = "Line one\nLine two\nLine three\nLine four\nLine five";
    const idle = await layout();
    expect(Math.abs(idle.foot.top - idle.composer.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(idle.foot.bottom - idle.rail.bottom)).toBeLessThanOrEqual(1);
    await page.locator("#msgInput").fill(lines);
    const expanded = await layout();
    expect(sameFooter(expanded, idle)).toBe(true);
    expect(expanded.composer.height).toBeGreaterThan(idle.composer.height + 40);
    // Staged files grow the composer too; the footer and identity row must not move.
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_divider.txt", mimeType: "text/plain", buffer: Buffer.from("Rail footer stays compact.") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    const attached = await layout();
    expect(sameFooter(attached, idle)).toBe(true);
    // Emptying the composer restores idle alignment, including after a viewport change.
    await page.locator('#attachmentList [data-upload-action="remove"]').click();
    await page.waitForFunction(() => !document.querySelectorAll("#attachmentList .attachment-item").length);
    await page.locator("#msgInput").fill("");
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#roomRail.drawer-open").waitFor();
    const mobile = await layout();
    expect(Math.abs(mobile.foot.top - mobile.composer.top)).toBeLessThanOrEqual(1);
    await page.locator("#msgInput").fill(lines);
    const mobileExpanded = await layout();
    expect(sameFooter(mobileExpanded, mobile)).toBe(true);
    expect(Math.abs(mobileExpanded.foot.bottom - mobileExpanded.rail.bottom)).toBeLessThanOrEqual(1);
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_mobile_divider.txt", mimeType: "text/plain", buffer: Buffer.from("Mobile rail footer stays compact.") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    const mobileAttached = await layout();
    expect(sameFooter(mobileAttached, mobile)).toBe(true);
    expect(Math.abs(mobileAttached.foot.bottom - mobileAttached.rail.bottom)).toBeLessThanOrEqual(1);
    // A restored draft must not become the idle height on the next visit.
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#roomRail.drawer-open").waitFor();
    const restored = await layout();
    expect(restored.foot.height).toBeLessThanOrEqual(mobile.foot.height + 1);
    expect(restored.foot.height).toBeLessThan(restored.composer.height);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}
