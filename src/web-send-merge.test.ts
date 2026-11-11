/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-send-merge-test-token";

test.skipIf(!browserModule)("a delayed send response keeps messages polling already received", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-send-merge-"));
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
    await page.locator("#inName").fill("__Test_SendOwner");
    await page.locator("#inRoomName").fill("__Test_SendMerge");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "__Test_SendPeer", participantId: "__Test_SendPeer", participantName: "__Test_SendPeer" });

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted!: () => void;
    const sendHeld = new Promise<void>((resolve) => { sendStarted = resolve; });
    await page.route("**/rooms/*/messages", async (route: any) => {
      if (route.request().method() !== "POST") return route.continue();
      sendStarted();
      await sendGate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });

    await page.locator("#msgInput").fill("__Test_delayed_send");
    await page.locator("#btnSend").click();
    await sendHeld;
    await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "__Test_SendPeer", text: "__Test_polled_while_held" });
    await page.locator("#msgList").getByText("__Test_polled_while_held").waitFor();
    releaseSend();
    await page.locator("#msgList").getByText("__Test_delayed_send").waitFor();
    await page.waitForTimeout(700);
    expect(await page.locator("#msgList").getByText("__Test_polled_while_held").count()).toBe(1);
    expect(await page.locator("#msgList").getByText("__Test_delayed_send").count()).toBe(1);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
