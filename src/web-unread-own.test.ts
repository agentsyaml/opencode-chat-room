/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE, token = "chat-unread-own-test-token";

test.skipIf(!browserModule)("own poll messages never become unread while peer messages do", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-unread-own-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`); await page.locator("#inName").fill("__Test_UnreadOwner");
    await page.locator("#inRoomName").fill("__Test_UnreadOwn"); await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const ids = await page.evaluate(async (url: string) => { const { app } = await import(url); return { roomId: app.state.room.id, sessionID: app.LS.sessionID }; }, "/assets/chat/state.js");
    await api(origin, `/rooms/${ids.roomId}/join`, "POST", { sessionID: "__Test_UnreadPeer", participantId: "__Test_UnreadPeer", participantName: "__Test_UnreadPeer" });
    for (let index = 0; index < 24; index++) await api(origin, `/rooms/${ids.roomId}/messages`, "POST", { sessionID: ids.sessionID, text: `__Test_own_history_${index}\n${"line\n".repeat(2)}` });
    const peerMessage = await api(origin, `/rooms/${ids.roomId}/messages`, "POST", { sessionID: "__Test_UnreadPeer", text: "__Test_peer_history" });
    await page.reload(); await page.locator("#msgList .msg").nth(20).waitFor();
    await page.evaluate(async (url: string) => { const { app } = await import(url); await app.markActiveRoomRead(); }, "/assets/chat/state.js");
    await page.waitForFunction(async (url: string) => { const { app } = await import(url); return (app.state.rooms.get(app.state.room.id)?.readTs || 0) > 0; }, "/assets/chat/state.js");
    await page.locator("#thread").evaluate((thread: HTMLElement) => { thread.scrollTop = 0; });
    await page.waitForTimeout(100);
    const own = await api(origin, `/rooms/${ids.roomId}/messages`, "POST", { sessionID: ids.sessionID, text: "__Test_own_new" });
    const ownID = own.messages.at(-1).id;
    await page.waitForFunction((id: string) => Boolean(document.querySelector(`[data-msg-id="${id}"]`)), ownID);
    const ownState = await page.evaluate(async ({ url, id }: { url: string; id: string }) => { const { app } = await import(url); return { unread: app.state.unread, inUnread: app.state.rooms.get(app.state.room.id)?.unreadIds.has(id) || false }; }, { url: "/assets/chat/state.js", id: ownID });
    expect(ownState).toEqual({ unread: 0, inUnread: false });
    const peer = await api(origin, `/rooms/${ids.roomId}/messages`, "POST", { sessionID: "__Test_UnreadPeer", text: "__Test_peer_new" });
    const peerID = peer.messages.at(-1).id;
    await page.waitForFunction((id: string) => Boolean(document.querySelector(`[data-msg-id="${id}"]`)), peerID);
    const peerState = await page.evaluate(async ({ url, id }: { url: string; id: string }) => { const { app } = await import(url), entry = app.state.rooms.get(app.state.room.id); return { unread: entry?.unreadIds.size, inUnread: entry?.unreadIds.has(id) || false, readTs: entry?.readTs || 0 }; }, { url: "/assets/chat/state.js", id: peerID });
    expect(peerState.inUnread).toBe(true); expect(peerState.unread).toBe(1);
    expect(peerState.readTs).toBeLessThan(peer.messages.at(-1).createdAt);
    await page.locator("#btnJump").waitFor({ state: "visible" });
    const thread = await page.locator("#thread").boundingBox();
    await page.mouse.move(thread!.x + thread!.width / 2, thread!.y + thread!.height / 2);
    for (let index = 0; index < 10; index++) await page.mouse.wheel(0, 1000);
    await page.waitForFunction(() => { const thread = document.querySelector<HTMLElement>("#thread")!; return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; });
    await page.waitForFunction(async ({ url, roomId, timestamp, previous }: { url: string; roomId: string; timestamp: number; previous: number }) => {
      const { app } = await import(url), readTs = app.state.rooms.get(roomId)?.readTs || 0;
      return readTs > previous && readTs >= timestamp;
    }, { url: "/assets/chat/state.js", roomId: ids.roomId, timestamp: peer.messages.at(-1).createdAt, previous: peerState.readTs });
    expect(await page.locator("#btnJump").isHidden()).toBe(true);
    expect(await page.locator("#jumpBadge").isHidden()).toBe(true);
    expect(peerMessage.messages.at(-1).text).toBe("__Test_peer_history");
    await page.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(!browserModule)("inactive room watcher excludes own messages but keeps peer messages unread", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-unread-inactive-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`, sessionID = "77777777-7777-4777-8777-777777777777";
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const inactive = await api(origin, "/rooms", "POST", { name: "__Test_Inactive", ownerId: "__Test_RoomOwner", sessionID: "__Test_RoomOwner" });
    const active = await api(origin, "/rooms", "POST", { name: "__Test_Active", ownerId: "__Test_RoomOwner", sessionID: "__Test_RoomOwner" });
    for (const room of [inactive, active]) await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID, participantId: "__Test_Owner", participantName: "__Test_Owner" });
    await api(origin, `/rooms/${inactive.id}/join`, "POST", { sessionID: "__Test_InactivePeer", participantId: "__Test_InactivePeer", participantName: "__Test_InactivePeer" });
    const page = await browser.newPage();
    await page.addInitScript(({ token, sessionID, inactiveID, activeID }: any) => {
      localStorage.setItem("chat.token", token); sessionStorage.setItem("chat.sessionID", sessionID);
      sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([inactiveID, activeID]));
      sessionStorage.setItem("chat.roomNames", JSON.stringify({ [inactiveID]: "__Test_Inactive", [activeID]: "__Test_Active" }));
      sessionStorage.setItem("chat.roomId", activeID); sessionStorage.setItem("chat.name", "__Test_Owner");
    }, { token, sessionID, inactiveID: inactive.id, activeID: active.id });
    await page.goto(`${origin}/chat`); await page.locator("#chatView").waitFor({ state: "visible" });
    const own = await api(origin, `/rooms/${inactive.id}/messages`, "POST", { sessionID, text: "__Test_inactive_own" });
    const ownID = own.messages.at(-1).id;
    await page.waitForTimeout(5500);
    const ownUnread = await page.evaluate(async ({ url, roomId, ownID }: any) => {
      const { app } = await import(url), entry = app.state.rooms.get(roomId);
      return { unread: entry.unreadIds.has(ownID), received: entry.room.messages.some((message: any) => message.id === ownID) };
    }, { url: "/assets/chat/state.js", roomId: inactive.id, ownID });
    expect(ownUnread).toEqual({ unread: false, received: true });
    const peer = await api(origin, `/rooms/${inactive.id}/messages`, "POST", { sessionID: "__Test_InactivePeer", text: "__Test_inactive_peer" });
    const peerID = peer.messages.at(-1).id;
    await page.waitForTimeout(5500);
    const unread = await page.evaluate(async ({ url, roomId, ownID, peerID }: any) => {
      const { app } = await import(url), entry = app.state.rooms.get(roomId);
      return { own: entry.unreadIds.has(ownID), peer: entry.unreadIds.has(peerID), count: entry.unreadIds.size };
    }, { url: "/assets/chat/state.js", roomId: inactive.id, ownID, peerID });
    expect(unread).toEqual({ own: false, peer: true, count: 1 });
    await page.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve)); server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
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
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local chat server did not start");
}
