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
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#22695c"/></svg>');

test.skipIf(!browserModule)("clicking a message image opens the overlay and Esc closes it without moving the thread", async () => {
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
    await page.locator("#msgList img").waitFor();
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>("#msgList img"); return Boolean(img?.complete && img.naturalWidth); });
    const scrollTop = () => page.evaluate(() => document.querySelector<HTMLElement>("#thread")!.scrollTop);
    // One click anywhere in the thread can make the app re-anchor its read receipts;
    // take that first hit, then measure whether the overlay itself moves anything.
    await page.locator("#msgList img").click();
    await page.locator("#imageDialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(400);
    const before = { scrollTop: await scrollTop(), src: await page.locator("#msgList img").evaluate((img: HTMLImageElement) => img.currentSrc) };
    expect(before.scrollTop).toBeGreaterThan(0);
    await page.locator("#msgList img").click();
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
    await page.keyboard.press("Escape");
    await page.locator("#imageDialog").waitFor({ state: "hidden" });
    const closed = await page.evaluate(() => ({ scrollTop: document.querySelector<HTMLElement>("#thread")!.scrollTop, focusTag: document.activeElement?.tagName }));
    expect(closed.scrollTop).toBe(before.scrollTop);
    expect(closed.focusTag).toBe("IMG");
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

test.skipIf(!browserModule)("the rail footer divider and the composer divider share one height", async () => {
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
    const gap = async () => {
      await page.waitForTimeout(120);
      return page.evaluate(() => {
        const foot = document.querySelector<HTMLElement>("#roomRail .rail-foot")!, composer = document.querySelector<HTMLElement>("#chatView > .composer")!;
        return Math.round((foot.getBoundingClientRect().top - composer.getBoundingClientRect().top) * 10) / 10;
      });
    };
    expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
    await page.locator("#msgInput").fill("Line one\nLine two\nLine three\nLine four\nLine five");
    expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
    await page.locator("#msgInput").fill("");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#roomRail.drawer-open").waitFor();
    expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
    await page.locator("#msgInput").fill("Line one\nLine two\nLine three\nLine four\nLine five");
    expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
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
