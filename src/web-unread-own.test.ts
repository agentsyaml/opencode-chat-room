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
    const peerState = await page.evaluate(async ({ url, id }: { url: string; id: string }) => { const { app } = await import(url); return { unread: app.state.rooms.get(app.state.room.id)?.unreadIds.size, inUnread: app.state.rooms.get(app.state.room.id)?.unreadIds.has(id) || false }; }, { url: "/assets/chat/state.js", id: peerID });
    expect(peerState.inUnread).toBe(true); expect(peerState.unread).toBe(1);
    expect(peerMessage.messages.at(-1).text).toBe("__Test_peer_history");
    await page.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
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