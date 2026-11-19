/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-send-echo-test-token";

test.skipIf(!browserModule)("a sent message appears before the server responds", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-send-echo-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
    page.setDefaultTimeout(15000);
    const receiptRequests: string[] = [];
    page.on("request", (request: any) => { if (request.url().includes("/receipts")) receiptRequests.push(request.url()); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_EchoOwner");
    await page.locator("#inRoomName").fill("__Test_Echo");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id };
    }, "/assets/chat/state.js");

    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false, failNext = false;
    await page.route(`**/rooms/${room.id}/messages`, async (route: any) => {
      if (route.request().method() !== "POST") return route.continue();
      if (failNext) return route.abort();
      intercepted = true;
      await responseGate;
      await route.continue();
    });

    await page.locator("#msgInput").fill("__Test_echo");
    await page.keyboard.press("Enter");
    const row = page.locator("#msgList .msg").filter({ hasText: "__Test_echo" });
    await row.waitFor({ state: "visible", timeout: 1000 });
    expect(await row.evaluate((node: Element) => node.classList.contains("pending"))).toBe(true);
    expect(await page.locator("#msgInput").evaluate((node: HTMLElement & { value: string }) => node.value)).toBe("");
    await page.waitForTimeout(400);
    expect(receiptRequests.some((url) => url.includes("pending-"))).toBe(false);
    release();
    await page.waitForFunction(() => !document.querySelector("#msgList .msg.pending"));
    expect(intercepted).toBe(true);
    expect(await page.locator("#msgList .msg").filter({ hasText: "__Test_echo" }).count()).toBe(1);

    failNext = true;
    await page.locator("#msgInput").fill("__Test_echo_fail");
    await page.keyboard.press("Enter");
    await page.locator(".failed-message").filter({ hasText: "__Test_echo_fail" }).waitFor();
    expect(await page.locator("#msgList .msg").filter({ hasText: "__Test_echo_fail" }).count()).toBe(0);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}