/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-page-keys-test-token";

test.skipIf(!browserModule)("PageUp and PageDown scroll the thread while the composer is focused", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-page-keys-"));
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
    await page.locator("#inName").fill("__Test_PageOwner");
    await page.locator("#inRoomName").fill("__Test_PageKeys");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    for (let index = 0; index < 24; index++) {
      await api(origin, `/rooms/${room.id}/messages`, "POST", {
        sessionID: room.sessionID,
        text: `__Test_page ${index}\n${"Filler line for height.\n".repeat(4)}`,
      });
    }
    await page.locator("#msgList").getByText("__Test_page 23").waitFor();
    await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.scrollHeight;
    });
    await page.locator("#msgInput").fill("__Test_draft");
    await page.locator("#msgInput").focus();

    const read = () => page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      const input = document.querySelector<HTMLElement>("#msgInput")!;
      return {
        top: thread.scrollTop,
        gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
        value: (input as any).value,
        focused: document.activeElement === input,
        pageTop: document.scrollingElement?.scrollTop ?? 0,
      };
    });
    const before = await read();
    expect(before.gap).toBeLessThan(8);
    await page.keyboard.press("PageUp");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop < top - 100, before.top);
    const afterUp = await read();
    expect(afterUp.top).toBeLessThan(before.top - 100);
    expect(afterUp.value).toBe("__Test_draft");
    expect(afterUp.focused).toBe(true);
    expect(afterUp.pageTop).toBe(0);

    await page.keyboard.press("PageDown");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop > top + 100, afterUp.top);
    const afterDown = await read();
    expect(afterDown.top).toBeGreaterThan(afterUp.top + 100);
    expect(afterDown.value).toBe("__Test_draft");
    expect(afterDown.focused).toBe(true);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}
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