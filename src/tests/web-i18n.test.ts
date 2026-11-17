import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-i18n-local-token";

test.skipIf(!browserModule)("system events translate in messages and room previews only", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-i18n-"));
  const artifactDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifactDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Host");
    await page.locator("#inRoomName").fill("System event translations");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    const ownerID = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");
    const preview = page.locator(`#roomListChat [data-room-id="${roomId}"] .r-preview`);
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: "i18n-peer", participantId: "Peer", participantName: "Peer" });
    await page.locator("#msgList").getByText("Peer joined the room").waitFor();
    await setLocale(page, "zh-CN");
    const joinPreviewZh = await expectText(page, "Peer 加入了房间", roomId);
    await api(origin, `/rooms/${roomId}/leave`, "POST", { sessionID: "i18n-peer" });
    const leavePreviewZh = await expectText(page, "Peer 离开了房间", roomId);

    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: "i18n-alex", participantId: "Alex", participantName: "Alex" });
    await page.locator("#msgList").getByText("Alex 加入了房间").waitFor();
    await api(origin, `/rooms/${roomId}/kick`, "POST", { sessionID: ownerID, targetSessionID: "i18n-alex" });
    const removedPreviewZh = await expectText(page, "Alex 被移出了房间", roomId);
    await page.screenshot({ path: path.join(artifactDir, "chat-system-removed-zh.png"), fullPage: true });
    await setLocale(page, "en");
    const removedPreviewEn = await expectText(page, "Alex was removed from the room", roomId);
    await page.screenshot({ path: path.join(artifactDir, "chat-system-removed-en.png"), fullPage: true });
    await page.locator("#msgList").getByText("Peer joined the room").waitFor();
    await page.locator("#msgList").getByText("Peer left the room").waitFor();

    await setLocale(page, "zh-CN");
    await page.locator("#msgInput").fill("Alex was removed from the room");
    await page.locator("#btnSend").click();
    const literal = page.locator("#msgList .msg.own .msg-text").filter({ hasText: "Alex was removed from the room" }).last();
    await literal.waitFor();
    expect((await literal.textContent())?.trimEnd()).toBe("Alex was removed from the room");
    expect(await preview.textContent()).toBe("Alex was removed from the room");
    await page.screenshot({ path: path.join(artifactDir, "chat-system-events-zh.png"), fullPage: true });
    await writeFile(path.join(artifactDir, "chat-system-events-metrics.json"), JSON.stringify({ joinPreviewZh, leavePreviewZh, removedPreviewZh, removedPreviewEn, userLiteralUntranslated: await literal.textContent(), previewUntranslated: await preview.textContent() }, null, 2));
    await page.context().close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function expectText(page: any, text: string, roomId: string) {
  await page.locator("#msgList").getByText(text).last().waitFor({ timeout: 10000 });
  await page.waitForFunction(({ id, expected }: { id: string; expected: string }) =>
    document.querySelector(`#roomListChat [data-room-id="${id}"] .r-preview`)?.textContent === expected, { id: roomId, expected: text });
  return await page.locator(`#roomListChat [data-room-id="${roomId}"] .r-preview`).textContent();
}

async function setLocale(page: any, locale: string) {
  await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
  await page.locator("#localeSelectSettings").selectOption(locale); await page.keyboard.press("Escape");
  await page.locator("#chatSettings").waitFor({ state: "hidden" });
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
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Wait for the local server. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}
