/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-reconnect-test-token";

test.skipIf(!browserModule)("network recovery clears the connection bar and stale send warning", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-reconnect-"));
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
    await page.locator("#inName").fill("__Test_Reconnect");
    await page.locator("#inRoomName").fill("__Test_ReconnectRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    let blocked = true;
    await page.route("**/inbox?*", (route: any) => blocked
      ? route.abort("failed")
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ member: true, items: [], hasMore: false }) }));
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.startPolling();
    }, "/assets/chat/state.js");
    await page.locator("#connBar").waitFor({ state: "visible" });
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.showSendError("sendNetwork");
    }, "/assets/chat/state.js");
    await page.locator("#sendError").waitFor({ state: "visible" });

    blocked = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.locator("#connBar").waitFor({ state: "hidden" });
    await page.locator("#sendError").waitFor({ state: "hidden" });

    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.setOnline(false);
      app.showSendError("sendFailed", { message: "runtime failure" });
      app.setOnline(true);
    }, "/assets/chat/state.js");
    expect(await page.locator("#sendError").isVisible()).toBe(true);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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